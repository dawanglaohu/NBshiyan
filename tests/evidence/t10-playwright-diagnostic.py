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
# Playwright reports spec.file relative to testDir (`e2e/`), so the real T10 report carries
# `t10-state-capture.spec.ts`; the repo-relative form is the other shape the same file can take.
TARGET_SPEC = 't10-state-capture.spec.ts'
TARGET_SPECS = ('t10-state-capture.spec.ts', 'e2e/t10-state-capture.spec.ts')
TARGET_PROJECT = 'chromium'
# Exact closed set, catalogued from the pinned spec blob (new Error(`CODE ...`)) and the
# pinned run-auth blob (fail('CODE') plus the SESSION_<status> and _AND_CLEANUP forms the
# class composes). Nothing outside this set may be published, however plausible it looks.
ALLOWED_CODES = frozenset({  # 70 entries
    'E2E_RUN_AUTH_ALREADY_INITIALIZED', 'E2E_RUN_AUTH_ALREADY_INITIALIZED_AND_CLEANUP', 'E2E_RUN_AUTH_ARTIFACT_DIRECTORY',
    'E2E_RUN_AUTH_ARTIFACT_DIRECTORY_AND_CLEANUP', 'E2E_RUN_AUTH_CACHE', 'E2E_RUN_AUTH_CACHE_AND_CLEANUP',
    'E2E_RUN_AUTH_CLEANUP', 'E2E_RUN_AUTH_CLEANUP_AND_CLEANUP', 'E2E_RUN_AUTH_CLEANUP_CONTENT',
    'E2E_RUN_AUTH_CLEANUP_CONTENT_AND_CLEANUP', 'E2E_RUN_AUTH_CLEANUP_OWNER', 'E2E_RUN_AUTH_CLEANUP_OWNER_AND_CLEANUP',
    'E2E_RUN_AUTH_CSRF', 'E2E_RUN_AUTH_CSRF_AND_CLEANUP', 'E2E_RUN_AUTH_DIRECTORY',
    'E2E_RUN_AUTH_DIRECTORY_AND_CLEANUP', 'E2E_RUN_AUTH_EXPIRED', 'E2E_RUN_AUTH_EXPIRED_AND_CLEANUP',
    'E2E_RUN_AUTH_FILE_CHANGED', 'E2E_RUN_AUTH_FILE_CHANGED_AND_CLEANUP', 'E2E_RUN_AUTH_IDENTITY',
    'E2E_RUN_AUTH_IDENTITY_AND_CLEANUP', 'E2E_RUN_AUTH_INITIALIZE', 'E2E_RUN_AUTH_INITIALIZE_AND_CLEANUP',
    'E2E_RUN_AUTH_LOGIN', 'E2E_RUN_AUTH_LOGIN_AND_CLEANUP', 'E2E_RUN_AUTH_MANIFEST_DIGEST',
    'E2E_RUN_AUTH_MANIFEST_DIGEST_AND_CLEANUP', 'E2E_RUN_AUTH_PERMISSIONS', 'E2E_RUN_AUTH_PERMISSIONS_AND_CLEANUP',
    'E2E_RUN_AUTH_PROVENANCE', 'E2E_RUN_AUTH_PROVENANCE_AND_CLEANUP', 'E2E_RUN_AUTH_REQUEST_CLEANUP',
    'E2E_RUN_AUTH_REQUEST_CLEANUP_AND_CLEANUP', 'E2E_RUN_AUTH_REQUEST_CONTEXT', 'E2E_RUN_AUTH_REQUEST_CONTEXT_AND_CLEANUP',
    'E2E_RUN_AUTH_SESSION', 'E2E_RUN_AUTH_SESSION_401', 'E2E_RUN_AUTH_SESSION_403',
    'E2E_RUN_AUTH_SESSION_503', 'E2E_RUN_AUTH_SESSION_AND_CLEANUP', 'E2E_RUN_AUTH_SESSION_HTTP',
    'E2E_RUN_AUTH_SESSION_HTTP_AND_CLEANUP', 'E2E_RUN_AUTH_SOURCE', 'E2E_RUN_AUTH_SOURCE_AND_CLEANUP',
    'E2E_RUN_AUTH_STATE_DIGEST', 'E2E_RUN_AUTH_STATE_DIGEST_AND_CLEANUP', 'E2E_RUN_AUTH_SYMLINK_OR_TYPE',
    'E2E_RUN_AUTH_SYMLINK_OR_TYPE_AND_CLEANUP', 'E2E_RUN_AUTH_UNINITIALIZED', 'E2E_RUN_AUTH_UNINITIALIZED_AND_CLEANUP',
    'T10_STATE_CAPTURE_ACCOUNT_COUNT', 'T10_STATE_CAPTURE_ALERT_TEXT', 'T10_STATE_CAPTURE_BUILD_ID_EMPTY',
    'T10_STATE_CAPTURE_BUILD_ID_MISSING', 'T10_STATE_CAPTURE_CARRIER_MISSING', 'T10_STATE_CAPTURE_DIRTY_TRACKED',
    'T10_STATE_CAPTURE_GIT_MISSING', 'T10_STATE_CAPTURE_MASK_BINDING', 'T10_STATE_CAPTURE_MASK_DRIFT',
    'T10_STATE_CAPTURE_MASK_OUTSIDE', 'T10_STATE_CAPTURE_MASK_UNPROVEN', 'T10_STATE_CAPTURE_NET_ERROR_UNKNOWN',
    'T10_STATE_CAPTURE_PNG_HEIGHT', 'T10_STATE_CAPTURE_PNG_INVALID', 'T10_STATE_CAPTURE_SCROLL',
    'T10_STATE_CAPTURE_SHA_MISMATCH', 'T10_STATE_CAPTURE_SOURCE_MISSING', 'T10_STATE_EVIDENCE_OUTSIDE_UPLOAD',
    'T10_STATE_EVIDENCE_SIZE_MISMATCH',
})
# The pinned spec's four declarations, in declaration order. A report is the target only when it
# carries each (line, title) pair exactly once; the case ordinal never comes from report order.
DECLARATIONS = (
    (997, '空/无重算：契约初始态与同次 GET 四字段绑定（三视口）'),
    (1054, '加载中：放行前同一 UI 状态与截图，再放行原请求（三视口）'),
    (1176, '加载失败与重试：真实传输失败（net::ERR_*）后恢复真实请求（三视口）'),
    (1337, '保存结果：同笔 PATCH 200 与 UI 绑定，计数持续到最后一张截图'),
)
DECLARATION_INDEX = {(line, title): index for index, (line, title) in enumerate(DECLARATIONS)}
TEST_STATES = frozenset({'expected', 'unexpected', 'skipped', 'flaky'})
RESULT_STATES = frozenset({'passed', 'failed', 'timedOut', 'skipped', 'interrupted'})
# Pinned-spec lines that assert a response `.status()`; the hint is bound to the complete
# normalized source line, the exact caret line, and the report's own canonical spec path.
STATUS_SOURCE_LINES = frozenset({1005, 1093, 1216, 1359, 1422})
STATUS_SOURCE_BY_LINE = {
    1005: 'expect(navigation?.status(), `${viewport} 分区页状态`).toBe(200);',
    1093: 'expect(navigation?.status(), `${viewport} 分区页状态`).toBe(200);',
    1216: 'expect(navigation?.status(), `${viewport} 分区页状态`).toBe(200);',
    1359: "expect(navigation?.status(), '1440x900 分区页状态').toBe(200);",
    1422: "expect(response.status(), '保存 PATCH 状态码').toBe(200);",
}
ANSI = re.compile(r'\x1b\[[0-9;]*m')
# Playwright serialises a named error as `<Name>: <message>`, e.g. `RunAuthError: E2E_RUN_AUTH_...`.
# The pinned sources put a space or the full-width colon after a capture code and nothing at all
# after a run-auth code, so only those real separators (or the line end) may end the token.
CAPTURE_CODE = re.compile(r'^(?:[A-Za-z]{0,24}Error: )?(T10_STATE_[A-Z0-9_]{1,60})(?=[ ：\r\n]|$)')
RUN_AUTH_CODE = re.compile(r'^(?:[A-Za-z]{0,24}Error: )?(E2E_RUN_AUTH_[A-Z0-9_]{1,60})(?=[\r\n]|$)')
# A primitive toBe diff with optional one-line custom message, then the fixed numbers.
STATUS_SHAPE = re.compile(
    r'^Error: (?:[^\n]{0,200}\n\n)?expect\(received\)\.toBe\(expected\) // Object\.is equality\n\n'
    r'Expected: ([0-9]{3})\nReceived: ([0-9]{3})(?:\n|$)',
)
# One numbered row of the source frame Playwright prints in an error message.  Reporter 1.64
# right-aligns the line number in a five-character field after a one-character marker, so the
# pipe always sits at the same gutter position (`>  997 | ...` or `   995 |`).  The `>` marker
# identifies the highlighted row; every other row is its numbered context.
FRAME_ROW = re.compile(r'^([> ])([ ]{0,4}[0-9]{1,5}) \|(?: (.*))?$')
# The caret row under the highlighted source row: seven spaces and a pipe, then the reported
# column's spaces and a single caret, with nothing else.  Its column is the number of those
# spaces, never an offset between arbitrary `|` and `^` characters.
FRAME_CARET = re.compile(r'^ {7}\|( +)\^$')
# The stack location Playwright appends after the real frame.  It is the only trusted anchor:
# text copied into an error message may contain a convincing `> n | ...` block, but Playwright
# does not append a matching `at file:line:col` after a frame it did not produce.
STACK_LINE = re.compile(r'^\s*at (.+):([0-9]+):([0-9]+)\s*$')
# Playwright 1.64's parseStackFrame() regex (packages/utils/stackTrace.ts), reproduced for the
# raw error stack.  Group 7 is the file, group 8 the line and group 9 the column.  Only ASCII
# digits are accepted, matching JavaScript's `\d` semantics rather than Python's Unicode `\d`.
STACK_FRAME = re.compile(
    r'^(?:\s*at )?(?:(new) )?(?:(.*?) \()?(?:eval at ([^ ]+) \((.+?):([0-9]+):([0-9]+)\), )?'
    r'(?:(.+?):([0-9]+):([0-9]+)|(native))(\)?)$'
)
# The one bare frame shape accepted by the status hint: exactly four spaces, a path without
# parentheses, and ASCII line/column digits.  Named frames and extra stack lines are rejected.
BARE_FRAME = re.compile(r'^    at ([^()\r\n]+):([0-9]+):([0-9]+)$')
# Python's splitlines() treats VT, FF, NEL, U+2028/U+2029 and the C1 separators as line
# boundaries.  The supported reporter shape is normalized to LF first and then split only on LF.
NON_LF_SEPARATORS = frozenset('\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029')
DETAIL_FALLBACK = 'report=missing case=0 failed=0 skipped=0 shape=none code=none expect=none value=none'
DETAIL_INVALID = 'report=invalid case=0 failed=0 skipped=0 shape=none code=none expect=none value=none'


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


