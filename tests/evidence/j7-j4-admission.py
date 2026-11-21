#!/usr/bin/env python3
"""Admit an authenticated Formal supplement artifact for J7 offline receipt assembly."""

import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path


WORKFLOW = 'Formal supplement (Linux)'
WORKFLOW_PATH = '.github/workflows/formal-supplement.yml'
WORKFLOW_ID = 424485035
JOB = 'b4-pg17 (with-guard + guard-control, one build)'
ARTIFACT = 'j4-operations-seam-evidence'
CHECKOUT = 'Run actions/checkout@v4'
BIND = 'Bind subject identity (merge ref, both parents, baseline ancestry)'
BUILD = 'Test-mode standalone build (real font chain, no application credentials)'
APPROVAL = 'Verify the approved manifest outside the checkout, then the checkout against it'
STAGE = 'Stage and seal the verified build (b4-pg17.sh stage)'
IMAGE = 'Build the runtime image once (one image id for both containers)'
PAIR = 'Pair gate (host, after both result sets exist)'
J4 = 'Run J4 operations seam in third isolated container (post-pair, same build and image)'
COLLECT = 'Collect J4 and J1 fixed upload sets'
UPLOAD = 'Upload J4 operations seam evidence'
GATE = 'Require the complete result set'
STEPS = (CHECKOUT, BIND, BUILD, APPROVAL, STAGE, IMAGE, PAIR, J4, COLLECT, UPLOAD, GATE)

OPERATIONS = '/api/admin/cron/operations'
LEGACY = '/api/admin/cron/retention-cleanup'
AGGREGATE = 'analytics-aggregate'
RETENTION = 'analytics-retention'
CHAT = 'chat-notifications'
MAIL = 'mail-queue'
OTHER_KEYS = (RETENTION, CHAT, MAIL)
HTTP_ROWS = {
    'missing-bearer': ('POST', OPERATIONS, CHAT, 401),
    'unknown-key': ('POST', OPERATIONS, 'ops-sample', 400),
    'chat': ('POST', OPERATIONS, CHAT, 200),
    'aggregate': ('POST', OPERATIONS, AGGREGATE, 200),
    'retention-default': ('POST', OPERATIONS, RETENTION, 200),
    'legacy-default': ('GET', LEGACY, RETENTION, 200),
    'aggregate-busy': ('POST', OPERATIONS, AGGREGATE, 409),
    'retention-busy': ('POST', OPERATIONS, RETENTION, 409),
    'legacy-busy': ('GET', LEGACY, RETENTION, 409),
    'aggregate-conflict': ('POST', OPERATIONS, AGGREGATE, 200),
}
REGISTRATIONS = [
    {'key': 'retention-cleanup', 'time': '03:30', 'method': 'GET', 'path': LEGACY, 'timezone': 'server-local'},
    {'key': RETENTION, 'time': '04:30', 'method': 'POST', 'path': OPERATIONS, 'timezone': 'server-local'},
]

HEX40 = r'[0-9a-f]{40}'
HEX64 = r'[0-9a-f]{64}'
BUILD_ID = r'[A-Za-z0-9_-]{8,64}'
DATABASE = r'e2e_j4_[0-9a-f]{12}'
UTC_SECOND = r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z'
UTC_MILLI = UTC_SECOND[:-1] + r'\.\d{3}Z'
LOG_LINE = re.compile(r'([^\t]+)\t([^\t]+)\t\ufeff?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z) (.*)')
REPLAY = (
    44684862896, 1, 136116657955, 14607996151,
    'd0992d56b09ea4c535240dbddc50f75f02eb1373', '7f546656d7771979928f743181ba8def5cf446de',
)


