#!/usr/bin/env python3
"""Measure the two build-and-audit outputs and admit the bound Actions artifact."""

import argparse
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile
from zlib import error as DeflateError

SCHEMA = 'j7-build-provenance/1'
WORKFLOW = 'CI'
WORKFLOW_PATH = '.github/workflows/ci.yml'
JOB = 'build-and-audit'
FILENAME = 'J7-BUILD-PROVENANCE.json'
ARTIFACT_PREFIX = 'j7-build-provenance'
JSON_MAX = 16 * 1024
SERVER_MAX = 8 * 1024 * 1024
ZIP_MAX = 64 * 1024
ID = r'[1-9][0-9]{0,19}'
ATTEMPT = r'[1-9][0-9]{0,5}'
BUILD_ID = r'[A-Za-z0-9_-]{1,128}'
GIT_SHA = r'[0-9a-f]{40}'
DIGEST = r'[0-9a-f]{64}'
PR_REF = rf'refs/pull/({ID})/merge'
STEPS = (
    '记录原非production构建身份并让位',
    '独立 production 模式构建（公开输入，无业务密钥）',
    'production 产物 mock 断言（0 skip，缺产物即失败）',
    'M4-T4 production notification hook stripping (positive and negative controls)',
    'Record J7 independent build provenance',
    'Upload J7 independent build provenance',
    'Record J7 provenance upload identity',
)
UPLOAD_PATTERN = rf'J7_BUILD_PROVENANCE_UPLOAD run=({ID}) attempt=({ATTEMPT}) artifact=({ID}) sha256=({DIGEST})'
GITHUB_LOG_PREFIX = r'(?:\d{4}-\d{2}-\d{2}T\d\d:\d\d:\d\d(?:\.\d+)?Z )?'


class EvidenceError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise EvidenceError(code)


