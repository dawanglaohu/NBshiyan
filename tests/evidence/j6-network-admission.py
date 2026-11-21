#!/usr/bin/env python3
"""Replay the three-member J6 admission using independently sourced inputs."""
import argparse
from datetime import datetime, timedelta
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
import zipfile
import zlib


SPEC = 'e2e/j6-frontend-seam-evidence.spec.ts'
CHECKER = 'tests/evidence/j6-check-evidence.cjs'
BUILD_ID = 'standalone/.next/BUILD_ID'
SERVER = 'standalone/server.js'
PINS = {
    SPEC: '68c212158889ded53d2ec183d262e64a734558ee2d917348e4582d505a3be514',
    CHECKER: '1bee734a87ddb952f023c526f94ba4ef3c1cc898dc4e86d3bd090e8d72fca362',
}
REPLAY_CHECKER_SHA = '8298c8ea447c5cdafe10ab270ee99749adce838f4361a76c3778d9c07dc907d9'
WORKFLOW = '.github/workflows/ci.yml'
WIRING_SHA = '93262480500bdce24266bb042d24ca5d47f0041c8e6588141dc3f994a3b3cd91'
BUILD_STEP_SHA = '369cecafd4845365eba0e55fb4c529ad1b8ed1e0294ef6d75c23f5385b28572c'
BRIDGE_WIRING_SHA = 'b154752a4f2550b5c466c8ad303ba367009302c6887565add8ad9d5f49a59555'
DIAGNOSTIC_WIRING_SHA = '9872bbeabed838b8bc45afd57bc754bc295bc9ebc0386fab80f68e68a195f705'
BRIDGE_BUILD_STEP_SHA = 'f9d09773928ab01d9c051eb1d4f002f56af08fcb8f25360eec621bda95a87448'
CHECKOUT_COMMAND = '[command]/usr/bin/git log -1 --format=%H'
CHECKOUT = 'Run actions/checkout@v4'
BUILD = 'Build e2e standalone and verify test identity'
CAPTURE = 'J6 front-end seam evidence (opt-in, post-A3-summary)'
UPLOAD = 'Upload J6 admitted seam evidence'
STEPS = (CHECKOUT, BUILD, CAPTURE, UPLOAD)
REPOSITORY = 'dawanglaohu/NBShiyan'
REPOSITORY_ID = 1416660874
HEX40 = r'[0-9a-f]{40}'
HEX64 = r'[0-9a-f]{64}'
BUILD_PATTERN = r'[A-Za-z0-9_-]{1,64}'
UTC = r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
JSON_MAX = 1_048_576
MEMBERS = ('RUN.json', 'CHECK-EVIDENCE.json', 'RUNNER-RECEIPT.json')


class Reject(Exception):
    pass


def need(condition, code):
    if not condition:
        raise Reject(code)


def match(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def positive(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def digest(data):
    return sha256(data).hexdigest()


def read(path, bound):
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= bound, 'INPUT_FILE')
    with path.open('rb') as stream:
        data = stream.read(bound + 1)
    need(0 < len(data) <= bound, 'INPUT_FILE')
    return data


def parse(data, code):
    def unique(pairs):
        result = dict(pairs)
        need(len(result) == len(pairs), code)
        return result

    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=unique, parse_constant=lambda _: need(False, code))
    except (ValueError, RecursionError):
        raise Reject(code) from None


def stable(data):
    return json.dumps(data, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False)


def same(actual, expected):
    return stable(actual) == stable(expected)


def index(records, key, code):
    need(isinstance(records, list) and all(isinstance(row, dict) and key in row for row in records), code)
    result = {row[key]: row for row in records}
    need(len(result) == len(records), code)
    return result


def time(value, precision, code):
    need(match(value, UTC + precision + 'Z'), code)
    try:
        return datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        raise Reject(code) from None