def iter_specs(suites):
    for suite in suites:
        for spec in suite.get('specs', []):
            yield spec
        yield from iter_specs(suite.get('suites', []))


def normalize_file(value):
    if not isinstance(value, str):
        return ''
    text = value.replace('\\', '/')
    while text.startswith('./'):
        text = text[2:]
    return text


def canonical_target(report):
    """The one canonical absolute spec path this report's own config anchors.

    The hint is only evidence when `error.location.file` is exactly this path.  Returning None
    (missing/mismatched rootDir or testDir) fails closed: no path is ever published.
    """
    config = report.get('config')
    if not isinstance(config, dict):
        return None
    root = config.get('rootDir')
    if not isinstance(root, str) or not root.strip():
        return None
    root_norm = normalize_file(root).rstrip('/')
    projects = config.get('projects')
    if not isinstance(projects, list) or len(projects) != 1 or not isinstance(projects[0], dict):
        return None
    project = projects[0]
    if project.get('name') != TARGET_PROJECT:
        return None
    test_dir = project.get('testDir')
    if not isinstance(test_dir, str) or not test_dir.strip():
        return None
    if normalize_file(test_dir).rstrip('/') != root_norm:
        return None
    return root_norm + '/' + TARGET_SPEC


def status_source_matches(line, source):
    """The complete normalized pinned assertion line, not a substring or prefix."""
    return STATUS_SOURCE_BY_LINE.get(line) == source.strip()


