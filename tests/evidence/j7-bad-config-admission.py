#!/usr/bin/env python3
"""Admit one bad-config artifact from authenticated Actions inputs and approved build provenance."""

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile
from zlib import error as DeflateError


PROVENANCE_SHA = 'eca37695fe8e9bfdbc979ef1b91b7d2329721bfbce68d84bfff7ef38539724f3'
JOB = 'build-and-audit'
TAP_STEP = 'standalone 启动检查（STANDALONE_TEST=1，缺产物或环境 skip 都算失败；只用假值）'
FILE_STEP = '核准坏配置旁证实物'
UPLOAD_STEP = '上传坏配置旁证（单文件）'
CHECKOUT_STEP = 'Run actions/checkout@v4'
FILENAME = 'j7-bad-config.json'
CODES = {'EDGE_AUTH_SECRET', 'DATABASE_URL', 'SMTP_PASS'}
HEX40 = r'[0-9a-f]{40}'
HEX64 = r'[0-9a-f]{64}'
ID = r'[1-9][0-9]{0,19}'
ATTEMPT = r'[1-9][0-9]{0,5}'
TS = r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z '


class AdmissionError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise AdmissionError(code)


def matches(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def digest(data):
    return sha256(data).hexdigest()


def fields(obj, names):
    return isinstance(obj, dict) and obj.keys() == set(names.split())


def read_bytes(path, limit, code):
    stat_result = path.lstat()
    require(stat.S_ISREG(stat_result.st_mode) and 0 < stat_result.st_size <= limit, code)
    with path.open('rb') as file:
        payload = file.read(limit + 1)
    require(len(payload) == stat_result.st_size, code)
    return payload


def parse_json(payload, code):
    def unique(pairs):
        values = dict(pairs)
        require(len(values) == len(pairs), code)
        return values

    try:
        data = json.loads(payload.decode('utf-8'), object_pairs_hook=unique)
    except (ValueError, RecursionError):
        raise AdmissionError(code) from None
    require(isinstance(data, dict), code)
    return data


def load(path, code, limit=1024 * 1024):
    return parse_json(read_bytes(path, limit, code), code)


def job_log(path):
    text = read_bytes(path, 16 * 1024 * 1024, 'E_ANC_JOB_LOG').decode('utf-8', errors='replace')
    rows = []
    for line in text.split('\n'):
        if not line.strip():
            continue
        cols = line.split('\t', 2)
        require(len(cols) == 3 and cols[0] == JOB, 'E_ANC_JOB_LOG')
        wire = cols[2].removesuffix('\r')
        stamp = re.match(TS, wire)
        if stamp is not None:
            rows.append((cols[1], wire[stamp.end():], wire))
    return rows


def check_checkout(rows, commit, expected):
    code = 'E_ANC_CHECKOUT'
    match = [i for i, (step, text, _) in enumerate(rows)
             if step == CHECKOUT_STEP and text == '[command]/usr/bin/git log -1 --format=%H']
    require(len(match) == 1 and match[0] + 1 < len(rows), code)
    step, observed, _ = rows[match[0] + 1]
    require(step == CHECKOUT_STEP and matches(observed, HEX40) and observed == expected['sha'], code)
    require(commit.get('sha') == observed and commit['tree']['sha'] == expected['tree']
            and [parent['sha'] for parent in commit['parents']] == expected['parents'], code)


def check_steps(jobs, job_id):
    code = 'E_ANC_JOB_STEPS'
    require(type(jobs.get('total_count')) is int and jobs['total_count'] == len(jobs['jobs']), code)
    selected = [job for job in jobs['jobs'] if job.get('name') == JOB and str(job.get('id')) == job_id]
    require(len(selected) == 1, code)
    steps = selected[0]['steps']
    names = (CHECKOUT_STEP, TAP_STEP, FILE_STEP, UPLOAD_STEP, 'Record J7 independent build provenance')
    numbers = []
    for name in names:
        found = [step for step in steps if step.get('name') == name]
        require(len(found) == 1, code)
        step = found[0]
        number = step.get('number')
        require(type(number) is int and number > 0 and step.get('status') == 'completed'
                and step.get('conclusion') == 'success', code)
        numbers.append(number)
    require(numbers == sorted(set(numbers)), code)


def check_artifact(listing, detail, name, run, runner, limit):
    code = 'E_ANC_ARTIFACT'
    entries = listing['artifacts']
    require(type(listing.get('total_count')) is int and listing['total_count'] == len(entries), code)
    selected = [entry for entry in entries if entry.get('name') == name]
    require(len(selected) == 1 and detail.get('name') == name, code)
    artifact_id = detail.get('id')
    require(type(artifact_id) is int and matches(str(artifact_id), ID), code)
    require(sum(entry.get('id') == artifact_id for entry in entries) == 1, code)
    size = detail.get('size_in_bytes')
    require(type(size) is int and 0 < size <= limit, code)
    for key in ('id', 'name', 'digest', 'size_in_bytes', 'expired', 'workflow_run'):
        require(selected[0].get(key) == detail.get(key), code)
    context = detail.get('workflow_run') or {}
    require(detail.get('expired') is False and matches(detail.get('digest'), 'sha256:' + HEX64), code)
    require(context.get('id') == int(runner['runId']) and context.get('repository_id') == int(runner['repositoryId'])
            and context.get('head_repository_id') == run['head_repository']['id']
            and context.get('head_sha') == run['head_sha'], code)
    return str(artifact_id), detail['digest'][7:], size


def check_upload(rows, step_name, name, artifact):
    artifact_id, zip_sha, size = artifact
    code = 'E_ANC_UPLOAD_LINK'
    digest_prefix = 'SHA256 digest of uploaded artifact zip is '
    summary_prefix = f'Artifact {name} has been successfully uploaded!'
    final_prefix = f'Artifact {name}.zip successfully finalized.'
    body = [text for step, text, _ in rows if step == step_name]
    require([line for line in body if line.startswith(digest_prefix)] == [digest_prefix + zip_sha], code)
    require([line for line in body if line.startswith(final_prefix)] == [f'{final_prefix} Artifact ID {artifact_id}'], code)
    require([line for line in body if line.startswith(summary_prefix)] == [
        f'{summary_prefix} Final size is {size} bytes. Artifact ID is {artifact_id}',
    ], code)


def approved_file_sha(rows, runner):
    body = [(step, text) for step, text, _ in rows if text.startswith('J7_BAD_CONFIG_FILE')]
    code = 'E_ANC_FILE_APPROVAL'
    require(len(body) == 1 and body[0][0] == FILE_STEP, code)
    match = re.fullmatch(rf'J7_BAD_CONFIG_FILE run=({ID}) attempt=({ATTEMPT}) sha256=({HEX64})', body[0][1])
    require(match is not None and match[1] == runner['runId'] and match[2] == runner['runAttempt'], code)
    return match[3]


def acquire_member(path, artifact, expected_sha):
    _, zip_sha, size = artifact
    raw = read_bytes(path, 64 * 1024, 'E_ANC_ZIP')
    require(len(raw) == size and digest(raw) == zip_sha, 'E_ANC_ZIP_DIGEST')
    code = 'E_ANC_ZIP_MEMBER'
    try:
        with ZipFile(BytesIO(raw)) as archive:
            members = archive.infolist()
            require(len(members) == 1, code)
            member = members[0]
            require(member.filename == FILENAME and member.orig_filename == FILENAME and not member.is_dir()
                    and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFREG)
                    and member.compress_type in (ZIP_STORED, ZIP_DEFLATED) and not (member.flag_bits & 1)
                    and 0 < member.file_size <= 16 * 1024, code)
            payload = archive.read(member)
            require(len(payload) == member.file_size, code)
    except (BadZipFile, DeflateError, RuntimeError, EOFError, NotImplementedError):
        raise AdmissionError(code) from None
    require(digest(payload) == expected_sha, 'E_ANC_FILE_DIGEST')
    return payload