def matches(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def read_bytes(path, limit, code):
    try:
        metadata = path.lstat()
        require(stat.S_ISREG(metadata.st_mode) and 0 < metadata.st_size <= limit, code)
        with path.open('rb') as stream:
            data = stream.read(limit + 1)
    except OSError:
        raise EvidenceError(code) from None
    require(len(data) == metadata.st_size, code)
    return data


def read_json(data, code):
    def unique(pairs):
        result = dict(pairs)
        require(len(result) == len(pairs), code)
        return result

    try:
        result = json.loads(data.decode('utf-8'), object_pairs_hook=unique)
    except (ValueError, RecursionError):
        raise EvidenceError(code) from None
    require(isinstance(result, dict), code)
    return result


def load_json(file, code, limit=JSON_MAX):
    return read_json(read_bytes(file, limit, code), code)


def write_json(file, data):
    try:
        with file.open('xb') as stream:
            stream.write((json.dumps(data, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode())
    except OSError:
        raise EvidenceError('J7_BUILD_PROVENANCE_OUTPUT') from None


def object_keys(value, keys):
    return isinstance(value, dict) and value.keys() == set(keys)


def artifact_name(run, attempt):
    return f'{ARTIFACT_PREFIX}-{run}-{attempt}'


def runner_from_env():
    fields = {
        'repositoryId': 'GITHUB_REPOSITORY_ID', 'runId': 'GITHUB_RUN_ID', 'runAttempt': 'GITHUB_RUN_ATTEMPT',
        'workflow': 'GITHUB_WORKFLOW', 'job': 'GITHUB_JOB', 'event': 'GITHUB_EVENT_NAME', 'ref': 'GITHUB_REF',
    }
    runner = {key: os.environ.get(env) for key, env in fields.items()}
    validate_runner(runner, 'J7_BUILD_PROVENANCE_RUNNER')
    return runner


def validate_runner(runner, code):
    require(object_keys(runner, ('repositoryId', 'runId', 'runAttempt', 'workflow', 'job', 'event', 'ref')), code)
    require(matches(runner['repositoryId'], ID) and matches(runner['runId'], ID) and matches(runner['runAttempt'], ATTEMPT), code)
    require(runner['workflow'] == WORKFLOW and runner['job'] == JOB, code)
    require((runner['event'] == 'pull_request' and matches(runner['ref'], PR_REF))
            or (runner['event'] == 'push' and runner['ref'] == 'refs/heads/main'), code)


def git(*args):
    try:
        return subprocess.run(['git', *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
    except (OSError, subprocess.CalledProcessError):
        raise EvidenceError('J7_BUILD_PROVENANCE_CHECKOUT') from None


def actual_checkout(runner):
    token = os.environ.get('GITHUB_SHA')
    actual = git('rev-parse', 'HEAD').decode('ascii').strip()
    require(token == actual and matches(actual, GIT_SHA), 'J7_BUILD_PROVENANCE_CHECKOUT')
    parents = [line.removeprefix(b'parent ').decode('ascii')
               for line in git('cat-file', '-p', actual).split(b'\n\n', 1)[0].splitlines() if line.startswith(b'parent ')]
    result = {
        'sha': actual, 'tree': git('rev-parse', 'HEAD^{tree}').decode('ascii').strip(), 'parents': parents,
        'prHeadSha': os.environ.get('J7_PROVENANCE_PR_HEAD') or None,
    }
    validate_checkout(result, runner['event'], 'J7_BUILD_PROVENANCE_CHECKOUT')
    require(not git('status', '--porcelain=v1', '--untracked-files=no'), 'J7_BUILD_PROVENANCE_TRACKED_DIRTY')
    return result


def validate_checkout(checkout, event, code):
    require(object_keys(checkout, ('sha', 'tree', 'parents', 'prHeadSha')), code)
    require(matches(checkout['sha'], GIT_SHA) and matches(checkout['tree'], GIT_SHA), code)
    parents = checkout['parents']
    require(isinstance(parents, list) and all(matches(parent, GIT_SHA) for parent in parents), code)
    if event == 'pull_request':
        require(len(parents) == 2 and len(set(parents)) == 2 and checkout['prHeadSha'] == parents[1], code)
    else:
        require(checkout['prHeadSha'] is None, code)


def file_id(path, code):
    value = read_bytes(path, 256, code).decode('utf-8').strip()
    require(matches(value, BUILD_ID), code)
    return value


def measure(directory, mode):
    code = 'J7_BUILD_PROVENANCE_' + mode.upper() + '_FILES'
    for folder in (directory, directory / 'standalone', directory / 'standalone/.next'):
        require(folder.is_dir() and not folder.is_symlink(), code)
    build_id = file_id(directory / 'BUILD_ID', code)
    require(build_id == file_id(directory / 'standalone/.next/BUILD_ID', code), code)
    server = read_bytes(directory / 'standalone/server.js', SERVER_MAX, code)
    markers = re.findall(rb'"APP_ENV_AT_BUILD"\s*:\s*"([^"\\]*)"', server)
    require(markers and all((marker == b'production') == (mode == 'production') for marker in markers),
            'J7_BUILD_PROVENANCE_' + mode.upper() + '_MODE')
    return {'buildId': build_id, 'serverJs': {'bytes': len(server), 'sha256': sha256(server).hexdigest()}}


def validate_build(build, code):
    require(object_keys(build, ('buildId', 'serverJs')) and matches(build['buildId'], BUILD_ID), code)
    server = build['serverJs']
    require(object_keys(server, ('bytes', 'sha256')) and type(server['bytes']) is int
            and 0 < server['bytes'] <= SERVER_MAX and matches(server['sha256'], DIGEST), code)


def validate_builds(builds, code):
    require(object_keys(builds, ('original', 'production')), code)
    original, production = builds['original'], builds['production']
    validate_build(original, code)
    validate_build(production, code)
    require(original['buildId'] != production['buildId'], 'J7_BUILD_PROVENANCE_BUILD_ID_COLLISION')
    require(original['serverJs']['sha256'] != production['serverJs']['sha256'], 'J7_BUILD_PROVENANCE_DIGEST_SUBSTITUTED')


def produce(args):
    runner = runner_from_env()
    checkout = actual_checkout(runner)
    original = measure(Path('.next-original-build'), 'original')
    production = measure(Path('.next'), 'production')
    saved = load_json(args.original, 'J7_BUILD_PROVENANCE_ORIGINAL_SNAPSHOT')
    old_server = saved.get('serverJs')
    require(isinstance(old_server, dict) and isinstance(old_server.get('sha256'), str), 'J7_BUILD_PROVENANCE_ORIGINAL_SNAPSHOT')
    saved_fields = {
        'buildId': saved.get('buildId'),
        'serverJs': {'bytes': old_server.get('bytes'), 'sha256': old_server['sha256'].lower()},
    }
    validate_build(saved_fields, 'J7_BUILD_PROVENANCE_ORIGINAL_SNAPSHOT')
    require(original == saved_fields, 'J7_BUILD_PROVENANCE_ORIGINAL_DRIFT')
    require(production == load_json(args.production, 'J7_BUILD_PROVENANCE_PRODUCTION_SNAPSHOT'),
            'J7_BUILD_PROVENANCE_PRODUCTION_DRIFT')
    builds = {'original': original, 'production': production}
    validate_builds(builds, 'J7_BUILD_PROVENANCE_BUILD_FIELDS')
    write_json(args.out, {'schema': SCHEMA, 'runner': runner, 'checkout': checkout, 'builds': builds})
    print('J7_BUILD_PROVENANCE_RECORDED')


def link_upload(args):
    runner = runner_from_env()
    digest = args.digest.removeprefix('sha256:').lower()
    require(matches(args.artifact, ID) and matches(digest, DIGEST), 'J7_BUILD_PROVENANCE_UPLOAD_OUTPUT')
    print(f'J7_BUILD_PROVENANCE_UPLOAD run={runner["runId"]} attempt={runner["runAttempt"]} artifact={args.artifact} sha256={digest}')


def metadata_id(value, expected):
    return type(value) is int and str(value) == expected


def read_archive(file, digest):
    raw = read_bytes(file, ZIP_MAX, 'J7_BUILD_PROVENANCE_ARCHIVE')
    require(sha256(raw).hexdigest() == digest, 'J7_BUILD_PROVENANCE_ARCHIVE_DIGEST')
    code = 'J7_BUILD_PROVENANCE_ARCHIVE_MEMBER'
    try:
        with ZipFile(BytesIO(raw)) as archive:
            entries = archive.infolist()
            require(len(entries) == 1, code)
            entry = entries[0]
            require(entry.filename == FILENAME and entry.orig_filename == FILENAME and not entry.is_dir()
                    and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)
                    and entry.compress_type in (ZIP_STORED, ZIP_DEFLATED) and 0 < entry.file_size <= JSON_MAX, code)
            data = archive.read(entry)
    except (BadZipFile, RuntimeError, OSError, EOFError, DeflateError):
        raise EvidenceError(code) from None
    return read_json(data, 'J7_BUILD_PROVENANCE_RECORD'), sha256(data).hexdigest()


def check_actions_run(data, runner, checkout):
    code = 'J7_BUILD_PROVENANCE_ACTIONS_RUN'
    head = checkout['prHeadSha'] or checkout['sha']
    require(metadata_id(data.get('id'), runner['runId']) and metadata_id(data.get('run_attempt'), runner['runAttempt']), code)
    require(data.get('name') == WORKFLOW and data.get('path') == WORKFLOW_PATH
            and data.get('event') == runner['event'] and data.get('head_sha') == head, code)
    repo = data.get('repository') or {}
    source_repo = data.get('head_repository') or {}
    require(isinstance(repo, dict) and metadata_id(repo.get('id'), runner['repositoryId'])
            and isinstance(source_repo, dict) and type(source_repo.get('id')) is int and source_repo['id'] > 0, code)
    if runner['event'] == 'push':
        require(data.get('head_branch') == 'main', code)
    else:
        pull_requests = data.get('pull_requests')
        require(isinstance(pull_requests, list), code)
        pr_number = re.fullmatch(PR_REF, runner['ref'])[1]
        if pull_requests:
            related = [pr for pr in pull_requests if isinstance(pr, dict) and metadata_id(pr.get('number'), pr_number)]
            require(len(related) == 1, code)
            pr_head, pr_base = related[0].get('head'), related[0].get('base', {})
            require(isinstance(pr_head, dict) and matches(pr_head.get('sha'), GIT_SHA) and isinstance(pr_base, dict), code)
            # GitHub can refresh the nested PR heads after the run. Only the run and job carry the historical head.
            for side, repository_id in ((pr_head, source_repo['id']), (pr_base, repo['id'])):
                if 'repo' in side:
                    linked_repo = side['repo']
                    require(isinstance(linked_repo, dict) and metadata_id(linked_repo.get('id'), str(repository_id)), code)
    return head, source_repo['id']


def check_actions_job(data, runner, head, job_id):
    code = 'J7_BUILD_PROVENANCE_ACTIONS_JOB'
    jobs = data.get('jobs')
    require(isinstance(jobs, list), code)
    found = [job for job in jobs if isinstance(job, dict) and job.get('name') == JOB]
    require(len(found) == 1, code)
    job = found[0]
    require(matches(job_id, ID) and metadata_id(job.get('id'), job_id), code)
    require(metadata_id(job.get('run_id'), runner['runId']) and metadata_id(job.get('run_attempt'), runner['runAttempt'])
            and job.get('head_sha') == head and job.get('workflow_name') == WORKFLOW
            and job.get('status') == 'completed' and job.get('conclusion') == 'success', code)
    step_code = 'J7_BUILD_PROVENANCE_ACTIONS_STEPS'
    steps = job.get('steps')
    require(isinstance(steps, list), step_code)
    numbers = []
    for name in STEPS:
        matching = [step for step in steps if isinstance(step, dict) and step.get('name') == name]
        require(len(matching) == 1, step_code)
        step = matching[0]
        require(step.get('status') == 'completed' and step.get('conclusion') == 'success'
                and type(step.get('number')) is int and step['number'] > 0, step_code)
        numbers.append(step['number'])
    require(numbers == sorted(set(numbers)), step_code)


def check_artifact(data, runner, head, head_repo):
    code = 'J7_BUILD_PROVENANCE_ACTIONS_ARTIFACT'
    expected_name = artifact_name(runner['runId'], runner['runAttempt'])
    artifact_id = data.get('id')
    require(type(artifact_id) is int and matches(str(artifact_id), ID) and data.get('expired') is False
            and data.get('name') == expected_name, code)
    context = data.get('workflow_run')
    require(isinstance(context, dict) and metadata_id(context.get('id'), runner['runId'])
            and metadata_id(context.get('repository_id'), runner['repositoryId'])
            and context.get('head_sha') == head and metadata_id(context.get('head_repository_id'), str(head_repo)), code)
    digest = data.get('digest')
    require(matches(digest, 'sha256:' + DIGEST), 'J7_BUILD_PROVENANCE_ACTIONS_DIGEST')
    return str(artifact_id), expected_name, digest.removeprefix('sha256:')


def admit(args):
    expected = load_json(args.expect, 'J7_BUILD_PROVENANCE_EXPECTED')
    require(object_keys(expected, ('runner', 'checkout', 'e2eBuildId')), 'J7_BUILD_PROVENANCE_EXPECTED')
    runner, checkout, e2e_id = expected['runner'], expected['checkout'], expected['e2eBuildId']
    validate_runner(runner, 'J7_BUILD_PROVENANCE_EXPECTED')
    validate_checkout(checkout, runner['event'], 'J7_BUILD_PROVENANCE_EXPECTED')
    require(matches(e2e_id, BUILD_ID), 'J7_BUILD_PROVENANCE_EXPECTED')
    head, head_repo = check_actions_run(load_json(args.run, 'J7_BUILD_PROVENANCE_ACTIONS_RUN', 256 * 1024), runner, checkout)
    check_actions_job(load_json(args.jobs, 'J7_BUILD_PROVENANCE_ACTIONS_JOB', 1024 * 1024), runner, head, args.job_id)
    artifact, name, digest = check_artifact(load_json(args.artifact, 'J7_BUILD_PROVENANCE_ACTIONS_ARTIFACT'), runner, head, head_repo)
    log = read_bytes(args.job_log, 16 * 1024 * 1024, 'J7_BUILD_PROVENANCE_JOB_UPLOAD_LINK').decode('utf-8', errors='replace')
    records = re.findall('^' + GITHUB_LOG_PREFIX + UPLOAD_PATTERN + '$', log.replace('\r\n', '\n'), flags=re.M)
    require(records == [(runner['runId'], runner['runAttempt'], artifact, digest)], 'J7_BUILD_PROVENANCE_JOB_UPLOAD_LINK')
    record, content_digest = read_archive(args.zip, digest)
    require(object_keys(record, ('schema', 'runner', 'checkout', 'builds')) and record['schema'] == SCHEMA,
            'J7_BUILD_PROVENANCE_RECORD')
    require(record['runner'] == runner, 'J7_BUILD_PROVENANCE_RECORD_RUNNER')
    require(record['checkout'] == checkout, 'J7_BUILD_PROVENANCE_RECORD_CHECKOUT')
    validate_builds(record['builds'], 'J7_BUILD_PROVENANCE_BUILD_FIELDS')
    require(all(build['buildId'] != e2e_id for build in record['builds'].values()), 'J7_BUILD_PROVENANCE_E2E_COLLISION')
    output = {
        'schema': 'j7-build-provenance-admission/1', 'record': record,
        'artifact': {'id': artifact, 'name': name, 'zipSha256': digest, 'recordSha256': content_digest},
        'jobId': args.job_id, 'e2eBuildId': e2e_id,
    }
    write_json(args.out, output)
    print('J7_BUILD_PROVENANCE_ADMITTED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='mode', required=True)
    snapshot = commands.add_parser('snapshot-production')
    snapshot.add_argument('--out', required=True, type=Path)
    producer = commands.add_parser('produce')
    for field in ('original', 'production', 'out'):
        producer.add_argument(f'--{field}', type=Path, required=True)
    link = commands.add_parser('link-upload')
    link.add_argument('--artifact', required=True)
    link.add_argument('--digest', required=True)
    admission = commands.add_parser('admit')
    for field in ('expect', 'run', 'jobs', 'artifact', 'zip', 'job-log', 'out'):
        admission.add_argument(f'--{field}', required=True, type=Path)
    admission.add_argument('--job-id', required=True)
    args = parser.parse_args()
    try:
        if args.mode == 'snapshot-production':
            write_json(args.out, measure(Path('.next'), 'production'))
        elif args.mode == 'produce':
            produce(args)
        elif args.mode == 'link-upload':
            link_upload(args)
        else:
            admit(args)
    except EvidenceError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, TypeError, ValueError, AttributeError, RecursionError):
        print('J7_BUILD_PROVENANCE_INPUT_INVALID', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