def frame_row(line):
    """Match a numbered source-frame row only when its gutter is exactly six characters."""
    match = FRAME_ROW.match(line)
    if not match or len(match.group(1)) + len(match.group(2)) != 6:
        return None
    return match


def status_source_frame(plain, offset, report, error, result):
    """Return the one complete Playwright source frame appended before the terminal stack, or None.

    Playwright 1.64 renders a contiguous block: two numbered context rows, the highlighted
    `> n | ...` row, its caret row, three numbered context rows, then the terminal
    `at file:line:col`.  The block must end at that stack line and its line numbers must be
    consecutive.  A copied block inside the message therefore cannot be selected merely because
    it contains a caret, and inserted text, a gap or a non-frame row rejects the hint.  Missing
    or conflicting evidence fails closed.
    """
    lines = plain[offset:].split('\n')
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return None
    stack = STACK_LINE.match(lines[-1].strip())
    if not stack:
        return None
    location = error.get('location')
    if not isinstance(location, dict):
        return None
    location_line = location.get('line')
    location_column = location.get('column')
    if (isinstance(location_line, bool) or not isinstance(location_line, int)
            or isinstance(location_column, bool) or not isinstance(location_column, int)):
        return None
    try:
        stack_line = int(stack.group(2))
        stack_column = int(stack.group(3))
    except (TypeError, ValueError):
        return None
    target = canonical_target(report)
    if (not target or normalize_file(stack.group(1)) != target
            or stack_line != location_line or stack_column != location_column):
        return None
    cursor = len(lines) - 2
    after = []
    while len(after) < 3:
        match = frame_row(lines[cursor]) if cursor >= 0 else None
        if not match or match.group(1) != ' ':
            return None
        after.append(match)
        cursor -= 1
    caret = FRAME_CARET.match(lines[cursor]) if cursor >= 0 else None
    if not caret or len(caret.group(1)) != stack_column:
        return None
    cursor -= 1
    frame = frame_row(lines[cursor]) if cursor >= 0 else None
    if not frame or frame.group(1) != '>':
        return None
    frame_line = int(frame.group(2))
    if frame_line != stack_line:
        return None
    cursor -= 1
    before = []
    while len(before) < 2:
        match = frame_row(lines[cursor]) if cursor >= 0 else None
        if not match or match.group(1) != ' ':
            return None
        before.append(match)
        cursor -= 1
    # A further numbered row directly above the block means this is not the reporter's complete
    # two-context-row frame; do not guess which part belongs to the real stack.
    if cursor >= 0 and frame_row(lines[cursor]):
        return None
    block_start = cursor + 1
    block_end = len(lines) - 1
    for delta, match in enumerate(reversed(after), 1):
        if int(match.group(2)) != frame_line + delta:
            return None
    for delta, match in enumerate(before, 1):
        if int(match.group(2)) != frame_line - delta:
            return None
    source = frame.group(3)
    if source is None:
        return None
    return frame_line, source.strip(), lines[block_start:block_end]