def validate_document(doc, admission):
    require(fields(doc, 'schema exit codes cases run source build') and doc['schema'] == 'j7-bad-config/1'
            and type(doc['exit']) is int and doc['exit'] == 1, 'E_ANC_SCHEMA')
    require(isinstance(doc['codes'], list) and len(doc['codes']) == 3 and set(doc['codes']) == CODES,
            'E_ANC_CODE_SET')
    cases = doc['cases']
    code = 'E_ANC_CASES'
    require(isinstance(cases, list) and len(cases) == 3, code)
    for case in cases:
        require(fields(case, 'code exit problemLines valuesLeaked ready') and case['code'] in CODES
                and type(case['exit']) is int and case['exit'] == 1
                and type(case['problemLines']) is int and case['problemLines'] == 1
                and case['valuesLeaked'] is False and case['ready'] is False, code)
    require({case['code'] for case in cases} == CODES, code)
    record = admission['record']
    runner = record['runner']
    doc_run = doc['run']
    require(fields(doc_run, 'workflow id attempt job') and doc_run['workflow'] == 'CI'
            and doc_run['job'] == JOB, 'E_ANC_JOB_BIND')
    require(type(doc_run['id']) is int and type(doc_run['attempt']) is int
            and str(doc_run['id']) == runner['runId'] and str(doc_run['attempt']) == runner['runAttempt'], 'E_ANC_RUN_BIND')
    checkout = record['checkout']
    require(fields(doc['source'], 'commit tree head') and doc['source']['commit'] == checkout['sha']
            and doc['source']['head'] == checkout['prHeadSha'], 'E_ANC_COMMIT_BIND')
    require(doc['source']['tree'] == checkout['tree'], 'E_ANC_TREE_BIND')
    original = record['builds']['original']
    build = doc['build']
    require(fields(build, 'buildId serverJsSha256 sameBuildAsE2E') and build['sameBuildAsE2E'] is False
            and build['buildId'] == original['buildId'] and build['buildId'] != admission['e2eBuildId']
            and isinstance(build['serverJsSha256'], str) and build['serverJsSha256'].lower() == original['serverJs']['sha256']
            and original['serverJs']['sha256'] != '0' * 64, 'E_ANC_ORIGINAL_BUILD')