def expect(document, authenticated=False):
    keys = {'runId', 'runAttempt', 'jobId', 'artifactId', 'checkout', 'ref'}
    if authenticated:
        need(match(document.get('jobLogSha256'), HEX64), 'LOG_DIGEST')
        keys.add('jobLogSha256')
    need(set(document) == keys
         and all(positive(document[key]) for key in ('runId', 'runAttempt', 'jobId', 'artifactId'))
         and document['runAttempt'] < 1_000_000 and match(document['ref'], r'refs/pull/[1-9][0-9]*/merge'), 'EXPECT')
    checkout = document['checkout']
    need(set(checkout) == {'sha', 'tree', 'parents', 'prHeadSha'}
         and all(match(checkout[key], HEX40) for key in ('sha', 'tree', 'prHeadSha'))
         and isinstance(checkout['parents'], list) and len(checkout['parents']) == 2
         and all(match(parent, HEX40) for parent in checkout['parents'])
         and len({checkout['sha'], *checkout['parents']}) == 3 and checkout['parents'][1] == checkout['prHeadSha'], 'CHECKOUT')
    return document


def platform(folder, expected):
    run, jobs, commit, artifacts, artifact = (parse(read(folder / name, JSON_MAX), 'PLATFORM_JSON') for name in
        ('run.json', 'jobs.json', 'checkout.json', 'artifacts.json', 'artifact.json'))
    run_id, attempt, job_id, artifact_id = (expected[key] for key in ('runId', 'runAttempt', 'jobId', 'artifactId'))
    head = expected['checkout']['prHeadSha']
    repo = run['repository']['full_name']
    need(isinstance(repo, str) and repo.casefold() == REPOSITORY.casefold(), 'RUN')
    repo_api = f'https://api.github.com/repos/{repo}'
    run_context = [run['id'], run['run_attempt'], run['name'], run['path'], run['event'], run['head_sha'], run['status']]
    need(same(run_context, [run_id, attempt, 'CI', WORKFLOW, 'pull_request', head, 'completed'])
         and all(same([run[key]['id'], run[key]['full_name'].casefold()], [REPOSITORY_ID, repo.casefold()])
                 for key in ('repository', 'head_repository')), 'RUN')
    pr = index(run['pull_requests'], 'number', 'RUN_PR').get(int(expected['ref'].split('/')[2]))
    checkout = expected['checkout']
    need(pr and [pr['base']['sha'], pr['head']['sha']] == checkout['parents']
         and same([pr['base']['repo']['id'], pr['head']['repo']['id']], [REPOSITORY_ID, REPOSITORY_ID]), 'RUN_PR')
    need([commit['sha'], commit['tree']['sha'], [r['sha'] for r in commit['parents']], commit['url']]
         == [checkout['sha'], checkout['tree'], checkout['parents'], f'{repo_api}/git/commits/{checkout["sha"]}'], 'CHECKOUT')
    selected = [job for job in index(jobs['jobs'], 'id', 'JOB').values() if job['name'] == 'e2e']
    need(len(selected) == 1 and same(jobs['total_count'], len(jobs['jobs'])), 'JOB')
    job = selected[0]
    need(same([job[key] for key in ('id', 'run_id', 'run_attempt', 'workflow_name', 'head_sha', 'head_branch',
                                   'status', 'conclusion', 'url', 'run_url')],
              [job_id, run_id, attempt, 'CI', head, run['head_branch'], 'completed', 'success',
               f'{repo_api}/actions/jobs/{job_id}', f'{repo_api}/actions/runs/{run_id}']), 'JOB')
    named = {name: [step for step in index(job['steps'], 'number', 'STEPS').values() if step['name'] == name] for name in STEPS}
    need(all(len(rows) == 1 for rows in named.values()), 'STEPS')
    ordered = [named[name][0] for name in STEPS]
    numbers = [row['number'] for row in ordered]
    need(all(positive(n) for n in numbers) and numbers == sorted(set(numbers)), 'STEPS')
    windows = {}
    previous = time(job['started_at'], '', 'STEPS_TIME')
    job_end = time(job['completed_at'], '', 'STEPS_TIME')
    for step in ordered:
        start = time(step['started_at'], '', 'STEPS_TIME')
        end = time(step['completed_at'], '', 'STEPS_TIME')
        need(step['status'] == 'completed' and step['conclusion'] == 'success' and previous <= start <= end <= job_end, 'STEPS')
        windows[step['name']] = (start, end + timedelta(seconds=1))
        previous = end
    context = artifact['workflow_run']
    artifact_name = f'j6-evidence-{run_id}-{attempt}'
    need(same([artifact['id'], artifact['name'], artifact['url'], artifact['expired'], context['id'],
               context['repository_id'], context['head_repository_id'], context['head_sha'], context['head_branch']],
              [artifact_id, artifact_name, f'{repo_api}/actions/artifacts/{artifact_id}', False, run_id,
               REPOSITORY_ID, REPOSITORY_ID, head, run['head_branch']])
         and positive(artifact['size_in_bytes']) and match(artifact['digest'], 'sha256:' + HEX64), 'ARTIFACT')
    published = [row for row in index(artifacts['artifacts'], 'id', 'ARTIFACT_LIST').values() if row['name'] == artifact_name]
    listed_fields = ('id', 'name', 'size_in_bytes', 'digest', 'expired', 'created_at')
    need(len(published) == 1 and same(artifacts['total_count'], len(artifacts['artifacts']))
         and same([published[0][key] for key in listed_fields], [artifact[key] for key in listed_fields]), 'ARTIFACT_LIST')
    need(windows[UPLOAD][0] <= time(artifact['created_at'], '', 'ARTIFACT_TIME') < windows[UPLOAD][1], 'ARTIFACT_TIME')
    return artifact, windows