def same_location(left, right):
    """Structured locations agree exactly on file, line and column, with no bool aliases."""
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    for key in ('line', 'column'):
        a, b = left.get(key), right.get(key)
        if isinstance(a, bool) or not isinstance(a, int):
            return False
        if isinstance(b, bool) or not isinstance(b, int) or a != b:
            return False
    a, b = normalize_file(left.get('file')), normalize_file(right.get('file'))
    return bool(a) and a == b


def status_text(value):
    """Normalize a Playwright status message by its own ANSI and newline rules only."""
    if not isinstance(value, str):
        return None
    return ANSI.sub('', value).replace('\r\n', '\n').replace('\r', '\n')


def has_non_lf_separator(*texts):
    """Reject control characters that Python would otherwise treat as line boundaries."""
    return any(char in text for text in texts if isinstance(text, str) for char in NON_LF_SEPARATORS)


def parse_error_stack(stack):
    """Reproduce Playwright 1.64 parseErrorStack() for a raw reporter stack.

    The parsed message is every line before the first exact `    at ` frame line; the location
    is the first parseable non-node_modules frame.  The complete `stackLines` suffix is returned
    so callers can require the single bare frame the positive controls actually emit.  A stack
    with no frame returns the whole remaining text as its message and no location, which callers
    must reject.
    """
    lines = stack.split('\n')
    first = next((index for index, line in enumerate(lines) if line.startswith('    at ')), len(lines))
    message = '\n'.join(lines[:first])
    stack_lines = lines[first:]
    for line in stack_lines:
        match = STACK_FRAME.match(line)
        if not match:
            continue
        file = match.group(7)
        if not file:
            continue
        folded = file.replace('\\', '/')
        if '/node_modules/' in folded:
            continue
        try:
            line_number = int(match.group(8))
            column = int(match.group(9))
        except (TypeError, ValueError):
            continue
        return message, stack_lines, {'file': file, 'line': line_number, 'column': column}
    return message, stack_lines, None


