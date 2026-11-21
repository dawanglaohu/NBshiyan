'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual: equal } = require('node:util');
const { admitCleanup, CleanupError } = require('./j7-cleanup.cjs');
const { sha256Buffer } = require('./j7-digest.cjs');
const { RetryableAdmissionError, extractArchive, runAdmit } = require('./j7-retryable-admission.cjs');

const MIB = 1024 * 1024;
const HEX = '[0-9A-Fa-f]{64}';
const SHA = new RegExp(`^${HEX}$`);
const BUILD_ID = '[A-Za-z0-9_-]{8,64}';
const FRESH_DB = 'e2e_j7_[0-9a-f]{12}';
const INIT = 'Initialize containers';
const STOP = 'Stop containers';
const CHECKOUT = 'Run actions/checkout@v4';
const BUILD = 'Build e2e standalone and verify test identity';
const BUILD_STEP_SHA = 'f9d09773928ab01d9c051eb1d4f002f56af08fcb8f25360eec621bda95a87448';
const PROBE = 'J7 同构建探针与清理观测（独占 PG17 空库 + 真实鉴权生产者）';
const MAIN_UPLOAD = 'Upload J7 attribution receipt (exactly three safe files)';
const RETRY_UPLOAD = 'Upload J7 retryable receipt (separate named artifact)';
const FINALIZE = 'Finalize J7 runner binding (safe fields + upload anchor)';
const BIND_UPLOAD = 'Upload J7 runner binding receipt (safe fields only)';
const STEPS = [CHECKOUT, BUILD, PROBE, MAIN_UPLOAD, RETRY_UPLOAD, FINALIZE, BIND_UPLOAD];
const PG_CONTAINER_MARKER = 'J7_PG_CONTAINER ';
const HANDOFF_MARKER = 'J7_UPLOAD_HANDOFF ';
const MAIN = ['j7-attribution.json', 'j7-nodata.json', 'j7-cleanup.json'];
const RETRY = 'J7-RETRYABLE.json';
const BINDING = 'J7-RUNNER-BINDING.json';
const PROBE_MARKERS = ['J7_RUN_CONTEXT=', 'J7_PG_IDENTITY ', 'J7_FIRST_APP_BINDING=', 'J7_RETRYABLE_BOUND ',
  'J7_DB name=', 'J7_PORT_OBS after=', 'J7_SAFE_FILES ', 'J7_RUNNER_BINDING ', 'J7_RUNNER_OK'];
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function check(ok, code) {
  if (!ok) throw new RetryableAdmissionError(`E_J7_RUNNER_${code}`);
}

const digest = (bytes) => sha256Buffer(bytes).toLowerCase();
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && SHA.test(a) && a.toLowerCase() === b.toLowerCase();
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function read(file, max, code) {
  try {
    const before = fs.lstatSync(file);
    check(before.isFile() && before.size > 0 && before.size <= max, code);
    const bytes = fs.readFileSync(file);
    check(bytes.length === before.size, code);
    return bytes;
  } catch {
    check(false, code);
  }
}

function json(bytes, code) {
  try {
    const value = JSON.parse(utf8.decode(bytes));
    check(value && typeof value === 'object' && !Array.isArray(value), code);
    return value;
  } catch {
    check(false, code);
  }
}

function utc(value, log = false) {
  const shape = log ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.\d{7}Z$/ :
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)Z$/;
  const match = typeof value === 'string' && shape.exec(value);
  if (!match) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === match[1] ? time : NaN;
}