class Rejected(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def shape(data, keys, code):
    require(isinstance(data, dict) and data.keys() == set(keys.split()), code)


def matches(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def positive(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def digest(data):
    return hashlib.sha256(data).hexdigest()


def utc(value, pattern, code):
    require(matches(value, pattern), code)
    try:
        return datetime.fromisoformat(value[:-1]).replace(tzinfo=timezone.utc)
    except ValueError:
        raise Rejected(code) from None


def json_input(data, code):
    def unique(pairs):
        fields = dict(pairs)
        require(len(fields) == len(pairs), code)
        return fields

    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=unique, parse_constant=lambda _: require(False, code))
    except (ValueError, UnicodeError, RecursionError):
        raise Rejected(code) from None


def bytes_input(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'INPUT_FILE')
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    require(0 < len(data) <= limit, 'INPUT_FILE')
    return data


def expectation(args):
    expected = json_input(bytes_input(args.expect, 16_384), 'EXPECT_JSON')
    shape(expected, 'repository repositoryId runId runAttempt jobId artifactId checkout ref approvalSha256 scriptSha256 reportName', 'EXPECT')
    checkout = expected['checkout']
    shape(checkout, 'sha tree parents prHeadSha', 'EXPECT_CHECKOUT')
    require(expected['repositoryId'] == 1416660874 and
            matches(expected['repository'], r'dawanglaohu/(?i:nbshiyan)') and
            all(positive(expected[key]) for key in ('repositoryId', 'runId', 'runAttempt', 'jobId', 'artifactId')) and
            matches(expected['ref'], r'refs/pull/[1-9][0-9]*/merge') and
            matches(expected['reportName'], r'j4-[a-z0-9-]+\.json') and
            all(matches(expected[key], HEX64) for key in ('approvalSha256', 'scriptSha256')), 'EXPECT')
    parents = checkout['parents']
    require(all(matches(checkout[key], HEX40) for key in ('sha', 'tree', 'prHeadSha')) and
            isinstance(parents, list) and len(parents) == 2 and all(matches(parent, HEX40) for parent in parents) and
            len({checkout['sha'], *parents}) == 3 and parents[1] == checkout['prHeadSha'], 'EXPECT_CHECKOUT')
    if args.stage_replay:
        require(tuple(expected[key] for key in ('runId', 'runAttempt', 'jobId', 'artifactId')) +
                (checkout['sha'], checkout['tree']) == REPLAY, 'STAGE_REPLAY_IDENTITY')
    return expected


def index_unique(rows, key, code):
    require(isinstance(rows, list) and all(isinstance(row, dict) and isinstance(row.get(key), (str, int)) for row in rows), code)
    indexed = {row[key]: row for row in rows}
    require(len(indexed) == len(rows), code)
    return indexed


def read_platform(args, expected):
    run, jobs, artifact, commit = (json_input(bytes_input(path, 1_048_576), 'PLATFORM_JSON')
                                   for path in (args.run, args.jobs, args.artifact, args.checkout))
    repo_id = expected['repositoryId']
    run_id, attempt = expected['runId'], expected['runAttempt']
    checkout = expected['checkout']
    sha, head = checkout['sha'], checkout['prHeadSha']
    repository = run['repository']['full_name']
    require(isinstance(repository, str) and repository.casefold() == expected['repository'].casefold(), 'RUN')
    repo_api = f'https://api.github.com/repos/{repository}'
    require((run['id'], run['run_attempt'], run['name'], run['path'], run['workflow_id'],
             run['event'], run['head_sha'], run['status'], run['conclusion']) ==
            (run_id, attempt, WORKFLOW, WORKFLOW_PATH, WORKFLOW_ID, 'pull_request', head, 'completed', 'success') and
            all((run[key]['id'], run[key]['full_name'].casefold()) == (repo_id, repository.casefold())
                for key in ('repository', 'head_repository')), 'RUN')
    prs = index_unique(run['pull_requests'], 'number', 'RUN_PR')
    pr_number = int(expected['ref'].split('/')[2])
    require(pr_number in prs, 'RUN_PR')
    pr = prs[pr_number]
    require((pr['base']['sha'], pr['head']['sha']) == tuple(checkout['parents']) and
            pr['base']['repo']['id'] == pr['head']['repo']['id'] == repo_id, 'RUN_PR')
    require((commit['sha'], commit['tree']['sha'], [parent['sha'] for parent in commit['parents']], commit['url']) ==
            (sha, checkout['tree'], checkout['parents'], f'{repo_api}/git/commits/{sha}'), 'CHECKOUT')

    selected = index_unique(jobs['jobs'], 'name', 'JOBS')
    require(jobs['total_count'] == len(selected) and JOB in selected and
            len(index_unique(jobs['jobs'], 'id', 'JOBS')) == len(selected), 'JOBS')
    job = selected[JOB]
    require((job['id'], job['run_id'], job['run_attempt'], job['workflow_name'], job['head_sha'],
             job['status'], job['conclusion'], job['url'], job['run_url'], job['head_branch']) ==
            (expected['jobId'], run_id, attempt, WORKFLOW, head, 'completed', 'success',
             f"{repo_api}/actions/jobs/{expected['jobId']}", f'{repo_api}/actions/runs/{run_id}', run['head_branch']), 'JOB')
    job_start = utc(job['started_at'], UTC_SECOND, 'JOB_TIME')
    job_end = utc(job['completed_at'], UTC_SECOND, 'JOB_TIME') + timedelta(seconds=1)
    indexed = index_unique(job['steps'], 'name', 'STEPS')
    index_unique(job['steps'], 'number', 'STEPS')
    require(set(STEPS) <= indexed.keys(), 'STEPS')
    numbers = [indexed[name]['number'] for name in STEPS]
    require(all(positive(number) for number in numbers) and numbers == sorted(set(numbers)), 'STEPS')
    windows = {}
    previous_end = job_start
    for name in STEPS:
        step = indexed[name]
        require((step['status'], step['conclusion']) == ('completed', 'success'), 'STEPS')
        start = utc(step['started_at'], UTC_SECOND, 'STEPS_TIME')
        end = utc(step['completed_at'], UTC_SECOND, 'STEPS_TIME')
        require(previous_end <= start <= end < job_end, 'STEPS_TIME')
        windows[name] = (start, end + timedelta(seconds=1))
        previous_end = end

    member = artifact['workflow_run']
    artifact_id = expected['artifactId']
    require((artifact['id'], artifact['name'], artifact['url'], member['id'], member['repository_id'],
             member['head_repository_id'], member['head_sha'], member['head_branch']) ==
            (artifact_id, ARTIFACT, f'{repo_api}/actions/artifacts/{artifact_id}', run_id,
             repo_id, repo_id, head, run['head_branch']) and type(artifact['expired']) is bool and
            positive(artifact['size_in_bytes']) and matches(artifact['digest'], f'sha256:{HEX64}'), 'ARTIFACT')
    require(windows[UPLOAD][0] <= utc(artifact['created_at'], UTC_SECOND, 'ARTIFACT_TIME') < windows[UPLOAD][1],
            'ARTIFACT_TIME')
    return artifact, windows


def log_facts(data, expected, artifact, windows):
    try:
        lines = [LOG_LINE.fullmatch(line) for line in data.decode('utf-8').split('\n')]
    except UnicodeError:
        raise Rejected('LOG_FORMAT') from None
    entries = {}
    for line in filter(None, lines):
        job, step, timestamp, text = line.groups()
        if job == JOB and step in windows:
            entries.setdefault(step, []).append((timestamp, text.rstrip('\r')))

    def one(step, pattern, code):
        found = [(timestamp, re.fullmatch(pattern, text)) for timestamp, text in entries.get(step, ())]
        matching = [(timestamp, match) for timestamp, match in found if match is not None]
        require(len(matching) == 1, code)
        timestamp, match = matching[0]
        instant = utc(timestamp, r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z', code)
        require(windows[step][0] <= instant < windows[step][1], code)
        return match

    def setting(key, pattern):
        return one(J4, rf'  {key}: ({pattern})', 'LOG_IDENTITY')[1]

    checkout = expected['checkout']
    require(one(CHECKOUT, HEX40, 'LOG_CHECKOUT')[0] == checkout['sha'], 'LOG_CHECKOUT')
    ref = expected['ref'].removeprefix('refs/')
    one(CHECKOUT, rf' \* \[new ref\]\s+{checkout["sha"]} -> {re.escape(ref)}', 'LOG_CHECKOUT')
    require(setting('B4_PR_HEAD', HEX40) == checkout['prHeadSha'] and
            setting('B4_SUBJECT_COMMIT', HEX40) == checkout['sha'] and
            setting('B4_SUBJECT_TREE', HEX40) == checkout['tree'] and
            setting('B4_APPROVAL_SHA256', HEX64) == expected['approvalSha256'] and
            setting('J4_SCRIPT_SHA256', HEX64) == expected['scriptSha256'], 'LOG_IDENTITY')
    one(APPROVAL, r'/[^\r\n]+/approved-files\.sha256: OK', 'LOG_APPROVAL')
    one(GATE, 'J4_GATE_GREEN', 'LOG_GATE')
    uploaded_sha = one(UPLOAD, rf'SHA256 digest of uploaded artifact zip is ({HEX64})', 'LOG_UPLOAD')[1]
    finalize = one(UPLOAD, rf'Artifact {ARTIFACT}\.zip successfully finalized\. Artifact ID (\d+)', 'LOG_UPLOAD')[1]
    upload = one(UPLOAD, rf'Artifact {ARTIFACT} has been successfully uploaded! Final size is (\d+) bytes\. Artifact ID is (\d+)', 'LOG_UPLOAD')
    slug = re.escape(expected['repository'])
    url = one(UPLOAD, rf'Artifact download URL: https://github\.com/(?i:{slug})/actions/runs/(\d+)/artifacts/(\d+)', 'LOG_UPLOAD')
    require((uploaded_sha, finalize, upload[1], upload[2], url[1], url[2]) ==
            (artifact['digest'].removeprefix('sha256:'), str(artifact['id']), str(artifact['size_in_bytes']),
             str(artifact['id']), str(expected['runId']), str(artifact['id'])), 'LOG_UPLOAD')
    return setting('B4_STAGE_SHA', HEX64), setting('B4_TOOL_ID', HEX64)


def members_from_zip(data, artifact, report_name):
    require(len(data) == artifact['size_in_bytes'] and f'sha256:{digest(data)}' == artifact['digest'], 'ARCHIVE_DIGEST')
    names = {'cleanup.txt', 'exit-code.txt', 'binding.txt', 'source.receipt', 'unexpected-and-withheld.txt',
             'wrapper-phase.txt', report_name}
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            require(len(members) == len(names) and {item.filename for item in members} == names, 'ARCHIVE_MEMBERS')
            for item in members:
                require(item.orig_filename == item.filename and not item.is_dir() and
                        stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG) and
                        item.file_size <= 1_048_576 and item.flag_bits & 1 == 0, 'ARCHIVE_MEMBER')
            return {item.filename: archive.read(item) for item in members}
    except (EOFError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError, zlib.error):
        raise Rejected('ARCHIVE_FORMAT') from None


def read_binding(members, expected, stage_sha, image_id):
    require(members['cleanup.txt'] == b'ports_closed=true pg_stopped=true cluster_unchanged=true j4_exit=0 phase=complete\n' and
            members['exit-code.txt'] == b'j4=0\n' and members['wrapper-phase.txt'] == b'' and
            not any(line.startswith(b'withheld_') for line in members['unexpected-and-withheld.txt'].splitlines()), 'CLEANUP')
    binding = {}
    for line in members['binding.txt'].decode('ascii').splitlines():
        key, separator, value = line.partition('=')
        require(separator and value and key not in binding, 'BINDING')
        binding[key] = value
    shape(binding, 'source_commit source_tree build_id build_sha256 approval_sha256 script_sha256 tool_id pg_sha256 node_sha256 db_name pg_identity', 'BINDING')
    checkout = expected['checkout']
    require((binding['source_commit'], binding['source_tree'], binding['approval_sha256'], binding['script_sha256'], binding['tool_id']) ==
            (checkout['sha'], checkout['tree'], expected['approvalSha256'], expected['scriptSha256'], image_id) and
            matches(binding['build_id'], BUILD_ID) and
            all(matches(binding[key], HEX64) for key in ('build_sha256', 'pg_sha256', 'node_sha256')), 'BINDING_IDENTITY')
    source = members['source.receipt']
    fields = [checkout['sha'], checkout['tree'], binding['build_id'], binding['build_sha256'], 'test', expected['approvalSha256']]
    require(digest(source) == stage_sha and source == ('\n'.join(fields) + '\n').encode('ascii'), 'STAGE_RECEIPT')
    pg = re.fullmatch(rf'({DATABASE})\|(17[0-9]{{4}})\|127\.0\.0\.1\|55418\|cluster_sha256=({HEX64})', binding['pg_identity'])
    require(pg and pg[1] == binding['db_name'], 'PG_IDENTITY')
    return binding, {'database': pg[1], 'versionNum': int(pg[2]), 'host': '127.0.0.1', 'port': 55418, 'clusterSha256': pg[3]}


def interval(row, code):
    start = utc(row['startedAt'], UTC_MILLI, code)
    end = utc(row['endedAt'], UTC_MILLI, code)
    require(start <= end, code)
    return start, end


def settled(row, status, error):
    job = row['job']
    shape(job, 'key generationBefore generation status lastErrorCode succeededAt finishedAt leaseReleased', 'JOB_STATE')
    start, end = interval(row, 'REPORT_TIME')
    finish = utc(job['finishedAt'], UTC_MILLI, 'JOB_STATE')
    succeeded = utc(job['succeededAt'], UTC_MILLI, 'JOB_STATE')
    require(job['key'] == row['key'] and positive(job['generation']) and
            type(job['generationBefore']) is int and job['generationBefore'] == job['generation'] - 1 and
            job['status'] == status and job['lastErrorCode'] == error and job['leaseReleased'] is True and
            start <= finish <= end and ((succeeded == finish) if status == 'SUCCEEDED' else succeeded < start), 'JOB_STATE')
    return job


def read_operations(report, window):
    rows = index_unique(report['requests'], 'label', 'HTTP_ROWS')
    require(tuple(rows) == tuple(HTTP_ROWS), 'HTTP_ROWS')
    previous = window[0]
    for label, row in rows.items():
        require(tuple(row[key] for key in ('method', 'path', 'key', 'http')) == HTTP_ROWS[label], 'HTTP_ROWS')
        start, end = interval(row, 'REPORT_TIME')
        require(previous <= start <= end < window[1], 'REPORT_TIME')
        if 'finishedAt' in row:
            require(start <= utc(row['finishedAt'], UTC_MILLI, 'REPORT_TIME') <= end, 'REPORT_TIME')
        previous = end
    require(rows['missing-bearer']['error'] == 'unauthorized' and rows['unknown-key']['error'] == 'unknown_job', 'HTTP_ROWS')

    warm = settled(rows['aggregate'], 'SUCCEEDED', None)
    chat = settled(rows['chat'], 'SUCCEEDED', None)
    retention = settled(rows['retention-default'], 'SUCCEEDED', None)
    legacy = settled(rows['legacy-default'], 'SUCCEEDED', None)
    failure_row = rows['aggregate-conflict']
    failed = settled(failure_row, 'FAILED', 'version_conflict')
    require(rows['aggregate']['status'] == 'SUCCEEDED' and rows['chat']['status'] == 'SUCCEEDED' and
            rows['retention-default']['status'] == 'SUCCEEDED' and rows['legacy-default']['status'] == 'succeeded', 'HTTP_STATUS')
    require(failure_row['status'] == 'FAILED' and failure_row['counts'].keys() == {'candidateCount'} and
            type(failure_row['counts']['candidateCount']) is int and failure_row['counts']['candidateCount'] == 0 and
            failure_row['watermarkUnchanged'] is True and failed['succeededAt'] == warm['succeededAt'], 'PERSISTED_FAILURE')
    require(retention['generation'] == legacy['generationBefore'], 'DRY_RUN')
    generation = warm['generation']
    for label in ('retention-default', 'legacy-default'):
        row = rows[label]
        lease = row['sharedLease']
        require(row['mode'] == 'dry-run' and lease['generationBefore'] == generation and
                lease['generation'] == generation + 1 and lease['aggregateLastSucceededAt'] == warm['succeededAt'] and
                lease['watermarkUnchanged'] is True and type(lease['removedRows']) is int and lease['removedRows'] == 0, 'DRY_RUN')
        generation = lease['generation']
    require(rows['retention-default']['counts']['deletedCount'] == 0 and
            rows['legacy-default']['deletedEvents'] == rows['legacy-default']['deletedRollupRows'] == 0 and
            failed['generationBefore'] == generation, 'DRY_RUN')
    busy = []
    locks = set()
    for label in ('aggregate-busy', 'retention-busy', 'legacy-busy'):
        row = rows[label]
        lease = row['sharedLease']
        deadline = utc(lease['lockedUntil'], UTC_MILLI, 'BUSY')
        require(row['error'] == 'job_busy' and lease['key'] == AGGREGATE and lease['generation'] == generation and
                lease['ownerUnchanged'] is True and lease['watermarkUnchanged'] is True and
                interval(row, 'BUSY')[1] < deadline, 'BUSY')
        locks.add(deadline)
        busy.append({key: row[key] for key in ('label', 'method', 'path', 'key', 'http', 'error')})
    require(len(locks) == 1, 'BUSY')
    mail_generation = rows['chat']['outbox']['mailGeneration']
    require(positive(mail_generation), 'OTHER_KEYS')
    return busy, warm, failed, {RETENTION: legacy, CHAT: chat}, mail_generation


def other_keys(report, last_settled, mail_generation, conflict_start):
    indexed = index_unique(report.get('otherKeys'), 'key', 'OTHER_KEYS')
    require(indexed.keys() == set(OTHER_KEYS), 'OTHER_KEYS')
    result = []
    for key in OTHER_KEYS:
        row = indexed[key]
        shape(row, 'key generationBefore generationAfter statusBefore statusAfter lastSucceededAtBefore lastSucceededAtAfter', 'OTHER_KEYS')
        earlier = last_settled.get(key)
        generation = earlier['generation'] if earlier else mail_generation
        succeeded = utc(row['lastSucceededAtBefore'], UTC_MILLI, 'OTHER_KEYS')
        require(positive(row['generationBefore']) and positive(row['generationAfter']) and
                row['generationBefore'] == row['generationAfter'] == generation and
                row['statusBefore'] == row['statusAfter'] == 'SUCCEEDED' and
                row['lastSucceededAtBefore'] == row['lastSucceededAtAfter'] and succeeded < conflict_start and
                (earlier is None or row['lastSucceededAtBefore'] == earlier['succeededAt']), 'OTHER_KEYS')
        result.append(row)
    return result


def project(report, binding, pg, expected, window, replay):
    version = report['version']
    require(type(version) is int and version == (1 if replay else 2), 'REPORT_VERSION')
    keys = 'version pass stage cleanup identity config registrations dailyScheduleObserved listener requests'
    shape(report, keys if replay else keys + ' otherKeys', 'REPORT_SHAPE')
    identity = report['identity']
    shape(identity, 'sourceCommit sourceTree buildId buildSha256 scriptSha256 appEnv instance node pgVersionNum', 'REPORT_IDENTITY')
    require(tuple(identity[key] for key in ('sourceCommit', 'sourceTree', 'buildId', 'buildSha256', 'scriptSha256', 'appEnv', 'instance', 'pgVersionNum')) ==
            (binding['source_commit'], binding['source_tree'], binding['build_id'], binding['build_sha256'],
             binding['script_sha256'], 'test', pg['database'][-12:], pg['versionNum']) and matches(identity['node'], r'22\.\d+\.\d+'), 'REPORT_IDENTITY')
    require(report['pass'] is True and report['stage'] == 'complete' and
            report['config'] == {'chatChannel': 'disabled', 'retentionDeleteAllowed': False, 'trigger': 'manual-http'} and
            report['config']['retentionDeleteAllowed'] is False and
            report['cleanup'].keys() == {'fixtureLeaseReleased', 'appStopped', 'dbDisconnected'} and
            all(value is True for value in report['cleanup'].values()) and
            report['listener']['port'] == 3114 and positive(report['listener']['pid']), 'REPORT_STATE')
    require(report['registrations'] == REGISTRATIONS and report['dailyScheduleObserved'] is False, 'SCHEDULE')
    busy, warm, failed, last_settled, mail_generation = read_operations(report, window)
    result = {
        'schema': 'j4-attribution-stage-replay/1' if replay else 'j4-attribution/1',
        'sameInstance': False,
        'runId': expected['runId'], 'runAttempt': expected['runAttempt'], 'jobId': expected['jobId'],
        'workflow': WORKFLOW, 'job': JOB, 'repositoryId': expected['repositoryId'], 'ref': expected['ref'],
        'checkout': expected['checkout'], 'approvalSha256': expected['approvalSha256'],
        'buildId': binding['build_id'], 'standaloneTreeSha256': binding['build_sha256'],
        'scriptSha256': expected['scriptSha256'], 'runtimeImageId': binding['tool_id'], 'pg': pg,
        'busy': busy,
        'failedKey': failed['key'], 'errorCode': failed['lastErrorCode'], 'failedStatus': failed['status'],
        'failure': {'http': 200, 'candidateCount': 0, 'generationBefore': failed['generationBefore'],
                    'generationAfter': failed['generation'], 'lastSucceededAt': warm['succeededAt'],
                    'lastFinishedAt': failed['finishedAt'], 'leaseReleased': True, 'watermarkUnchanged': True},
        'registrations': report['registrations'], 'dailyScheduleObserved': False,
    }
    if replay:
        result['otherKeysObservation'] = {
            'gap': 'no-per-key-conflict-window',
            'priorSettled': [{'key': key, 'generation': value['generation'], 'status': value['status'],
                              'lastSucceededAt': value['succeededAt']} for key, value in last_settled.items()],
            'priorMailGeneration': mail_generation,
        }
    else:
        conflict_start = interval(report['requests'][-1], 'REPORT_TIME')[0]
        result['otherKeys'] = other_keys(report, last_settled, mail_generation, conflict_start)
    return result


def admit(args):
    expected = expectation(args)
    artifact, windows = read_platform(args, expected)
    log = bytes_input(args.job_log, 8_388_608)
    stage_sha, image_id = log_facts(log, expected, artifact, windows)
    archive = bytes_input(args.zip, 2_097_152)
    report_name = expected['reportName']
    members = members_from_zip(archive, artifact, report_name)
    binding, pg = read_binding(members, expected, stage_sha, image_id)
    report = json_input(members[report_name], 'REPORT_JSON')
    result = project(report, binding, pg, expected, windows[J4], args.stage_replay)
    result['artifact'] = {'id': artifact['id'], 'name': ARTIFACT, 'zipSha256': digest(archive),
                          'reportSha256': digest(members[report_name]), 'stageReceiptSha256': stage_sha}
    return (json.dumps(result, indent=2, ensure_ascii=True) + '\n').encode('ascii')


def main():
    parser = argparse.ArgumentParser()
    for name in ('expect', 'run', 'jobs', 'checkout', 'artifact', 'zip', 'job-log', 'out'):
        parser.add_argument(f'--{name}', type=Path, required=True)
    parser.add_argument('--stage-replay', action='store_true', help='Replay the fixed stage V1 artifact with a distinct output schema')
    args = parser.parse_args()
    try:
        result = admit(args)
        with tempfile.TemporaryDirectory(dir=args.out.parent) as staging:
            temporary = Path(staging) / 'receipt.json'
            temporary.write_bytes(result)
            os.link(temporary, args.out)
    except Rejected as exc:
        print(f'J4_ADMISSION_{exc}', file=sys.stderr)
        return 1
    except OSError:
        print('J4_ADMISSION_IO', file=sys.stderr)
        return 1
    except (AttributeError, KeyError, OverflowError, TypeError, ValueError):
        print('J4_ADMISSION_INPUT_SHAPE', file=sys.stderr)
        return 1
    print('J4_ADMISSION_STAGE_REPLAY_OK' if args.stage_replay else 'J4_ADMISSION_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