def log_identity(raw, expected, artifact, windows, authenticated):
    rows = {step: [] for step in STEPS}
    observations = []
    for number, line in enumerate(raw.decode('utf-8-sig').splitlines()):
        parts = line.split('\t', 2)
        if len(parts) == 3 and parts[0] == 'e2e' and parts[1] in rows:
            stamp, _, message = parts[2].partition(' ')
            rows[parts[1]].append((number, stamp.removeprefix('\ufeff'), message))

    def one(step, pattern, code):
        found = [(number, stamp, matched) for number, stamp, message in rows[step]
                 if (matched := re.fullmatch(pattern, message)) is not None]
        need(len(found) == 1, code)
        number, stamp, value = found[0]
        need(windows[step][0] <= time(stamp, r'\.[0-9]{7}', code) < windows[step][1], code)
        observations.append((number, stamp))
        return value

    def marker(step, name, fields, code):
        need(sum(message == name or message.startswith(name + ' ') for _, _, message in rows[step]) == 1, code)
        return one(step, name + ' ' + fields, code)

    sha = expected['checkout']['sha']
    ref = expected['ref'].removeprefix('refs/')
    fetched = one(CHECKOUT, rf' \* \[new ref\]\s+({HEX40}) -> {re.escape(ref)}', 'LOG_CHECKOUT')
    need(fetched[1] == sha, 'LOG_CHECKOUT')
    source = pg = pg_stamp = None
    if authenticated:
        one(CHECKOUT, re.escape(CHECKOUT_COMMAND), 'LOG_CHECKOUT')
    need(one(CHECKOUT, HEX40, 'LOG_CHECKOUT')[0] == sha, 'LOG_CHECKOUT')
    if authenticated:
        need(observations[-2][0] + 1 == observations[-1][0], 'LOG_CHECKOUT')
        source = marker(BUILD, 'E2E_TEST_BUILD_SOURCE', rf'root_build_id=({BUILD_PATTERN}) standalone_build_id=({BUILD_PATTERN}) '
                        rf'server_js_bytes=([1-9][0-9]{{0,15}}) server_js_sha256=({HEX64})', 'LOG_BUILD')
    build = marker(BUILD, 'E2E_TEST_BUILD_OK', rf'build_id=({BUILD_PATTERN}) server_js_sha256=({HEX64})', 'LOG_BUILD')
    if authenticated:
        need(source[1] == source[2] == build[1] and source[4] == build[2] and positive(int(source[3])), 'LOG_BUILD')
        database = f'b10_j6_seam_{expected["runId"]}_{expected["runAttempt"]}'
        service = marker(CAPTURE, 'J6_PG_SERVICE', rf'container_id=({HEX64}) database={database} '
                         r'server_version_num=(17[0-9]{4}) cluster_sha256=([0-9A-F]{64})', 'PG_ANCHOR')
        pg = {'containerId': service[1], 'database': database, 'serverVersionNum': int(service[2]), 'clusterSha256': service[3]}
        pg_stamp = observations[-1][1]
    name = re.escape(artifact['name'])
    sha_zip = one(UPLOAD, rf'SHA256 digest of uploaded artifact zip is ({HEX64})', 'LOG_UPLOAD')[1]
    final = one(UPLOAD, rf'Artifact {name}\.zip successfully finalized\. Artifact ID ([0-9]+)', 'LOG_UPLOAD')[1]
    size, art_id = one(UPLOAD, rf'Artifact {name} has been successfully uploaded! Final size is ([0-9]+) bytes\. Artifact ID is ([0-9]+)', 'LOG_UPLOAD').groups()
    slug = re.escape(REPOSITORY)
    download = one(UPLOAD, rf'Artifact download URL: https://github\.com/(?i:{slug})/actions/runs/([0-9]+)/artifacts/([0-9]+)', 'LOG_UPLOAD')
    need([sha_zip, final, size, art_id, *download.groups()] == [artifact['digest'][7:], str(artifact['id']),
         str(artifact['size_in_bytes']), str(artifact['id']), str(expected['runId']), str(artifact['id'])], 'LOG_UPLOAD')
    identity = {'buildId': build[1], 'serverJsSha256': build[2]}
    if authenticated:
        lines, stamps = zip(*observations)
        need(list(lines) == sorted(set(lines)) and list(stamps) == sorted(stamps), 'LOG_ORDER')
        identity.update(rootBuildId=source[1], standaloneBuildId=source[2], serverJsBytes=int(source[3]))
    return identity, pg, pg_stamp