def status_reporter_snippet_matches(result, error, frame_line, block_lines, expected, received):
    """Bind the hint to the same result's raw primary error and its reporter snippet.

    Playwright 1.64 assigns `result.error = result.errors[0]`, so only the formatted primary
    record may carry the hint.  The raw message must contain the complete status assertion
    numbers, and the raw stack must parse (Playwright 1.64 parseErrorStack) to exactly that
    message and exactly one bare stack frame whose location matches the raw, formatted and
    derived locations.  Only the no-cause primary shape is supported: Playwright appends a
    formatted `[cause]` section when a raw cause exists, which this status hint does not bind.
    The formatted primary record must equal the complete record Playwright 1.64 formats: parsed
    message, blank line, the same reporter snippet, and that same single bare frame.  The raw
    reporter `snippet` is the only generated source evidence: it must normalize (ANSI and
    newline only) to the exact contiguous block already selected.  Missing, extra, truncated or
    conflicting evidence fails closed.
    """
    raw = result.get('error')
    if not isinstance(raw, dict) or 'cause' in raw:
        return False
    raw_plain = status_text(raw.get('message'))
    raw_shape = STATUS_SHAPE.match(raw_plain) if raw_plain else None
    if not raw_shape or (int(raw_shape.group(1)), int(raw_shape.group(2))) != (expected, received):
        return False
    raw_stack = status_text(raw.get('stack'))
    if not raw_stack or has_non_lf_separator(raw_plain, raw_stack):
        return False
    stack_message, stack_lines, stack_location = parse_error_stack(raw_stack)
    if stack_message != raw_plain or len(stack_lines) != 1 or not isinstance(stack_location, dict):
        return False
    raw_frame = stack_lines[0]
    if not BARE_FRAME.fullmatch(raw_frame):
        return False
    location = raw.get('location')
    if not same_location(location, stack_location):
        return False
    snippet = raw.get('snippet')
    if not isinstance(snippet, str) or not snippet.strip():
        return False
    snippet_plain = status_text(snippet)
    if not snippet_plain:
        return False
    formatted_plain = status_text(error.get('message'))
    formatted_shape = STATUS_SHAPE.match(formatted_plain) if formatted_plain else None
    if not formatted_shape or (int(formatted_shape.group(1)), int(formatted_shape.group(2))) != (expected, received):
        return False
    # `formatError()` in Playwright 1.64 joins the parsed message, an empty line, the raw
    # reporter snippet and the complete parsed stack with LF.  A prefix/suffix check would let
    # an inserted assertion, stack frame or unsupported separator survive between those sections.
    if has_non_lf_separator(snippet_plain, formatted_plain):
        return False
    if formatted_plain != raw_plain + '\n\n' + snippet_plain + '\n' + raw_frame:
        return False
    if not same_location(location, error.get('location')) or location.get('line') != frame_line:
        return False
    snippet_lines = snippet_plain.split('\n')
    actual_lines = block_lines
    return snippet_lines == actual_lines


def status_location_matches(report, error, result, caret_line):
    """Require the primary and the mandatory derived location to share file, line and column."""
    location = error.get('location')
    if not isinstance(location, dict):
        return False
    line = location.get('line')
    column = location.get('column')
    target = canonical_target(report)
    if (isinstance(line, bool) or not isinstance(line, int) or line != caret_line
            or isinstance(column, bool) or not isinstance(column, int)
            or not target or normalize_file(location.get('file')) != target):
        return False
    error_location = result.get('errorLocation')
    if not isinstance(error_location, dict):
        return False
    result_line = error_location.get('line')
    result_column = error_location.get('column')
    if (isinstance(result_line, bool) or not isinstance(result_line, int)
            or result_line != caret_line
            or isinstance(result_column, bool) or not isinstance(result_column, int)
            or result_column != column
            or normalize_file(error_location.get('file')) != target):
        return False
    return True