function trustedExpectation(file, root, subject, jobId) {
  if (!file) return null;
  const code = 'TRUSTED_EXPECT';
  const expected = json(read(path.resolve(file), 16 * 1024, code), code);
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  check(path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`), code);
  const keys = (value, names) => value && equal(Object.keys(value).sort(), names.split(' ').sort());
  const run = { ...subject.run, job: 'e2e', jobId, repositoryId: Number(subject.build.record.runner.repositoryId) };
  check(subject.build.record.runner.event === 'pull_request' && keys(expected, 'schema run checkout sha256') && expected.schema === 'j7-runner-authenticated-expect/1' &&
    equal(expected.run, run) && equal(expected.checkout, subject.checkout) &&
    keys(expected.sha256, 'run jobs checkout jobLog') &&
    Object.values(expected.sha256).every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)), code);
  return expected.sha256;
}

function platform(root, subject, jobId, trusted) {
  const readBuild = (name) => {
    const raw = read(path.join(root, 'build', `${name}.json`), MIB, 'PLATFORM');
    if (trusted) check(sameSha(trusted[name], digest(raw)), 'PLATFORM_DIGEST');
    return json(raw, 'PLATFORM');
  };
  const run = readBuild('run');
  const jobs = readBuild('jobs');
  const runner = subject.build.record.runner;
  const { id, attempt, workflow } = subject.run;
  const head = subject.checkout.prHeadSha;
  const repo = run.repository;
  check(run.id === id && run.run_attempt === attempt && run.name === workflow && run.path === '.github/workflows/ci.yml' &&
    run.event === runner.event && run.head_sha === head && run.status === 'completed' &&
    repo?.id === Number(runner.repositoryId) && typeof repo.full_name === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo.full_name) &&
    positive(run.head_repository?.id) && typeof run.head_branch === 'string', 'RUN');
  const api = `https://api.github.com/repos/${repo.full_name}`;
  if (trusted) {
    const commit = readBuild('checkout');
    const { sha, tree, parents } = subject.checkout;
    check(commit.sha === sha && commit.url === `${api}/git/commits/${sha}` && commit.tree?.sha === tree &&
      Array.isArray(commit.parents) && equal(commit.parents.map((parent) => parent?.sha), parents) && parents[1] === run.head_sha,
    'CHECKOUT_API');
  }
  check(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length, 'JOB');
  const selected = jobs.jobs.filter((row) => row?.name === 'e2e');
  const job = selected[0];
  check(selected.length === 1 && job.id === jobId && jobs.jobs.filter((row) => row?.id === jobId).length === 1 &&
    job.run_id === id && job.run_attempt === attempt && job.workflow_name === workflow && job.head_sha === head &&
    job.head_branch === run.head_branch && job.status === 'completed' && job.conclusion === 'success' &&
    job.url === `${api}/actions/jobs/${jobId}` && job.run_url === `${api}/actions/runs/${id}`, 'JOB');
  const start = utc(job.started_at);
  const end = utc(job.completed_at);
  check(start <= end && Array.isArray(job.steps), 'STEPS');
  const windows = new Map();
  let lastNumber = 0;
  let lastEnd = start;
  for (const name of (trusted ? [INIT, ...STEPS, STOP] : STEPS)) {
    const rows = job.steps.filter((step) => step?.name === name);
    const step = rows[0];
    check(rows.length === 1 && positive(step.number) && step.number > lastNumber &&
      job.steps.filter((row) => row?.number === step.number).length === 1 &&
      step.status === 'completed' && step.conclusion === 'success', 'STEPS');
    const low = utc(step.started_at);
    const high = utc(step.completed_at);
    check(lastEnd <= low && low <= high && high <= end, 'STEP_TIME');
    windows.set(name, [low, high + 1000]);
    lastNumber = step.number;
    lastEnd = high;
  }
  return { api, repo, run, windows };
}

function parseCiSteps(text) {
  const code = 'CHECKOUT_SOURCE';
  check(!/[\r\0\u0085\u2028\u2029\uFEFF]/.test(text) && text.endsWith('\n'), code);
  const lines = text.split('\n');
  const tokens = [];
  for (const [line, raw] of lines.entries()) {
    const indent = /^ */.exec(raw)[0].length;
    const body = raw.slice(indent);
    if (!body || body.startsWith('#')) continue;
    tokens.push({ line, indent, text: body });
  }
  let next = 0;
  const field = /^([A-Za-z_][A-Za-z0-9_.-]*):(?: +([^\t]*))?$/;
  const atom = /^(?:[A-Za-z0-9_./:@-]+|'(?:[^'\r\n]|'')*')$/;
  function scalar(value) {
    if (value.startsWith('[') || value.startsWith('{')) {
      const isList = value[0] === '[';
      check(value.endsWith(isList ? ']' : '}'), code);
      const parts = value.slice(1, -1).split(',').map((entry) => entry.trim());
      const keys = new Set();
      for (const item of parts) {
        if (isList) check(atom.test(item), code);
        else {
          const pair = field.exec(item);
          check(pair && atom.test(pair[2] ?? '') && !keys.has(pair[1]), code);
          keys.add(pair[1]);
        }
      }
    } else if (value.startsWith("'")) check(atom.test(value), code);
    else {
      const indicator = /^["!&*%>@`|,\]}]|^[-?:](?: |$)/;
      check(!indicator.test(value) && !/:(?: |$)/.test(value), code);
    }
    return value;
  }

  // Read this repository's block layout by parent and indentation. Only block scalar content is opaque.
  function mapping(depth, path, first) {
    check(depth <= 12 && (first || tokens[next]?.indent === depth), code);
    const fields = new Map();
    let end;
    while (first || tokens[next]?.indent === depth) {
      const token = first ?? tokens[next++];
      first = null;
      end = token.line + 1;
      const match = field.exec(token.text);
      check(match && !fields.has(match[1]), code);
      const [, key, raw = ''] = match;
      const structural = path.length === 0 || (path[0] === 'jobs' &&
        (path.length <= 2 || (path.length === 3 && path[2] === 'steps')));
      check(!structural || key === key.toLowerCase(), code);
      const value = /^['"[{]/.test(raw) ? raw.trimEnd() : raw.replace(/(?:^| +)#.*$/, '').trimEnd();
      let parsed = null;
      const isSteps = path.length === 2 && path[0] === 'jobs' && key === 'steps';
      if (isSteps) check(!value && tokens[next]?.indent === depth + 2, code);
      if (/^\|[+-]?$/.test(value)) {
        // A line that looks like a YAML comment can be literal shell content.
        const indent = ' '.repeat(depth + 2);
        let content = false;
        while (end < lines.length) {
          const line = lines[end];
          if (!/^ *$/.test(line)) {
            if (!line.startsWith(indent)) break;
            check(content || line[depth + 2] !== ' ', code);
            content = true;
          }
          end++;
        }
        check(content, code);
        while (tokens[next]?.line < end) next++;
      } else if (value) {
        parsed = scalar(value);
      } else if (tokens[next]?.indent > depth) {
        if (isSteps) {
          parsed = [];
          while (tokens[next]?.indent === depth + 2) {
            const item = tokens[next++];
            check(item.text.startsWith('- '), code);
            const step = mapping(depth + 4, [...path, key], { ...item, text: item.text.slice(2) });
            const [name, uses] = [step.fields.get('name'), step.fields.get('uses')];
            check([name, uses].every((label) => label === undefined ||
              (typeof label === 'string' && !/^[\[{'"\]]/.test(label) && !label.includes('${{'))), code);
            parsed.push({ ...step, start: item.line });
            end = step.end;
          }
        } else {
          const child = mapping(depth + 2, [...path, key]);
          parsed = child.fields;
          end = child.end;
        }
      }
      check(!(tokens[next]?.indent > depth), code);
      fields.set(key, parsed);
    }
    return { fields, end };
  }

  const { fields: root } = mapping(0, []);
  check(next === tokens.length, code);
  const jobs = root.get('jobs');
  check(jobs instanceof Map && [...jobs].every(([key, job]) =>
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) && job instanceof Map), code);
  const e2e = jobs.get('e2e');
  check(e2e instanceof Map && Array.isArray(e2e.get('steps')), code);
  return { lines, steps: e2e.get('steps') };
}

function verifyWorkflowSources(repo, commit) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = spawnSync('git', ['--no-replace-objects', '-C', repo, 'cat-file', 'blob', `${commit}:.github/workflows/ci.yml`],
    { env, timeout: 20_000, maxBuffer: MIB });
  check(result.status === 0, 'BUILD_STEP_PIN');
  let text;
  try { text = utf8.decode(result.stdout); } catch { check(false, 'CHECKOUT_SOURCE'); }
  const { lines, steps } = parseCiSteps(text);
  const block = ({ start, end }) => `${lines.slice(start, end).join('\n').replace(/\n+$/, '')}\n`;
  const builds = steps.filter(({ fields }) => fields.get('name') === BUILD);
  check(builds.length === 1 && digest(Buffer.from(block(builds[0]))) === BUILD_STEP_SHA, 'BUILD_STEP_PIN');
  const checkout = steps.filter(({ fields }) => fields.get('name') === CHECKOUT || /^actions\/checkout@/i.test(fields.get('uses') ?? ''));
  check(checkout.length === 1 && block(checkout[0]) === '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n',
    'CHECKOUT_SOURCE');
}

function logRecords(directory, windows, trusted) {
  const raw = read(path.join(directory, 'job.log'), 16 * MIB, 'LOG');
  if (trusted) check(sameSha(trusted.jobLog, digest(raw)), 'LOG_DIGEST');
  let text;
  try { text = utf8.decode(raw); } catch { check(false, 'LOG'); }
  const rows = new Map([...windows.keys()].map((name) => [name, []]));
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = /^\ufeff?e2e\t([^\t]+)\t\ufeff?(\S+) (.*)$/.exec(line);
    if (match && rows.has(match[1])) rows.get(match[1]).push({ index, time: utc(match[2], true), timestamp: match[2], text: match[3] });
  }
  const markers = trusted ? [PROBE_MARKERS[0], PG_CONTAINER_MARKER, ...PROBE_MARKERS.slice(1, -1),
    HANDOFF_MARKER, PROBE_MARKERS.at(-1)] : PROBE_MARKERS;
  const observed = new Set(rows.get(PROBE).map((row) => markers.find((marker) => row.text.startsWith(marker))).filter(Boolean));
  check(equal([...observed], markers.filter((marker) => observed.has(marker))), 'LOG_ORDER');
  const validated = new Map();
  const facts = new Map();
  function validateRow(step, row, pattern, code) {
    const [low, high] = windows.get(step);
    const match = row && pattern.exec(row.text);
    check(match && low <= row.time && row.time < high, code);
    validated.set(match, row);
    return match;
  }
  function one(step, prefix, pattern, code) {
    const matching = rows.get(step).filter((row) => typeof prefix === 'string' ? row.text.startsWith(prefix) : prefix.test(row.text));
    check(matching.length === 1, code);
    const match = validateRow(step, matching[0], pattern, code);
    if (step === PROBE) facts.set(prefix, match);
    return match;
  }
  function following(step, previous, pattern, code) {
    const next = rows.get(step).find((row) => row.index === validated.get(previous).index + 1);
    return validateRow(step, next, pattern, code);
  }
  function ordered(matches, code) {
    // Canonical UTC strings retain all seven digits for ordering across sub-millisecond log entries.
    const orderedRows = matches.map((match) => validated.get(match));
    check(orderedRows.every((row, index) => row && (index === 0 ||
      (orderedRows[index - 1].index < row.index && orderedRows[index - 1].timestamp <= row.timestamp))), code);
  }
  return { one, following, ordered, verifyProbeChronology: () => ordered(markers.map((marker) => facts.get(marker)), 'LOG_ORDER') };
}

function checkoutFacts(log, subject, trusted) {
  const { one, following, ordered } = log;
  const { sha, tree } = subject.checkout;
  const { id, attempt, ref } = subject.run;
  const event = subject.build.record.runner.event;
  check((event === 'pull_request' && /^refs\/pull\/[1-9]\d*\/merge$/.test(ref)) ||
    (event === 'push' && ref === 'refs/heads/main'), 'CHECKOUT');
  const exactCommit = new RegExp(`^${sha}$`);
  one(CHECKOUT, sha, exactCommit, 'CHECKOUT');
  let fetched;
  if (event === 'pull_request') {
    fetched = one(CHECKOUT, ' * [new ref]', new RegExp(`^ \\* \\[new ref\\]\\s+${sha} -> ${ref.slice(5)}$`), 'CHECKOUT_REF');
  }
  if (trusted) {
    const command = /^(?:##)?\[command\]\/usr\/bin\/git log -1 --format=%H$/;
    const gitLog = one(CHECKOUT, command, command, 'CHECKOUT_COMMAND');
    const output = following(CHECKOUT, gitLog, exactCommit, 'CHECKOUT_COMMAND');
    ordered([fetched, gitLog, output], 'CHECKOUT_COMMAND');
  }
  const buildOk = one(BUILD, 'E2E_TEST_BUILD_OK',
    new RegExp(`^E2E_TEST_BUILD_OK build_id=(${BUILD_ID}) server_js_sha256=(${HEX})$`), 'BUILD_LOG');
  const [, buildId, buildSha] = buildOk;
  let sourceBytes;
  if (trusted) {
    const info = one(BUILD, 'E2E_TEST_BUILD_SOURCE', new RegExp(`^E2E_TEST_BUILD_SOURCE root_build_id=(${BUILD_ID}) ` +
      `standalone_build_id=(${BUILD_ID}) server_js_bytes=([1-9][0-9]{0,15}) server_js_sha256=(${HEX})$`), 'BUILD_SOURCE');
    const [, rootId, standaloneId, bytes, sha] = info;
    sourceBytes = Number(bytes);
    check(rootId === buildId && standaloneId === buildId && positive(sourceBytes) && sameSha(sha, buildSha), 'BUILD_SOURCE');
    ordered([info, buildOk], 'BUILD_SOURCE');
  }
  check(buildId === subject.e2eBuildId && !Object.values(subject.build.record.builds)
    .some((row) => sameSha(row.serverJs.sha256, buildSha)), 'BUILD_ID');
  const context = { runId: id, runAttempt: attempt, job: 'e2e', head: sha, tree, buildId };
  const [, contextText] = one(PROBE, 'J7_RUN_CONTEXT=', /^J7_RUN_CONTEXT=(\{.*\})$/, 'CONTEXT');
  check(contextText === JSON.stringify(context), 'CONTEXT');
  const [, firstText] = one(PROBE, 'J7_FIRST_APP_BINDING=', /^J7_FIRST_APP_BINDING=(\{.*\})$/, 'FIRST_APP');
  const { pid, startTicks } = json(Buffer.from(firstText), 'FIRST_APP');
  check(positive(pid) && pid > 1 && typeof startTicks === 'string' && /^[1-9]\d{0,19}$/.test(startTicks) &&
    firstText === JSON.stringify({ runId: id, runAttempt: attempt, job: 'e2e', event, ref, head: sha, tree, pid, startTicks }), 'FIRST_APP');
  const [, version, cluster] = one(PROBE, 'J7_PG_IDENTITY ',
    new RegExp(`^J7_PG_IDENTITY version=(17[0-9]{4}) cluster=(${HEX}) fullDb=e2e$`), 'PG_LOG');
  check(!/^0+$/.test(cluster), 'PG_LOG');
  return {
    run: { workflow: 'CI', job: 'e2e', id, attempt },
    source: { commit: sha, tree, event, ref },
    app: { origin: 'http://localhost:3100', pid, startTicks },
    buildId, buildSha, sourceBytes,
    pg: { versionNum: Number(version), database: 'e2e', clusterSha256: cluster },
  };
}

function platformPostgres(log, runnerDone) {
  const { one, following, ordered } = log;
  const observed = one(PROBE, PG_CONTAINER_MARKER,
    /^J7_PG_CONTAINER id=([0-9a-f]{64}) source=env docker-exec-read$/, 'PG_CONTAINER');
  const [, containerId] = observed;
  const name = '[a-z0-9]+_postgres17_[a-z0-9]+';
  const command = '^(?:##)?\\[command\\]/usr/bin/docker ';
  const createPattern = new RegExp(`${command}create --name (${name}) .+ postgres:17$`);
  const create = one(INIT, createPattern, createPattern, 'PG_PLATFORM_INIT');
  const exactId = new RegExp(`^${containerId}$`);
  const created = following(INIT, create, exactId, 'PG_PLATFORM_INIT');
  const startPattern = new RegExp(`${command}start ${containerId}$`);
  const start = one(INIT, startPattern, startPattern, 'PG_PLATFORM_INIT');
  const started = following(INIT, start, exactId, 'PG_PLATFORM_INIT');
  const logs = one(STOP, 'Print service container logs: ', new RegExp(`^Print service container logs: (${name})$`), 'PG_PLATFORM_STOP');
  const logCommand = following(STOP, logs, new RegExp(`${command}logs --details ${containerId}$`), 'PG_PLATFORM_STOP');
  const remove = one(STOP, 'Stop and remove container: ', new RegExp(`^Stop and remove container: (${name})$`), 'PG_PLATFORM_STOP');
  const rm = following(STOP, remove, new RegExp(`${command}rm --force ${containerId}$`), 'PG_PLATFORM_STOP');
  const removed = following(STOP, rm, exactId, 'PG_PLATFORM_STOP');
  check(create[1] === logs[1] && create[1] === remove[1], 'PG_PLATFORM_STOP');
  ordered([create, created, start, started], 'PG_PLATFORM_INIT');
  ordered([logs, logCommand, remove, rm, removed], 'PG_PLATFORM_STOP');
  ordered([started, observed], 'PG_PLATFORM_ORDER');
  ordered([runnerDone, logs], 'PG_PLATFORM_ORDER');
  return { containerId, removal: 'actions-stop-containers' };
}

function archiveFor(directory, work, list, platformData, one, { base, name, step, members }) {
  const { repo, run, api, windows } = platformData;
  const code = 'ARTIFACT';
  const detail = json(read(path.join(directory, `${base}-artifact.json`), MIB, code), code);
  const rows = list.artifacts.filter((entry) => entry?.name === name);
  const { id, size_in_bytes: size, digest: zip, workflow_run: context } = detail;
  const max = (members.length + 1) * MIB;
  check(rows.length === 1 && detail.name === name && positive(id) && list.artifacts.filter((entry) => entry?.id === id).length === 1 &&
    detail.url === `${api}/actions/artifacts/${id}` && detail.expired === false && positive(size) && size <= max &&
    typeof zip === 'string' && /^sha256:[0-9a-f]{64}$/.test(zip) && context?.id === run.id &&
    context.repository_id === repo.id && context.head_repository_id === run.head_repository.id && context.head_sha === run.head_sha &&
    context.head_branch === run.head_branch &&
    ['id', 'name', 'digest', 'size_in_bytes', 'expired', 'created_at', 'expires_at', 'workflow_run']
      .every((key) => equal(rows[0][key], detail[key])), code);
  const [low, high] = windows.get(step);
  const created = utc(detail.created_at);
  const expires = utc(detail.expires_at);
  check(low <= created && created < high && created < expires && Date.now() < expires, 'ARTIFACT_TIME');
  const zipSha = zip.slice(7);
  const claims = [
    ['SHA256 digest of uploaded artifact zip is ', `SHA256 digest of uploaded artifact zip is ${zipSha}`],
    [`Artifact ${name}.zip successfully finalized.`, `Artifact ${name}.zip successfully finalized. Artifact ID ${id}`],
    [`Artifact ${name} has been successfully uploaded!`, `Artifact ${name} has been successfully uploaded! Final size is ${size} bytes. Artifact ID is ${id}`],
    ['Artifact download URL: ', `Artifact download URL: https://github.com/${repo.full_name}/actions/runs/${run.id}/artifacts/${id}`],
  ];
  for (const [prefix, line] of claims) {
    const [, value] = one(step, prefix, /^(.*)$/, 'UPLOAD_LOG');
    check(value === line, 'UPLOAD_LOG');
  }
  const archive = read(path.join(directory, `${base}.zip`), max, 'ARCHIVE');
  check(archive.length === size, 'ARCHIVE_SIZE');
  const files = extractArchive(archive, zipSha, path.join(work, `${base}.zip`), members, 'E_J7_RUNNER');
  return { files, artifactId: id, artifactName: name, zipSha256: zipSha };
}

function report(bytes) {
  return { value: json(bytes, 'REPORT'), bytes: bytes.length, sha256: digest(bytes).toUpperCase() };
}

function admittedCleanup(attachment, full, nodata, identity, repository, build, requireLegacyServiceTag) {
  let observation;
  try {
    observation = admitCleanup(attachment, full, nodata, {
      ...identity, run: { ...identity.run, ref: identity.source.ref }, build, requireLegacyServiceTag,
    });
  }
  catch (error) {
    check(false, error instanceof CleanupError ? error.message : 'CLEANUP');
  }
  const { value } = attachment;
  const observed = observation.build;
  const { full: fullApp, fresh: freshApp } = observation;
  check(observed.serverJs.bytes === build.serverJsBytes && sameSha(observed.serverJs.sha256, build.serverJsSha256) &&
    equal(observed.appEnvAtBuild, ['test']) && observed.productionIdentity?.present === false, 'BUILD_BIND');
  check(value.run.repository === repository && value.db.service.versionNum === identity.pg.versionNum &&
    sameSha(value.db.service.clusterSha256, identity.pg.clusterSha256) && value.db.service.systemIdentifierRead === true &&
    value.db.full.database === identity.pg.database && value.db.full.existsVerified === true &&
    value.db.fresh.identityVerified === true, 'PG_BIND');
  const [fullPort, freshPort, turnstile] = [3100, 3101, 3999].map((port) => value.ports.find((row) => row.port === port));
  check(fullApp.pid === identity.app.pid && fullApp.pid !== freshApp.pid && fullPort.duringPid === fullApp.pid &&
    freshPort.duringPid === freshApp.pid && fullPort.duringOwner === 'app' && freshPort.duringOwner === 'app' &&
    turnstile.duringPid === null && turnstile.duringOwner === 'unknown', 'LISTENER_BIND');
  const { ports, roles, ...projection } = observation.projection;
  return { ...projection, ports: ports.map(({ port, host, observedBy, state, before, during, duringPid, duringOwner, after, afterProbeExit }) =>
    ({ port, host, observedBy, state, before, during, duringPid, duringOwner, after, afterProbeExit })),
    roles: roles.map(({ role, exit }) => ({ role, exit })) };
}

function admitRunnerBindingFixture(directory, root, repo, subject, jobId, work, trustedExpectFile) {
  const trusted = trustedExpectation(trustedExpectFile, root, subject, jobId);
  if (trusted) verifyWorkflowSources(repo, subject.checkout.sha);
  const platformData = platform(root, subject, jobId, trusted);
  const log = logRecords(directory, platformData.windows, trusted);
  const { one, verifyProbeChronology } = log;
  const identity = checkoutFacts(log, subject, trusted);
  const runnerCompleted = () => one(PROBE, 'J7_RUNNER_OK', /^J7_RUNNER_OK$/, 'RUNNER_OK');
  const pgService = trusted ? platformPostgres(log, runnerCompleted()) : null;
  const { id, attempt } = identity.run;
  const { buildId, buildSha, sourceBytes } = identity;
  let build = { buildId, serverJsBytes: sourceBytes, serverJsSha256: buildSha.toLowerCase() };
  const serverFile = path.join(directory, 'server.js');
  if (!trusted || fs.lstatSync(serverFile, { throwIfNoEntry: false })) {
    const server = read(serverFile, MIB, 'BUILD_BYTES');
    check(sameSha(buildSha, digest(server)) && (!trusted || sourceBytes === server.length), 'BUILD_BYTES');
    build = { ...build, serverJsBytes: server.length };
  }
  const list = json(read(path.join(directory, 'artifacts.json'), MIB, 'ARTIFACT'), 'ARTIFACT');
  check(Array.isArray(list.artifacts) && list.total_count === list.artifacts.length, 'ARTIFACT');
  const artifacts = [
    { base: 'main', name: 'j7-attribution-receipt', step: MAIN_UPLOAD, members: MAIN },
    { base: 'retryable', name: `j7-retryable-${id}-${attempt}`, step: RETRY_UPLOAD, members: [RETRY] },
    { base: 'binding', name: `j7-runner-binding-${id}-${attempt}`, step: BIND_UPLOAD, members: [BINDING] },
  ];
  const [primary, retryable, binding] = artifacts.map((artifact) => archiveFor(directory, work, list, platformData, one, artifact));
  const [probe, nodata, cleanup] = MAIN.map((name) => report(primary.files[name]));
  const [, mainSha, nodataSha, cleanupSha, gatedBuild, freshDb] = one(PROBE, 'J7_SAFE_FILES ',
    new RegExp(`^J7_SAFE_FILES ok=3 attribution=(${HEX}) nodata=(${HEX}) cleanup=(${HEX}) buildId=(${BUILD_ID}) freshDb=(${FRESH_DB})$`), 'SAFE_FILES');
  check(sameSha(mainSha, probe.sha256) && sameSha(nodataSha, nodata.sha256) && sameSha(cleanupSha, cleanup.sha256) &&
    gatedBuild === buildId && freshDb === nodata.value.pg?.database, 'SAFE_FILES');
  const [, dropDb, dropVersion] = one(PROBE, 'J7_DB name=',
    new RegExp(`^J7_DB name=(${FRESH_DB}) created=1 dropped=1 gone=1 version=(17[0-9]{4})$`), 'DROP_LOG');
  check(freshDb === dropDb && Number(dropVersion) === identity.pg.versionNum, 'DROP_LOG');
  one(PROBE, 'J7_PORT_OBS after=', /^J7_PORT_OBS after=free ports=3100,3101,3999 probe=ports\.cjs\+3101$/, 'PORT_LOG');
  if (!trusted) runnerCompleted();
  const cleanupProjection = admittedCleanup(cleanup, probe, nodata, identity, platformData.repo.full_name, build, !pgService);

  const retryMember = retryable.files[RETRY];
  const [, retryAnchor, retrySha] = one(PROBE, 'J7_RETRYABLE_BOUND ',
    new RegExp(`^J7_RETRYABLE_BOUND ok=1 anchor=(${HEX}) sha=(${HEX})$`), 'RETRYABLE_MEMBER');
  check(sameSha(retryAnchor, probe.sha256) && sameSha(retrySha, digest(retryMember)), 'RETRYABLE_MEMBER');
  const [, preSha, preSize, ticks] = one(PROBE, 'J7_RUNNER_BINDING ',
    new RegExp(`^J7_RUNNER_BINDING sha256=(${HEX}) bytes=([1-9]\\d{0,6}) startTicks=([1-9]\\d{0,19})$`), 'BINDING_PRE');
  check(ticks === identity.app.startTicks, 'BINDING_PRE');
  if (trusted) {
    const [, handoffRetry, handoffBinding] = one(PROBE, HANDOFF_MARKER,
      new RegExp(`^J7_UPLOAD_HANDOFF ok=2 retryableSha=(${HEX}) bindingPreFinalizedSha=(${HEX})$`), 'HANDOFF');
    check(sameSha(handoffRetry, retrySha) && sameSha(handoffBinding, preSha), 'HANDOFF');
  }
  verifyProbeChronology();
  const [, finalId, finalDigest] = one(FINALIZE, 'J7_RUNNER_BINDING_UPLOAD ',
    new RegExp(`^J7_RUNNER_BINDING_UPLOAD artifactId=([1-9]\\d*) zipSha256=((?:sha256:)?${HEX})$`), 'FINALIZE');
  check(finalId === String(retryable.artifactId) && sameSha(finalDigest.replace(/^sha256:/, ''), retryable.zipSha256), 'FINALIZE');

  const bindingBytes = binding.files[BINDING];
  const { upload, ...preFinal } = json(bindingBytes, 'BINDING_MEMBER');
  const original = jsonBytes(preFinal);
  check(sameSha(preSha, digest(original)) && original.length === Number(preSize), 'BINDING_MEMBER');
  const uploadExpected = { artifactName: retryable.artifactName, artifactId: finalId, zipSha256: finalDigest };
  const finalized = jsonBytes({ ...preFinal, upload: uploadExpected });
  check(equal(upload, uploadExpected) && bindingBytes.equals(finalized), 'BINDING_MEMBER');
  const cleanupState = { outcome: cleanup.value.outcome, phase: cleanup.value.phase,
    appStopped: cleanupProjection.appStopped, probeExited: cleanupProjection.probeExited };
  const expected = { schema: 'j7-runner-binding/1', run: identity.run, source: identity.source, app: identity.app,
    build: { ...build, serverJsSha256: preFinal.build?.serverJsSha256 },
    pg: { ...identity.pg, clusterSha256: preFinal.pg?.clusterSha256,
      ...(pgService ? { containerId: pgService.containerId } : {}) },
    probe: { mainFullSha256: preFinal.probe?.mainFullSha256 },
    retryable: { fileSha256: preFinal.retryable?.fileSha256, fileBytes: retryMember.length }, cleanup: cleanupState };
  check(equal(preFinal, expected) && sameSha(expected.build.serverJsSha256, build.serverJsSha256) &&
    sameSha(expected.pg.clusterSha256, identity.pg.clusterSha256) && sameSha(expected.probe.mainFullSha256, probe.sha256) &&
    sameSha(expected.retryable.fileSha256, digest(retryMember)), 'BINDING_FACTS');

  const { commit, tree } = identity.source;
  const { serverJsBytes, ...retryBuild } = build;
  const retryExpect = jsonBytes({ schema: 'j7-retryable-expect/1', run: identity.run, source: { commit, tree },
    build: retryBuild, pg: identity.pg, app: identity.app, probeSha256: probe.sha256,
    expectedFailedGeneration: probe.value.failureAttribution?.failed?.generation });
  const admitted = runAdmit({ repo, subject, expect: retryExpect, probe: primary.files[MAIN[0]],
    member: retryMember, memberSha256: retrySha, work });
  return { ...admitted, fixture: true, e2eJobId: jobId, app: identity.app, build, pg: identity.pg,
    ...(trusted ? { buildBasis: 'authenticated-build-step', platformPg: pgService, sourceSha256: trusted } : {}),
    cleanup: cleanupProjection, archive: [primary, retryable, binding].map(({ files, ...info }) => ({
      ...info, members: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes) })),
    })) };
}

module.exports = { admitRunnerBindingFixture };