def archive_members(raw, artifact):
    need(len(raw) == artifact['size_in_bytes'] and digest(raw) == artifact['digest'][7:], 'ZIP_DIGEST')
    try:
        with zipfile.ZipFile(BytesIO(raw)) as bundle:
            entries = bundle.infolist()
            need(len(entries) == len(MEMBERS) and {entry.filename for entry in entries} == set(MEMBERS), 'ZIP_MEMBERS')
            for entry in entries:
                need(entry.filename == entry.orig_filename and not entry.is_dir() and entry.flag_bits & 1 == 0
                     and stat.S_IFMT(entry.external_attr >> 16) in (0, stat.S_IFREG)
                     and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                     and 0 < entry.file_size <= JSON_MAX, 'ZIP_MEMBERS')
            return {entry.filename: bundle.read(entry) for entry in entries}
    except (zipfile.BadZipFile, zlib.error, RuntimeError, NotImplementedError, EOFError):
        raise Reject('ZIP_MEMBERS') from None


def pg_identity(data, expected):
    name = f'b10_j6_seam_{expected["runId"]}_{expected["runAttempt"]}'
    result = re.fullmatch(rf'database={name}\nserver_version_num=(17[0-9]{{4}})\ncluster_sha256=([0-9A-F]{{64}})\n', data.decode('ascii'))
    need(result is not None, 'PG_ANCHOR')
    return {'database': name, 'serverVersionNum': int(result[1]), 'clusterSha256': result[2]}


class GitCheckout:
    def __init__(self, repo, checkout):
        self.repo = repo
        self.sha = checkout['sha']
        self.env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_NO_LAZY_FETCH='1')
        raw = self.git('cat-file', 'commit', self.sha).partition(b'\n\n')[0]
        need(re.findall(rb'(?m)^tree ([0-9a-f]{40})$', raw) == [checkout['tree'].encode()]
             and re.findall(rb'(?m)^parent ([0-9a-f]{40})$', raw) == [value.encode() for value in checkout['parents']], 'GIT_CHECKOUT')

    def git(self, *flags):
        result = subprocess.run(['git', '--no-replace-objects', '-C', str(self.repo), *flags],
                                env=self.env, capture_output=True, timeout=10)
        need(result.returncode == 0, 'GIT_CHECKOUT')
        return result.stdout

    def blob(self, path, bound=JSON_MAX):
        row = self.git('ls-tree', '-z', self.sha, '--', path)
        oid = re.fullmatch(rb'100(?:644|755) blob ([0-9a-f]{40})\t' + re.escape(path.encode()) + b'\0', row)
        need(oid is not None, 'GIT_BLOB')
        size = int(self.git('cat-file', '-s', oid[1].decode()))
        need(0 < size <= bound, 'GIT_BLOB')
        data = self.git('cat-file', 'blob', oid[1].decode())
        need(len(data) == size, 'GIT_BLOB')
        return data