def admit(args):
    tool = read_bytes(args.provenance_tool, 64 * 1024, 'E_ANC_PROVENANCE_TOOL')
    require(digest(tool) == PROVENANCE_SHA, 'E_ANC_PROVENANCE_TOOL')
    expect = load(args.expect, 'E_ANC_EXPECT')
    runner, checkout = expect['runner'], expect['checkout']
    require(matches(runner['runId'], ID) and matches(runner['runAttempt'], ATTEMPT) and runner['job'] == JOB
            and matches(runner['repositoryId'], ID) and matches(args.job_id, ID), 'E_ANC_EXPECT')
    rows = job_log(args.job_log)
    check_checkout(rows, load(args.checkout_commit, 'E_ANC_CHECKOUT'), checkout)
    check_steps(load(args.jobs, 'E_ANC_JOB_STEPS'), args.job_id)
    run = load(args.run, 'E_ANC_RUN')
    listing = load(args.artifact_list, 'E_ANC_ARTIFACT')
    prefix = f'j7-build-provenance-{runner["runId"]}-{runner["runAttempt"]}'
    provenance = check_artifact(listing, load(args.provenance_artifact, 'E_ANC_ARTIFACT'), prefix, run, runner, 64 * 1024)
    prov_size = args.provenance_zip.lstat().st_size
    require(prov_size == provenance[2], 'E_ANC_ZIP_DIGEST')
    expected_link = ('Record J7 provenance upload identity',
                     f'J7_BUILD_PROVENANCE_UPLOAD run={runner["runId"]} attempt={runner["runAttempt"]} '
                     f'artifact={provenance[0]} sha256={provenance[1]}')
    require([(step, text) for step, text, _ in rows if text.startswith('J7_BUILD_PROVENANCE_UPLOAD')] == [expected_link],
            'E_ANC_PROVENANCE_LINK')
    name = f'j7-bad-config-a{runner["runAttempt"]}'
    bad = check_artifact(listing, load(args.bad_artifact, 'E_ANC_ARTIFACT'), name, run, runner, 64 * 1024)
    require(bad[0] != provenance[0], 'E_ANC_ARTIFACT')
    check_upload(rows, UPLOAD_STEP, name, bad)
    file_sha = approved_file_sha(rows, runner)
    payload = acquire_member(args.bad_zip, bad, file_sha)

    with TemporaryDirectory(dir=args.out_dir.parent, prefix='.j7-bad-config-') as temporary:
        stage = Path(temporary)
        helper, log, verified = stage / 'provenance.py', stage / 'build.log', stage / 'verified.json'
        helper.write_bytes(tool)
        log.write_bytes(('\n'.join(wire for _, _, wire in rows) + '\n').encode())
        result = subprocess.run([
            sys.executable, '-B', str(helper), 'admit', '--expect', str(args.expect), '--run', str(args.run),
            '--jobs', str(args.jobs), '--job-id', args.job_id, '--artifact', str(args.provenance_artifact),
            '--zip', str(args.provenance_zip), '--job-log', str(log), '--out', str(verified),
        ], capture_output=True, timeout=30)
        require(result.returncode == 0 and result.stdout.strip() == b'J7_BUILD_PROVENANCE_ADMITTED', 'E_ANC_PROVENANCE')
        admission = load(verified, 'E_ANC_PROVENANCE')
        require(admission['schema'] == 'j7-build-provenance-admission/1' and admission['jobId'] == args.job_id
                and admission['artifact']['id'] == provenance[0] and admission['artifact']['zipSha256'] == provenance[1],
                'E_ANC_PROVENANCE')
        validate_document(parse_json(payload, 'E_ANC_SCHEMA'), admission)
        output = stage / 'admitted'
        output.mkdir()
        (output / FILENAME).write_bytes(payload)
        identity = {
            'schema': 'j7-bad-config-admission/1', 'runner': runner, 'checkout': checkout, 'jobId': args.job_id,
            'artifact': {'name': name, 'id': bad[0], 'zipSha256': bad[1], 'recordSha256': file_sha},
            'buildProvenance': admission['artifact'], 'originalBuild': admission['record']['builds']['original'],
            'corroboration': {'name': 'bad-config', 'sha256': file_sha},
        }
        (output / 'admission.json').write_bytes((json.dumps(identity, sort_keys=True, indent=2) + '\n').encode())
        require(not args.out_dir.exists() and not args.out_dir.is_symlink(), 'E_ANC_OUTPUT')
        output.rename(args.out_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ('expect', 'run', 'jobs', 'job-log', 'checkout-commit', 'artifact-list', 'provenance-tool',
                'provenance-artifact', 'provenance-zip', 'bad-artifact', 'bad-zip', 'out-dir'):
        parser.add_argument('--' + key, required=True, type=Path)
    parser.add_argument('--job-id', required=True)
    args = parser.parse_args()
    try:
        admit(args)
    except AdmissionError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, TypeError, AttributeError, KeyError, RecursionError, subprocess.SubprocessError):
        print('E_ANC_INPUT', file=sys.stderr)
        return 1
    print('J7_BAD_CONFIG_ADMITTED')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
