"""Classify a private Playwright JSON report for the T10 status receipt."""

import json
from pathlib import Path
import re
import sys


NO_TESTS = re.compile(r'^(?:Error: )?No tests found\b')
SERVER_ERROR = re.compile(
    r'^(?:Error: )?(?:Process from config\.webServer\b|Timed out waiting .*? from config\.webServer\b|'
    r'.+ is already used, make sure that nothing is running on the port)',
)
BROWSER_LAUNCH_ERROR = re.compile(r'^(?:Error: )?browserType\.launch(?:PersistentContext)?:', re.I)


def messages(errors):
    return [error['message'] for error in errors if isinstance(error.get('message'), str)]


def find_tests(suites):
    for suite in suites:
        for spec in suite.get('specs', []):
            yield from spec['tests']
        yield from find_tests(suite.get('suites', []))


def classify(report):
    tests = list(find_tests(report['suites']))
    global_errors = messages(report['errors'])
    loader_failed = not tests and any(NO_TESTS.match(message) for message in global_errors)
    failures = set()
    for message in global_errors:
        if SERVER_ERROR.match(message) or BROWSER_LAUNCH_ERROR.match(message):
            failures.add('launch')
        elif loader_failed:
            failures.add('loader')
        else:
            failures.add('setup_or_runner')
    for test in tests:
        if test['status'] != 'unexpected':
            continue
        for result in test['results']:
            if result['status'] in {'skipped', 'interrupted'}:
                continue
            errors = messages(result.get('errors', []))
            failures.add('launch' if any(BROWSER_LAUNCH_ERROR.match(error) for error in errors) else 'case')
    if len(failures) > 1:
        return 'mixed'
    return next(iter(failures), 'unclassified')


def main(report_path):
    try:
        with report_path.open(encoding='utf-8') as stream:
            if report_path.stat().st_size > 8 * 1024 * 1024:
                return 'report_unavailable'
            return classify(json.load(stream))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        return 'report_unavailable'


if __name__ == '__main__':
    print(main(Path(sys.argv[1])))