def checker_source(git, authenticated=False):
    workflow = git.blob(WORKFLOW)
    steps = rb'(?ms)^  e2e:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)'
    section = re.findall(steps, workflow)
    need(len(section) == 1, 'WIRING')
    if authenticated:
        checkout_steps = re.findall(rb'(?m)^      - uses: actions/checkout@v4\n(?:^(?: {8,}[^\n]*|)\n)*', section[0])
        need(len(checkout_steps) == 1 and checkout_steps[0].rstrip(b'\n') ==
             b'      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0', 'CHECKOUT_STEP')
    for step in (BUILD, CAPTURE, UPLOAD):
        need(len(re.findall(rb'(?m)^      - name: ' + re.escape(step.encode()) + rb'$', section[0])) == 1, 'WIRING')
    build = re.search(rb'(?m)^      - name: ' + re.escape(BUILD.encode()) + rb'\n(?:^(?: {8,}[^\n]*|)\n)*', section[0])
    build_pin = BRIDGE_BUILD_STEP_SHA if authenticated else BUILD_STEP_SHA
    need(build is not None and digest(build[0].rstrip(b'\n') + b'\n') == build_pin, 'BUILD_STEP')
    begin = section[0].find(f'      - name: {CAPTURE}\n'.encode())
    marker = b'          if-no-files-found: error\n'
    end = section[0].find(marker, section[0].find(f'      - name: {UPLOAD}\n'.encode()))
    need(0 <= begin < end, 'WIRING')
    block = section[0][begin:end + len(marker)]
    pins = re.findall(rb'(?m)^          J6_(SPEC|CHECKER)_SHA256: ([0-9a-fA-F]{64})$', block)
    allowed_checkers = (PINS[CHECKER], REPLAY_CHECKER_SHA) if authenticated else (PINS[CHECKER],)
    need([name for name, _ in pins] == [b'SPEC', b'CHECKER'] and pins[0][1].decode().lower() == PINS[SPEC]
         and pins[1][1].decode().lower() in allowed_checkers, 'PINS')
    normalized = re.sub(rb'(?m)^(          J6_(?:SPEC|CHECKER)_SHA256: )[^\n]+$', rb'\1<PIN>', block)
    wiring_pins = (BRIDGE_WIRING_SHA, DIAGNOSTIC_WIRING_SHA) if authenticated else (WIRING_SHA,)
    need(digest(normalized) in wiring_pins, 'WIRING')
    sources = {name: git.blob(name) for name in PINS}
    need([digest(sources[name]) for name in PINS] == [value.decode().lower() for _, value in pins], 'PINS')
    return sources


def verify_network(data):
    need(isinstance(data, dict) and set(data) == {'sameOriginFulfilled', 'sameOriginAborted', 'serviceWorker', 'intercepted'}
         and all(type(data[key]) is int and data[key] == 0 for key in ('sameOriginFulfilled', 'sameOriginAborted'))
         and data['serviceWorker'] is False and type(data['intercepted']) is list and not data['intercepted'], 'NETWORK')
    return data


def materialize_build(root, build_dir, build):
    build_files = {'BUILD_ID': read(build_dir / 'BUILD_ID', 256), BUILD_ID: read(build_dir / BUILD_ID, 256),
                   SERVER: read(build_dir / SERVER, JSON_MAX)}
    need(all(build_files[name].decode('ascii').strip() == build['buildId'] for name in ('BUILD_ID', BUILD_ID))
         and digest(build_files[SERVER]) == build['serverJsSha256'], 'BUILD_BYTES')
    for name, data in build_files.items():
        write(root / '.next' / name, data)