def zero_retry(project):
    """The fixed T10 command has no retries and one repeat; both fields must be present."""
    retries = project.get('retries')
    if isinstance(retries, bool) or not isinstance(retries, int) or retries != 0:
        return False
    repeat_each = project.get('repeatEach')
    if isinstance(repeat_each, bool) or not isinstance(repeat_each, int) or repeat_each != 1:
        return False
    return True


def argv_zero_retry(config):
    """Every explicit --retries form must be exactly zero; duplicate forms are rejected."""
    argv = config.get('argv') if isinstance(config, dict) else None
    if not isinstance(argv, list):
        return True
    seen = False
    for index, argument in enumerate(argv):
        if argument == '--retries':
            if seen or index + 1 >= len(argv) or argv[index + 1] != '0':
                return False
            seen = True
        elif isinstance(argument, str) and argument.startswith('--retries='):
            if seen or argument != '--retries=0':
                return False
            seen = True
    return True


def compute_outcome(expected_status, results):
    """Playwright 1.64 computeTestCaseOutcome, reproduced on the serialized result list."""
    skipped = 0
    did_not_run = 0
    expected = 0
    interrupted = 0
    unexpected = 0
    for result in results:
        status = result.get('status')
        if status == 'interrupted':
            interrupted += 1
        elif status == 'skipped' and expected_status == 'skipped':
            skipped += 1
        elif status == 'skipped':
            did_not_run += 1
        elif status == expected_status:
            expected += 1
        else:
            unexpected += 1
    if expected == 0 and unexpected == 0:
        return 'skipped'
    if unexpected == 0:
        return 'expected'
    if expected == 0 and skipped == 0:
        return 'unexpected'
    return 'flaky'


def coherent_test(test):
    """One attempt numbered 0, a legal expectedStatus, and a computed outcome match.

    An interrupted-only test keeps its safe legacy shape: it is not promoted into a failed case
    and its outer status is not used to invent a failure. Missing execution fields are evidence
    gaps, so the detail path rejects them rather than inventing a pass.
    """
    if test.get('status') == 'flaky':
        return False
    results = test.get('results')
    if not isinstance(results, list) or len(results) != 1:
        return False
    result = results[0]
    retry = result.get('retry')
    if isinstance(retry, bool) or not isinstance(retry, int) or retry != 0:
        return False
    expected_status = test.get('expectedStatus')
    if expected_status not in {'passed', 'skipped'}:
        return False
    if all(result.get('status') == 'interrupted' for result in results):
        return True
    return compute_outcome(expected_status, results) == test.get('status')


def inspect(report):
    """Fail closed unless the report is one project with the four approved declarations.

    Returns the slots in fixed declaration order, so a reordered report keeps the same ordinals.
    Duplicate, missing, unknown or malformed declarations and unknown states reject the receipt.
    """
    config = report.get('config')
    projects = config.get('projects') if isinstance(config, dict) else None
    if not isinstance(projects, list) or len(projects) != 1:
        return 'multi_project', []
    project = projects[0]
    if not isinstance(project, dict) or project.get('name') != TARGET_PROJECT:
        return 'non_target', []
    if not zero_retry(project) or not argv_zero_retry(config):
        return 'invalid', []
    filtered = config.get('filteredProjects')
    if isinstance(filtered, list):
        for item in filtered:
            if isinstance(item, dict) and item.get('name') == TARGET_PROJECT and not zero_retry(item):
                return 'invalid', []
    specs = list(iter_specs(report.get('suites') or []))
    if not specs:
        return 'no_tests', []
    pairs = []
    for spec in specs:
        if not isinstance(spec, dict) or normalize_file(spec.get('file')) not in TARGET_SPECS:
            return 'non_target', []
        tests = spec.get('tests')
        if not isinstance(tests, list) or len(tests) != 1:
            return 'invalid', []
        test = tests[0]
        if not isinstance(test, dict) or test.get('projectName') != TARGET_PROJECT:
            return 'non_target', []
        pairs.append((spec, test))
    if len(pairs) != 4:
        return 'count_mismatch', []
    slots = [None] * 4
    for spec, test in pairs:
        line = spec.get('line')
        title = spec.get('title')
        if isinstance(line, bool) or not isinstance(line, int) or not isinstance(title, str):
            return 'invalid', []
        index = DECLARATION_INDEX.get((line, title))
        if index is None or slots[index] is not None:
            return 'invalid', []
        slots[index] = (spec, test)
    if any(slot is None for slot in slots):
        return 'invalid', []
    for _spec, test in slots:
        if test.get('status') not in TEST_STATES:
            return 'invalid', []
        results = test.get('results')
        if not isinstance(results, list) or not results:
            return 'invalid', []
        for result in results:
            if not isinstance(result, dict) or result.get('status') not in RESULT_STATES:
                return 'invalid', []
        if not coherent_test(test):
            return 'invalid', []
    return 'ok', slots


