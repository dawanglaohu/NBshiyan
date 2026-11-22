'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { sha256Buffer } = require('./j7-digest.cjs');
const { RetryableAdmissionError, admitRetryableFixture } = require('./j7-retryable-admission.cjs');

const CLI = 'j7-admit-sources.py';
const CLI_SHA256 = '39d14219c48eebc740a90cf8f05a6cf45677724bed42ff44ae740b95538b7451';
const SOURCE_FLAGS = new Map([
  ['--sources-only', 'only'],
  ['--retryable-fixture-input', 'retryableFixture'],
  ['--runner-binding-fixture-input', 'runnerBindingFixture'],
  ['--runner-binding-trusted-expect', 'runnerTrustedExpect'],
  ['--expect-e2e-job-id', 'e2eJobId'],
  ['--source-root', 'root'],
  ['--expect-build-job-id', 'buildJobId'],
  ['--expect-sha', 'sha'],
  ['--expect-tree', 'tree'],
  ['--expect-run', 'run'],
  ['--expect-attempt', 'attempt'],
  ['--expect-workflow', 'workflow'],
  ['--expect-build-id', 'buildId'],
]);
const MISSING_FORMAL_SOURCES = Object.freeze(['j6-network', 'retryable', 'runner-observations']);

class SourceAdmissionError extends Error {}

function expect(condition, code) {
  if (!condition) throw new SourceAdmissionError(code);
}

function sourceOption(input, flag, next) {
  const field = SOURCE_FLAGS.get(flag);
  if (!field) return false;
  expect(!Object.hasOwn(input, field), 'E_J7_SOURCE_ARGS');
  input[field] = field === 'only' ? true : next();
  return true;
}

function readRegular(file, limit, code) {
  const stat = fs.lstatSync(file);
  expect(stat.isFile() && stat.size > 0 && stat.size <= limit, code);
  const content = fs.readFileSync(file);
  expect(content.length === stat.size, code);
  return content;
}

function sameFile(file, expected) {
  try {
    return readRegular(file, expected.length, 'E_J7_SOURCE_FILE_DIFF').equals(expected);
  } catch {
    return false;
  }
}

function readOutput(root, name) {
  const data = fs.readFileSync(path.join(root, name));
  return { data, value: JSON.parse(data), sha256: sha256Buffer(data).toUpperCase() };
}

function argShape(options, repo) {
  expect(!options.retryableFixture || options.only === true, 'E_J7_RETRYABLE_FIXTURE_SCOPE');
  const hasTrustedRunnerExpect = Object.hasOwn(options, 'runnerTrustedExpect');
  expect(!(options.runnerBindingFixture || hasTrustedRunnerExpect) || options.only === true, 'E_J7_RUNNER_FIXTURE_SCOPE');
  expect(!hasTrustedRunnerExpect || Boolean(options.runnerBindingFixture && options.runnerTrustedExpect), 'E_J7_RUNNER_FIXTURE_ARGS');
  if (!options.root) throw new SourceAdmissionError('E_J7_SOURCE_ROOT_REQUIRED');
  const id = /^[1-9][0-9]{0,15}$/;
  const positiveSafeId = (value) => id.test(value) && Number.isSafeInteger(Number(value));
  expect(options.runnerBindingFixture ? !options.retryableFixture && positiveSafeId(options.e2eJobId) &&
    options.e2eJobId !== options.buildJobId : options.e2eJobId === undefined, 'E_J7_RUNNER_FIXTURE_ARGS');
  const oid = /^[0-9a-f]{40}$/;
  expect(repo && oid.test(options.sha) && oid.test(options.tree) && positiveSafeId(options.run) &&
    positiveSafeId(options.attempt) && positiveSafeId(options.buildJobId) && options.workflow === 'CI' &&
    /^[A-Za-z0-9_-]{8,64}$/.test(options.buildId), 'E_J7_SOURCE_EXPECTED_IDENTITY');
}