def materialize_sources(git, root, pinned, original):
    source_pattern = rb"(?m)^  '([a-zA-Z0-9_./-]+)',$"
    source_section = re.search(rb'(?ms)^const REQUIRED_SOURCES = \[\n(.*?)^\];$', pinned[CHECKER])
    need(source_section is not None, 'PINS')
    paths = {value.decode() for value in re.findall(source_pattern, source_section[1])}
    entries = index(original['sources'], 'path', 'SOURCES')
    need(set(entries) == paths, 'SOURCES')
    for name in sorted(paths):
        content = pinned[name] if name in pinned else git.blob(name)
        need(same(entries[name], {'path': name, 'sha256': digest(content).upper()}), 'SOURCES')
        write(root / name, content)
    paths = set()
    for fact in original['evidence']['glb']['facts']:
        path = fact['path']
        need(match(path, r'/(?:models/[a-zA-Z0-9_.-]+\.glb|api/models/[a-z0-9]{20,40}/glb)'), 'GLB_PATH')
        if path.startswith('/models/') and fact['status'] == 200:
            paths.add('public' + path)
    need(len(paths) <= 16, 'GLB_PATH')
    for name in sorted(paths):
        write(root / name, git.blob(name, 20 * 1024 * 1024))
    write(root / CHECKER, pinned[CHECKER])


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def metadata(name, data):
    return {'file': name, 'bytes': len(data), 'sha256': digest(data).upper()}


def replay_authenticated(repo, run_dir, original, check, receipt, raw, expected, runner, pg, build, pinned, node_env):
    checker = read(Path(__file__).resolve().with_name(Path(CHECKER).name), JSON_MAX)
    need(digest(checker) == REPLAY_CHECKER_SHA, 'REPLAY_PIN')
    write(repo / CHECKER, checker)
    context = {'repo': str(repo), 'runDir': str(run_dir), 'specPath': str(repo / SPEC),
               'expectSha': expected['checkout']['sha'], 'expectTree': expected['checkout']['tree'],
               'expectBuildId': build['buildId'], 'expectRun': runner['runId'], 'expectAttempt': runner['runAttempt'],
               'expectJob': runner['job'], 'expectWorkflow': runner['workflow'], 'expectRef': runner['ref'],
               'expectPgDatabase': pg['database'], 'expectPgVersion': str(pg['serverVersionNum']),
               'expectPgCluster': pg['clusterSha256']}
    program = """const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const checker = require('./tests/evidence/j6-check-evidence.cjs');
process.stdout.write(JSON.stringify(checker.replayForAdmission(input.run, input.context, input.build)));
"""
    data = stable({'run': {**original, 'root': str(run_dir)}, 'context': context, 'build': build}).encode()
    result = subprocess.run(['node', '-e', program], input=data, cwd=repo, env=node_env, capture_output=True, timeout=30)
    need(result.returncode == 0 and not result.stderr, 'CHECKER_REJECTED')
    computed = parse(result.stdout, 'CHECK_REPLAY')
    need(computed.pop('buildBasis', None) == 'authenticated-build-step' and computed['ok'] is True
         and computed['errors'] == [], 'CHECKER_REJECTED')
    need(same(computed, {**check, 'run': str(run_dir)}), 'CHECK_REPLAY')
    expected_receipt = {
        'schema': 'j6-runner-receipt/1', 'runner': computed['facts']['runner'],
        'head': context['expectSha'], 'tree': context['expectTree'], 'buildId': build['buildId'],
        'pg': computed['facts']['pg'],
        'checker': {'file': Path(CHECKER).name, 'sha256': digest(pinned[CHECKER]).upper()},
        'run': metadata(MEMBERS[0], raw[MEMBERS[0]]), 'check': metadata(MEMBERS[1], raw[MEMBERS[1]]),
        'spec': {'sha256': computed['facts']['spec']}, 'verdict': 'PASS', 'receiptAt': receipt['receiptAt'],
    }
    need(same(receipt, expected_receipt) and same(computed['facts']['pg'], pg), 'RECEIPT_REPLAY')
    return computed


