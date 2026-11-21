'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { sha256Buffer } = require('./j7-digest.cjs');

const FILE = 'j7-retryable.mjs';
const PIN = '92075be7f37dccf9c145bd8d008a3882f6e091b940344bb18a30044d32a515f6';
const JSON_MAX = 1024 * 1024;
const ZIP_MAX = 2 * JSON_MAX;
const HEX64 = /^(?!0+$)[0-9a-fA-F]{64}$/;
const ZIP_MEMBERS = `
from pathlib import Path
import stat
import sys
from zipfile import ZipFile, ZIP_STORED, ZIP_DEFLATED

with ZipFile(Path(sys.argv[1])) as archive:
    names = sys.argv[2:]
    entries = archive.infolist()
    if len(entries) != len(names) or {entry.filename for entry in entries} != set(names):
        sys.exit(1)
    for name in names:
        entry = archive.getinfo(name)
        if (entry.orig_filename != name or entry.is_dir()
                or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG)
                or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED) or entry.flag_bits & 1
                or not 0 < entry.file_size <= 1048576):
            sys.exit(1)
        payload = archive.read(entry)
        if len(payload) != entry.file_size:
            sys.exit(1)
        sys.stdout.buffer.write(len(payload).to_bytes(4, 'big') + payload)
`;

class RetryableAdmissionError extends Error {}

function check(condition, code) {
  if (!condition) throw new RetryableAdmissionError(code);
}

function read(file, limit, code) {
  try {
    const stat = fs.lstatSync(file);
    check(stat.isFile() && stat.size > 0 && stat.size <= limit, code);
    const data = fs.readFileSync(file);
    check(data.length === stat.size, code);
    return data;
  } catch {
    throw new RetryableAdmissionError(code);
  }
}

function object(data, keys, code) {
  let value;
  try { value = JSON.parse(data); } catch { throw new RetryableAdmissionError(code); }
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), keys.split(' ').sort()), code);
  return value;
}

function digest(data) {
  return sha256Buffer(data).toLowerCase();
}

function matchesDigest(value, data) {
  return typeof value === 'string' && HEX64.test(value) && value.toLowerCase() === digest(data);
}

const retryableEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS$|NODE_PATH$|PYTHON|GIT_)/i.test(key)));

function pinnedTool(repo, commit, work, env) {
  const code = 'E_J7_RETRYABLE_PIN';
  const local = read(path.join(__dirname, FILE), 64 * 1024, code);
  const tracked = spawnSync('git', ['--no-replace-objects', '-C', repo, 'cat-file', 'blob', `${commit}:tests/evidence/${FILE}`],
    { env, timeout: 20_000, maxBuffer: 64 * 1024 });
  check(digest(local) === PIN && tracked.status === 0 && tracked.stdout.equals(local), code);
  const executable = path.join(work, FILE);
  fs.writeFileSync(executable, local, { flag: 'wx', mode: 0o600 });
  return executable;
}

function extractArchive(raw, expectedSha, zip, names, code) {
  check(matchesDigest(expectedSha, raw), `${code}_ZIP_DIGEST`);
  fs.writeFileSync(zip, raw, { flag: 'wx', mode: 0o600 });
  const unzip = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', '-c', ZIP_MEMBERS, zip, ...names],
    { env: retryableEnv(), timeout: 20_000, maxBuffer: (JSON_MAX + 4) * names.length });
  const memberCode = `${code}_ZIP_MEMBER`;
  check(unzip.status === 0 && !unzip.stderr?.length, memberCode);
  let offset = 0;
  const members = [];
  for (const name of names) {
    check(offset + 4 <= unzip.stdout.length, memberCode);
    const length = unzip.stdout.readUInt32BE(offset);
    offset += 4;
    check(length > 0 && length <= JSON_MAX && offset + length <= unzip.stdout.length, memberCode);
    members.push([name, unzip.stdout.subarray(offset, offset + length)]);
    offset += length;
  }
  check(offset === unzip.stdout.length, memberCode);
  return Object.fromEntries(members);
}