function runAdmission(options, repo) {
  argShape(options, repo);
  const root = path.resolve(options.root);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'j7-src-'));
  try {
    const script = readRegular(path.join(__dirname, CLI), 64 * 1024, 'E_J7_SOURCE_PIN');
    expect(sha256Buffer(script).toLowerCase() === CLI_SHA256, 'E_J7_SOURCE_PIN');
    const executor = path.join(directory, CLI);
    fs.writeFileSync(executor, script, { flag: 'wx', mode: 0o600 });
    const output = path.join(directory, 'admitted');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PYTHON|GIT_)/i.test(key)));
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', executor,
      '--repo', path.resolve(repo), '--checkout', options.sha, '--tools', __dirname,
      '--build-job-id', options.buildJobId, '--e2e-run-id', options.run, '--e2e-attempt', options.attempt,
      '--e2e-build-id', options.buildId, '--build-input', path.join(root, 'build'),
      '--formal-input', path.join(root, 'formal'), '--out-dir', output],
    { env, encoding: 'utf8', timeout: 210_000, maxBuffer: 64 * 1024 });
    const code = result.stderr?.trim();
    if (result.status !== 0) {
      expect(false, /^(?:E_ANC_|J4_ADMISSION_|J7_BUILD_PROVENANCE_|J7_SOURCES_)[A-Z0-9_]+$/.test(code ?? '') ? code : 'E_J7_SOURCE_ADMITTER');
    }
    expect(result.stdout.trim() === 'J7_SOURCES_PARTIAL_OK' && code === '', 'E_J7_SOURCE_ADMITTER');
    const build = readOutput(output, 'build-admission.json');
    const badAdmission = readOutput(output, 'bad-config-admission.json');
    const bad = { name: 'bad-config', ...readOutput(output, 'j7-bad-config.json') };
    const j4 = { name: 'j4-attribution', ...readOutput(output, 'j4-attribution.json') };
    const { record, e2eBuildId, jobId } = build.value;
    expect(record.checkout.sha === options.sha && record.checkout.tree === options.tree && record.runner.runId === options.run &&
      record.runner.runAttempt === options.attempt && record.runner.workflow === options.workflow && e2eBuildId === options.buildId &&
      jobId === options.buildJobId, 'E_J7_SOURCE_EXPECTED_IDENTITY');
    const buildLog = readRegular(path.join(root, 'build', 'job.log'), 16 * 1024 * 1024, 'E_J7_SOURCE_BUILD_LOG');
    const buildControls = buildControlFields(buildLog);
    expect(buildControls.productionAppEnvCount === 1 && buildControls.strip.production === 'PASS' &&
      buildControls.strip.negative === 'DETECTED' && buildControls.strip.original === 'PASS' &&
      Number.isSafeInteger(buildControls.strip.markers) && buildControls.strip.markers >= 1, 'E_J7_SOURCE_BUILD_CONTROL');
    const projected = {
      run: { id: Number(options.run), attempt: Number(options.attempt), workflow: options.workflow, ref: record.runner.ref },
      checkout: record.checkout, e2eBuildId, buildControls, build: { ...build.value, reportSha256: build.sha256 },
      badConfig: { ...badAdmission.value, reportSha256: badAdmission.sha256, sourceSha256: bad.sha256 },
      j4: { ...j4.value, reportSha256: j4.sha256 },
    };
    let runnerBindingFixture = null;
    if (options.runnerBindingFixture) {
      const { admitRunnerBindingFixture } = require('./j7-runner-binding-admission.cjs');
      const fixture = path.resolve(options.runnerBindingFixture);
      const relative = path.relative(fs.realpathSync(root), fs.realpathSync(fixture));
      expect(fs.lstatSync(fixture).isDirectory() && relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative), 'E_J7_RUNNER_FIXTURE_ROOT');
      const fixtureTemp = path.join(directory, 'runner');
      fs.mkdirSync(fixtureTemp);
      runnerBindingFixture = admitRunnerBindingFixture(fixture, root, path.resolve(repo), projected,
        Number(options.e2eJobId), fixtureTemp, options.runnerTrustedExpect);
    }
    let retryableFixture = null;
    if (options.retryableFixture) {
      const fixtureTemp = path.join(directory, 'retryable');
      fs.mkdirSync(fixtureTemp);
      retryableFixture = admitRetryableFixture(path.resolve(options.retryableFixture), path.resolve(repo), projected, fixtureTemp);
    }
    return { projected, bad, j4, retryableFixture, runnerBindingFixture };
  } catch (error) {
    if (error instanceof SourceAdmissionError) throw error;
    if (error instanceof RetryableAdmissionError) throw new SourceAdmissionError(error.message);
    throw new SourceAdmissionError('E_J7_SOURCE_INPUT');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function subsetBytes(admitted) {
  const subset = { schema: 'j7-source-subset/1', status: 'verified-subset', formalQualified: false,
    pending: MISSING_FORMAL_SOURCES, sources: admitted.projected };
  if (admitted.retryableFixture) {
    const { data, ...projection } = admitted.retryableFixture;
    subset.fixtures = { retryable: projection };
  }
  if (admitted.runnerBindingFixture) {
    const { data, ...projection } = admitted.runnerBindingFixture;
    subset.fixtures = { runnerBinding: projection };
  }
  return Buffer.from(`${JSON.stringify(subset, null, 2)}\n`);
}

function writeSubset(file, admitted) {
  const target = path.resolve(file);
  const privateDirectory = fs.mkdtempSync(path.join(path.dirname(target), '.j7-output-'));
  try {
    const temporary = path.join(privateDirectory, 'subset.json');
    fs.writeFileSync(temporary, subsetBytes(admitted), { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, target);
  } catch (error) {
    throw new SourceAdmissionError(error.code === 'EEXIST' ? 'E_J7_SOURCE_OUTPUT_EXISTS' : 'E_J7_SOURCE_OUTPUT');
  } finally {
    fs.rmSync(privateDirectory, { recursive: true, force: true });
  }
}

function requireFormalSources() {
  throw new SourceAdmissionError('E_J7_FORMAL_SOURCES_PENDING');
}

function buildControlFields(buildLog) {
  const byStep = (step, pattern) => {
    const rows = buildLog.toString('utf8').split(/\r?\n/).flatMap((line) => {
      const fields = line.split('\t');
      if (fields.length !== 3 || fields[0] !== 'build-and-audit' || fields[1] !== step) return [];
      const match = /^\ufeff?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z (.*)$/.exec(fields[2]);
      const value = match && pattern.exec(match[1]);
      return value ? [value] : [];
    });
    expect(rows.length === 1, 'E_J7_SOURCE_BUILD_CONTROL');
    return rows[0];
  };
  const env = byStep('独立 production 模式构建（公开输入，无业务密钥）', /^APP_ENV_AT_BUILD=production count=(\d+)$/);
  const strip = byStep('M4-T4 production notification hook stripping (positive and negative controls)',
    /^M4T4_HOOK_STRIP production=(\w+) negative=(\w+) original=(\w+) markers=(\d+)$/);
  return { productionAppEnvCount: Number(env[1]),
    strip: { production: strip[1], negative: strip[2], original: strip[3], markers: Number(strip[4]) } };
}

function matchSubject(admitted, { commit, tree, run, buildId }) {
  const expected = admitted.projected;
  expect(expected.checkout.sha === commit && expected.checkout.tree === tree && expected.checkout.prHeadSha === run.headSha &&
    expected.run.id === run.id && expected.run.attempt === run.attempt && expected.run.workflow === run.workflow &&
    expected.run.ref === run.ref && expected.e2eBuildId === buildId, 'E_J7_SOURCE_SUBJECT');
}

function buildFields(admitted) {
  const { original, production } = admitted.projected.build.record.builds;
  return {
    buildId: production.buildId,
    serverJsSha256: production.serverJs.sha256.toUpperCase(),
    originalBuildId: original.buildId,
    originalServerJsSha256: original.serverJs.sha256.toUpperCase(),
  };
}

function verifyProjection(admitted, receipt, add) {
  if (!isDeepStrictEqual(receipt.sourceAdmission, admitted.projected)) add('E_J7_SOURCE_PROJECTION');
  const production = receipt.builds?.find?.((entry) => entry?.appEnvAtBuild === 'production');
  if (!production || production.digestGap !== undefined ||
      Object.entries(buildFields(admitted)).some(([key, value]) => production[key] !== value) ||
      !isDeepStrictEqual(receipt.strip, admitted.projected.buildControls.strip)) add('E_J7_SOURCE_BUILD_PROJECTION');
  const badConfig = receipt.states?.badConfig;
  const { bad, j4 } = admitted;
  const codes = [...bad.value.codes].sort();
  if (!isDeepStrictEqual(badConfig, { exit: bad.value.exit, codes, sourceSha256: bad.sha256 })) add('E_J7_SOURCE_BAD_CONFIG_PROJECTION');
  const failure = receipt.failureAttribution;
  if (j4.value.failedKey !== failure?.jobKey || j4.value.failedStatus !== failure?.failedStatus ||
      j4.value.errorCode !== failure?.errorCode) add('E_J7_SOURCE_J4_PROJECTION');
  for (const entry of [bad, j4]) {
    const matches = (Array.isArray(receipt.corroboration) ? receipt.corroboration : []).filter((claim) => claim?.name === entry.name);
    if (matches.length !== 1 || matches[0].sha256 !== entry.sha256) add('E_J7_SOURCE_ATTACHMENT_DIGEST', entry.name);
  }
}

function verifyOptionalAttachments(admitted, corroboration) {
  for (const entry of [admitted.bad, admitted.j4]) {
    if (corroboration[entry.name]) expect(sameFile(corroboration[entry.name], entry.data), 'E_J7_SOURCE_ATTACHMENT_DIFF');
  }
  const retryable = admitted.runnerBindingFixture ?? admitted.retryableFixture;
  if (retryable && corroboration.retryable) {
    expect(sameFile(corroboration.retryable, retryable.data), 'E_J7_RETRYABLE_ATTACHMENT_DIFF');
  }
}

module.exports = {
  SourceAdmissionError, sourceOption, runAdmission, subsetBytes, writeSubset, sameFile, requireFormalSources, buildFields,
  matchSubject, verifyProjection, verifyOptionalAttachments, MISSING_FORMAL_SOURCES,
};