def replay(args, scratch, raw, expected, artifact, windows, pg, build, git, pinned, pg_marker, pg_stamp):
    original, check, receipt = (parse(raw[name], 'MEMBER_JSON') for name in MEMBERS)
    host_root = original['root']
    suffix = f'j6-{expected["runId"]}-{expected["runAttempt"]}/run'
    need(match(host_root, r'/[a-zA-Z0-9_. /-]{1,512}') and PurePosixPath(host_root).as_posix() == host_root
         and '..' not in PurePosixPath(host_root).parts and host_root.endswith('/' + suffix) and check['run'] == host_root, 'RUN_ROOT')
    checkout = expected['checkout']
    runner = {'runId': str(expected['runId']), 'runAttempt': str(expected['runAttempt']), 'job': 'e2e', 'workflow': 'CI',
              'ref': expected['ref'], 'source': 'github'}
    identity = original['identity']
    need([identity[key] for key in ('head', 'tree', 'githubSha', 'buildId', 'buildIdPath', 'serverEntry')]
         == [checkout['sha'], checkout['tree'], checkout['sha'], build['buildId'], '.next/' + BUILD_ID, '.next/' + SERVER]
         and same(identity['runner'], runner), 'RUN_IDENTITY')
    need(same(original['evidence']['db']['pg'], pg), 'PG_IDENTITY')
    before = time(original['startedAt'], r'\.[0-9]{3}', 'RUN_TIME')
    after = time(original['finishedAt'], r'\.[0-9]{3}', 'RUN_TIME')
    issued = time(receipt['receiptAt'], r'\.[0-9]{3}', 'RECEIPT_TIME')
    need(windows[CAPTURE][0] <= before <= after <= issued < windows[CAPTURE][1], 'RUN_TIME')
    if pg_stamp is not None:
        need(receipt['receiptAt'][:-1] + '0000Z' <= pg_stamp, 'PG_ORDER')
    need(same(receipt.get('run'), metadata(MEMBERS[0], raw[MEMBERS[0]]))
         and same(receipt.get('check'), metadata(MEMBERS[1], raw[MEMBERS[1]])), 'MEMBER_DIGEST')
    need(receipt.get('checker') == {'file': Path(CHECKER).name, 'sha256': digest(pinned[CHECKER]).upper()}
         and receipt.get('spec') == {'sha256': PINS[SPEC].upper()}, 'PINS')
    net = verify_network(original['evidence']['network'])
    verify_network(check['facts']['network'])
    repo = scratch / 'repo'
    if not args.authenticated_build_identity:
        materialize_build(repo, args.build_root, build)
    materialize_sources(git, repo, pinned, original)
    run_dir = scratch / 'run'
    node_env = {k: v for k, v in os.environ.items() if k.upper() not in {'NODE_OPTIONS', 'NODE_PATH'}}
    if args.authenticated_build_identity:
        computed = replay_authenticated(repo, run_dir, original, check, receipt, raw, expected, runner, pg, build, pinned, node_env)
    else:
        projected_run = {**original, 'root': str(run_dir)}
        replay_run = (stable(projected_run) + '\n').encode()
        write(run_dir / MEMBERS[0], replay_run)
        command = ['node', str(repo / CHECKER), '--run', str(run_dir), '--repo', str(repo), '--spec', str(repo / SPEC),
                   '--expect-sha', checkout['sha'], '--expect-tree', checkout['tree'], '--expect-build-id', build['buildId'],
                   '--expect-run', runner['runId'], '--expect-attempt', runner['runAttempt'], '--expect-job', runner['job'],
                   '--expect-workflow', runner['workflow'], '--expect-ref', runner['ref'], '--expect-pg-database', pg['database'],
                   '--expect-pg-version', str(pg['serverVersionNum']), '--expect-pg-cluster', pg['clusterSha256'],
                   '--out', str(run_dir / MEMBERS[1]), '--receipt', str(run_dir / MEMBERS[2])]
        result = subprocess.run(command, cwd=repo, env=node_env, capture_output=True, timeout=30)
        need(result.returncode == 0 and not result.stderr, 'CHECKER_REJECTED')
        replay_check = read(run_dir / MEMBERS[1], JSON_MAX)
        computed = parse(replay_check, 'CHECK_REPLAY')
        need(result.stdout == replay_check and computed['ok'] is True and computed['errors'] == []
             and same(computed, {**check, 'run': str(run_dir)}), 'CHECK_REPLAY')
        computed_receipt = parse(read(run_dir / MEMBERS[2], JSON_MAX), 'RECEIPT_REPLAY')
        generated_time = computed_receipt['receiptAt']
        time(generated_time, r'\.[0-9]{3}', 'RECEIPT_REPLAY')
        need(computed_receipt['verdict'] == 'PASS' and same(computed_receipt['pg'], pg)
             and same(computed_receipt, {**receipt, 'receiptAt': generated_time, 'run': metadata(MEMBERS[0], replay_run),
                                         'check': metadata(MEMBERS[1], replay_check)}), 'RECEIPT_REPLAY')
    observed = verify_network(computed['facts']['network'])
    need(same(observed, net), 'NETWORK')
    return {
        'schema': 'j6-network-admission/1', 'formalQualified': False, 'source': 'fixture-replay',
        'runner': {**runner, 'repositoryId': REPOSITORY_ID, 'jobId': expected['jobId']},
        'checkout': checkout, 'build': build, 'pg': pg,
        **({'buildBasis': 'authenticated-build-step', 'pgContainerId': pg_marker['containerId'],
            'jobLogSha256': expected['jobLogSha256']} if args.authenticated_build_identity else {}),
        'artifact': {'id': artifact['id'], 'name': artifact['name'], 'zipSha256': artifact['digest'][7:],
                     'members': {name: digest(raw[name]) for name in MEMBERS}},
        'network': observed,
    }


