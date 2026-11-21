#!/usr/bin/env python3
"""Re-run three approved evidence admitters from trusted input files.

The output feeds offline J7 receipt assembly. It is a partial admission, with
no authority to publish a complete J7 receipt.
"""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory


class Rejected(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def describe(path):
    return json.loads(path.read_bytes())


def git(repo, *args):
    reply = subprocess.run(['git', '--no-replace-objects', '-C', str(repo), *args],
                           capture_output=True, timeout=20)
    require(reply.returncode == 0, 'J7_SOURCES_CHECKOUT')
    return reply.stdout


def execute(tool, flags, *, command=()):
    invocation = [sys.executable, '-B', str(tool), *command]
    for flag, value in flags.items():
        invocation.extend((f'--{flag}', str(value)))
    response = subprocess.run(invocation, capture_output=True, timeout=60)
    if response.returncode:
        reason = response.stderr.strip().decode(errors='replace')
        pattern = r'(?:J7_BUILD_PROVENANCE_|J4_ADMISSION_|E_ANC_)[A-Z0-9_]+'
        raise Rejected(reason if re.fullmatch(pattern, reason) else 'J7_SOURCES_ADMITTER')


def input_flags(path, flags):
    return {flag: path / name for flag, name in flags.items()}


def anchor(args, build, j4):
    expected = build['checkout']
    runner = build['runner']
    require((runner['runId'], runner['runAttempt'], build['e2eBuildId'])
            == (args.e2e_run_id, args.e2e_attempt, args.e2e_build_id), 'J7_SOURCES_E2E_IDENTITY')
    require(j4['checkout'] == expected and args.checkout == expected['sha'], 'J7_SOURCES_CHECKOUT')
    require(re.fullmatch(r'[0-9a-f]{40}', args.checkout), 'J7_SOURCES_CHECKOUT')
    raw = git(args.repo, 'cat-file', 'commit', args.checkout).partition(b'\n\n')[0]
    tree, = re.findall(rb'(?m)^tree ([0-9a-f]{40})$', raw)
    parents = re.findall(rb'(?m)^parent ([0-9a-f]{40})$', raw)
    require(tree.decode() == expected['tree'] and [parent.decode() for parent in parents] == expected['parents']
            and len(parents) == 2 and parents[1].decode() == expected['prHeadSha'], 'J7_SOURCES_CHECKOUT')
    require(j4['ref'] == build['runner']['ref'] and str(j4['repositoryId']) == build['runner']['repositoryId'],
            'J7_SOURCES_PLATFORM')
    formal = git(args.repo, 'cat-file', 'blob', args.checkout + ':.github/workflows/formal-supplement.yml')
    scripts, = re.findall(rb'(?m)^      J4_SCRIPT_SHA256: ([0-9a-f]{64})$', formal)
    manifests, = re.findall(rb'(?m)^      B4_APPROVAL_SHA256: ([0-9a-f]{64})$', formal)
    reports, = re.findall(rb'(?m)^ +j4_report="\$root/out/([a-zA-Z0-9._-]+)"$', formal)
    producer = git(args.repo, 'cat-file', 'blob', args.checkout + ':tests/evidence/j4-operations-seam.mjs')
    require(j4['scriptSha256'] == scripts.decode() == sha256(producer).hexdigest()
            and j4['approvalSha256'] == manifests.decode() and j4['reportName'] == reports.decode(), 'J7_SOURCES_J4_PINS')


def verify_tool(args, scratch, name):
    relative = 'tests/evidence/' + name
    tool = args.tools / name
    actual = git(args.repo, 'cat-file', 'blob', args.checkout + ':' + relative)
    require(tool.is_file() and not tool.is_symlink() and tool.read_bytes() == actual, 'J7_SOURCES_TOOL_BYTES')
    checked = scratch / name
    checked.write_bytes(actual)
    return checked


def logged_provenance_body(path, output):
    require(path.stat().st_size <= 16 * 1024 * 1024, 'J7_SOURCES_BUILD_LOG')
    rows = []
    for raw in path.read_bytes().splitlines():
        if raw.strip():
            split = raw.split(b'\t', 2)
            require(len(split) == 3 and split[0] == b'build-and-audit', 'J7_SOURCES_BUILD_LOG')
            rows.append(split[2])
    require(rows, 'J7_SOURCES_BUILD_LOG')
    output.write_bytes(b'\n'.join(rows) + b'\n')


def compose(args, scratch, published):
    build = args.build_input
    j4 = args.formal_input
    build_expected, j4_expected = (describe(folder / 'expect.json') for folder in (build, j4))
    anchor(args, build_expected, j4_expected)
    provenance = verify_tool(args, scratch, 'j7-build-provenance.py')
    bad_config = verify_tool(args, scratch, 'j7-bad-config-admission.py')
    j4_tool = verify_tool(args, scratch, 'j7-j4-admission.py')
    common = input_flags(build, {'expect': 'expect.json', 'run': 'run.json', 'jobs': 'jobs.json'})
    bad = scratch / 'bad'
    execute(bad_config, {**common, **input_flags(build, {
        'checkout-commit': 'checkout.json', 'artifact-list': 'artifacts.json', 'job-log': 'job.log',
        'provenance-artifact': 'provenance-artifact.json', 'provenance-zip': 'provenance.zip',
        'bad-artifact': 'bad-artifact.json', 'bad-zip': 'bad-config.zip',
    }), 'job-id': args.build_job_id, 'provenance-tool': provenance, 'out-dir': bad})
    normalized_log = scratch / 'build.log'
    logged_provenance_body(build / 'job.log', normalized_log)
    build_receipt = published / 'build-admission.json'
    execute(provenance, {**common, **input_flags(build, {'artifact': 'provenance-artifact.json', 'zip': 'provenance.zip'}),
                         'job-id': args.build_job_id, 'job-log': normalized_log, 'out': build_receipt}, command=('admit',))
    j4_receipt = published / 'j4-attribution.json'
    execute(j4_tool, {**input_flags(j4, {'expect': 'expect.json', 'run': 'run.json', 'jobs': 'jobs.json',
                                       'checkout': 'checkout.json', 'artifact': 'artifact.json',
                                       'zip': 'artifact.zip', 'job-log': 'job.log'}), 'out': j4_receipt})
    admitted_build, admitted_bad, admitted_j4 = map(describe, (build_receipt, bad / 'admission.json', j4_receipt))
    require(admitted_build['schema'] == 'j7-build-provenance-admission/1'
            and admitted_build['record']['checkout'] == admitted_bad['checkout'] == admitted_j4['checkout']
            == build_expected['checkout'] and admitted_bad['jobId'] == admitted_build['jobId'] == args.build_job_id
            and admitted_bad['buildProvenance'] == admitted_build['artifact']
            and admitted_bad['originalBuild'] == admitted_build['record']['builds']['original']
            and admitted_build['e2eBuildId'] == build_expected['e2eBuildId'], 'J7_SOURCES_BUILD_PROJECTION')
    require(admitted_j4['schema'] == 'j4-attribution/1' and admitted_j4['sameInstance'] is False
            and admitted_j4['buildId'] != admitted_build['e2eBuildId'], 'J7_SOURCES_J4_INSTANCE')
    bad_bytes = (bad / 'j7-bad-config.json').read_bytes()
    require(admitted_bad['schema'] == 'j7-bad-config-admission/1'
            and admitted_bad['corroboration'] == {'name': 'bad-config', 'sha256': sha256(bad_bytes).hexdigest()},
            'J7_SOURCES_BAD_CONFIG_PROJECTION')
    (published / 'bad-config-admission.json').write_bytes((bad / 'admission.json').read_bytes())
    (published / 'j7-bad-config.json').write_bytes(bad_bytes)


def compare(published, supplied):
    require(supplied.is_dir() and not supplied.is_symlink(), 'J7_SOURCES_PROJECTION_DIFF')
    expected = set(path.name for path in published.iterdir())
    require(set(path.name for path in supplied.iterdir()) == expected, 'J7_SOURCES_PROJECTION_DIFF')
    for name in expected:
        path = supplied / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == (published / name).stat().st_size
                and path.read_bytes() == (published / name).read_bytes(), 'J7_SOURCES_PROJECTION_DIFF')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repo', 'tools', 'build-input', 'formal-input'):
        parser.add_argument('--' + name, required=True, type=Path)
    for name in ('checkout', 'build-job-id', 'e2e-run-id', 'e2e-attempt', 'e2e-build-id'):
        parser.add_argument('--' + name, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--out-dir', type=Path)
    mode.add_argument('--compare-dir', type=Path)
    args = parser.parse_args()
    try:
        destination = args.out_dir or args.compare_dir
        if args.out_dir:
            require(not destination.exists() and not destination.is_symlink(), 'J7_SOURCES_OUTPUT')
        with TemporaryDirectory(dir=destination.parent, prefix='.j7-sources-') as temporary:
            scratch = Path(temporary).resolve()
            published = scratch / 'admitted'
            published.mkdir()
            compose(args, scratch, published)
            if args.compare_dir:
                compare(published, args.compare_dir)
            else:
                published.rename(destination)
    except Rejected as error:
        print(str(error), file=sys.stderr)
        return 1
    except (ValueError, TypeError, KeyError, AttributeError, OSError, subprocess.TimeoutExpired):
        print('J7_SOURCES_INPUT', file=sys.stderr)
        return 1
    print('J7_SOURCES_MATCH' if args.compare_dir else 'J7_SOURCES_PARTIAL_OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