def shape_of(failed, skipped):
    """Count distribution only: no order, no hook, no claim about which case passed."""
    if failed == 0:
        return 'none'
    if failed == 4:
        return 'all_failed'
    return 'no_skips' if skipped == 0 else 'has_skips'


def match_code(plain):
    """The complete leading token, accepted only with a source-real separator or the line end."""
    for pattern in (CAPTURE_CODE, RUN_AUTH_CODE):
        match = pattern.match(plain)
        if match and match.group(1) in ALLOWED_CODES:
            return match.group(1)
    return 'none'


def detail(report):
    """One fixed line: report verdict, closed case ordinal, bounded counts, closed code, status hint.

    shape is the count distribution only. expect/value only appear for a primitive toBe 3-digit
    diff whose padded caret points at one of the pinned spec's `.status()` assertion lines; the
    number is a hint, never an HTTP claim.
    """
    status, slots = inspect(report)
    if status != 'ok':
        return f'report={status} case=0 failed=0 skipped=0 shape=none code=none expect=none value=none'
    failed = 0
    skipped = 0
    first = None
    for index, (_spec, test) in enumerate(slots):
        state = test.get('status')
        if state == 'skipped':
            skipped += 1
        if state != 'unexpected':
            continue
        # Same rule as classify(): an interrupted-only result is not a failing case.
        results = [result for result in test.get('results') or []
                   if result.get('status') not in {'skipped', 'interrupted'}]
        if not results:
            continue
        failed += 1
        if first is None:
            first = (index, results)
    case = first[0] + 1 if first else 0
    shape = shape_of(failed, skipped)
    code = 'none'
    expect = 'none'
    value = 'none'
    if first:
        for result in first[1]:
            errors = result.get('errors')
            if not isinstance(errors, list):
                continue
            for index, error in enumerate(errors):
                message = error.get('message') if isinstance(error, dict) else None
                if not isinstance(message, str):
                    continue
                plain = status_text(message)
                if code == 'none':
                    code = match_code(plain)
                # Playwright 1.64 sets result.error = result.errors[0]; only that formatted
                # primary record is allowed to carry the status hint.
                if expect == 'none' and index == 0:
                    hit = STATUS_SHAPE.match(plain)
                    if hit:
                        expected, received = int(hit.group(1)), int(hit.group(2))
                        frame = status_source_frame(plain, hit.end(), report, error, result)
                        if (expected == 200 and 100 <= received <= 599
                                and received != expected and frame):
                            line, source, block = frame
                            if (line in STATUS_SOURCE_LINES and status_source_matches(line, source)
                                    and status_location_matches(report, error, result, line)
                                    and status_reporter_snippet_matches(
                                        result, error, line, block, expected, received)):
                                expect, value = 'status3d', f'{received:03d}'
                if code != 'none' and expect != 'none':
                    break
    return (f'report=ok case={case} failed={failed} skipped={skipped} shape={shape} '
            f'code={code} expect={expect} value={value}')


def main(report_path):
    try:
        with report_path.open(encoding='utf-8') as stream:
            if report_path.stat().st_size > 8 * 1024 * 1024:
                return 'report_unavailable'
            return classify(json.load(stream))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
        return 'report_unavailable'


def main_detail(report_path):
    try:
        if not report_path.is_file():
            return DETAIL_FALLBACK
        if report_path.stat().st_size > 8 * 1024 * 1024:
            return DETAIL_INVALID
        with report_path.open(encoding='utf-8') as stream:
            return detail(json.load(stream))
    except OSError:
        return DETAIL_FALLBACK
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        return DETAIL_INVALID


if __name__ == '__main__':
    argv = sys.argv[1:]
    if argv[:1] == ['--detail'] and len(argv) == 2:
        print(main_detail(Path(argv[1])))
    else:
        print(main(Path(argv[0])))