def verify(args, scratch):
    inputs = args.input
    authenticated = args.authenticated_build_identity
    expected_path = inputs / 'expect.json'
    if authenticated:
        expected_path = args.trusted_expect
        need(not expected_path.resolve().is_relative_to(inputs.resolve()), 'EXPECT_SOURCE')
    expected = expect(parse(read(expected_path, 16384), 'EXPECT'), authenticated)
    artifact, windows = platform(inputs, expected)
    log = read(inputs / 'job.log', 16 * 1024 * 1024)
    if authenticated:
        need(digest(log) == expected['jobLogSha256'], 'LOG_DIGEST')
    build, pg_marker, pg_stamp = log_identity(log, expected, artifact, windows, authenticated)
    raw = archive_members(read(inputs / 'artifact.zip', 4 * JSON_MAX), artifact)
    pg_file = inputs / 'pg-identity.txt'
    if authenticated:
        need(not pg_file.exists() and not pg_file.is_symlink(), 'PG_INPUT_SCOPE')
        pg = {key: pg_marker[key] for key in ('database', 'serverVersionNum', 'clusterSha256')}
    else:
        need(pg_file.is_file(), 'PG_ANCHOR')
        pg = pg_identity(read(pg_file, 512), expected)
    git = GitCheckout(args.repo, expected['checkout'])
    pins = checker_source(git, authenticated)
    return replay(args, scratch, raw, expected, artifact, windows, pg, build, git, pins, pg_marker, pg_stamp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-replay', action='store_true')
    parser.add_argument('--authenticated-build-identity', action='store_true')
    for name in ('repo', 'input', 'build-root', 'trusted-expect', 'out'):
        parser.add_argument('--' + name, type=Path)
    args = parser.parse_args()
    try:
        need(args.fixture_replay, 'FORMAL_PENDING')
        need(all((args.repo, args.input, args.out)), 'INPUT_ARGS')
        need(args.authenticated_build_identity == bool(args.trusted_expect)
             and args.authenticated_build_identity != bool(args.build_root), 'INPUT_ARGS')
        need(not args.out.exists() and not args.out.is_symlink(), 'OUTPUT_EXISTS')
        with TemporaryDirectory(prefix='.j6-network-', dir=args.out.parent) as temp:
            outcome = verify(args, Path(temp).resolve())
            result = Path(temp) / 'projection.json'
            result.write_bytes((stable(outcome) + '\n').encode())
            os.link(result, args.out)
    except Reject as error:
        print(f'J6_NETWORK_{error}', file=sys.stderr)
        return 1
    except (ValueError, TypeError, KeyError, AttributeError, OSError, RecursionError, subprocess.TimeoutExpired):
        print('J6_NETWORK_INPUT', file=sys.stderr)
        return 1
    print('J6_NETWORK_FIXTURE_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