function runAdmit({ repo, subject, expect, probe, member, memberSha256, work }) {
  const env = retryableEnv();
  const executable = pinnedTool(repo, subject.checkout.sha, work, env);
  const args = [];
  for (const [flag, data] of Object.entries({ expect, probe, retryable: member })) {
    const target = path.join(work, `${flag}.json`);
    fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
    args.push(`--${flag}`, target);
  }
  const result = path.join(work, 'admitted.json');
  const reply = spawnSync(process.execPath, [executable, 'admit', ...args, '--retryable-sha256', memberSha256, '--out', result],
    { env, encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 });
  const diagnostic = reply.stderr?.trim();
  if (reply.status !== 0) check(false, /^J7_RETRYABLE_[A-Z0-9_]+$/.test(diagnostic ?? '') ? diagnostic : 'E_J7_RETRYABLE_ADMITTER');
  check(reply.stdout.trim() === 'J7_RETRYABLE_ADMISSION_OK' && diagnostic === '', 'E_J7_RETRYABLE_ADMITTER');
  const data = read(result, JSON_MAX, 'E_J7_RETRYABLE_ADMITTER');
  const verified = object(data, 'schema retryableSha256 probeSha256 attempts beforeGeneration afterGeneration sameKey', 'E_J7_RETRYABLE_ADMITTER');
  check(verified.schema === 'j7-retryable-admission/1' && matchesDigest(verified.retryableSha256, member) &&
    matchesDigest(verified.probeSha256, probe), 'E_J7_RETRYABLE_ADMITTER');
  return { data: member, admitted: verified, admissionSha256: digest(data) };
}

function admitRetryableFixture(directory, repo, subject, work) {
  const anchorCode = 'E_J7_RETRYABLE_FIXTURE_ANCHOR';
  const uploadCode = 'E_J7_RETRYABLE_FIXTURE_UPLOAD';
  const expected = read(path.join(directory, 'runner-expect.fixture.json'), 16 * 1024, anchorCode);
  const want = object(expected, 'schema run source build pg app probeSha256 expectedFailedGeneration', anchorCode);
  const assignment = { workflow: subject.run.workflow, job: 'e2e', id: subject.run.id, attempt: subject.run.attempt };
  check(want.schema === 'j7-retryable-expect/1' && isDeepStrictEqual(want.run, assignment) &&
    isDeepStrictEqual(want.source, { commit: subject.checkout.sha, tree: subject.checkout.tree }) &&
    want.build?.buildId === subject.e2eBuildId &&
    !Object.values(subject.build.record.builds).some((row) => row.serverJs.sha256 === want.build.serverJsSha256?.toLowerCase()),
    'E_J7_RETRYABLE_EXPECTED_SUBJECT');
  const upload = object(read(path.join(directory, 'upload.fixture.json'), 16 * 1024, uploadCode),
    'schema artifactId artifactName run memberSha256 zipSha256', uploadCode);
  check(upload.schema === 'j7-retryable-fixture-upload/1' && isDeepStrictEqual(upload.run, assignment) &&
    Number.isSafeInteger(upload.artifactId) && upload.artifactId > 0 &&
    upload.artifactName === `j7-retryable-${assignment.id}-${assignment.attempt}`, uploadCode);
  const data = read(path.join(directory, 'retryable.zip'), ZIP_MAX, 'E_J7_RETRYABLE_ZIP_INPUT');
  const probe = read(path.join(directory, 'full-report.json'), JSON_MAX, 'E_J7_RETRYABLE_PROBE_INPUT');
  const name = 'J7-RETRYABLE.json';
  const member = extractArchive(data, upload.zipSha256, path.join(work, 'retryable.zip'), [name], 'E_J7_RETRYABLE')[name];
  check(matchesDigest(upload.memberSha256, member), 'E_J7_RETRYABLE_MEMBER_DIGEST');
  return { ...runAdmit({ repo, subject, expect: expected, probe, member, memberSha256: upload.memberSha256, work }),
    artifactId: upload.artifactId, artifactName: upload.artifactName, zipSha256: digest(data), fixture: true };
}

module.exports = { RetryableAdmissionError, admitRetryableFixture, extractArchive, runAdmit };
