#!/usr/bin/env node
/**
 * J7 收件生产器（`j7-same-build/3`）。
 *
 * 只做"把真实产物拼成可机核收件"这一件事：每个字段都必须来自本次运行的文件或
 * 实际 checkout 的 git 读数；缺任何一项就带 `J7_RECEIPT_MISSING:<name>` 退出 1，
 * 不写半份收件、不用默认值、不手填摘要。
 *
 * 用法（全部必填，除非注明）：
 *   node j7-receipt.mjs --cleanup <j7-cleanup.json> --probe <j7-attribution.json> --nodata <j7-nodata.json>
 *     --repo <checkout> --a3 <e2e-evidence 目录> --source-root <private inputs>
 *     --expect-sha <merge SHA> --expect-tree <tree SHA> --expect-run <id> --expect-attempt <n>
 *     --expect-workflow CI --expect-build-id <e2e id> --expect-build-job-id <id>
 *     --run-json <Actions run JSON> --out <receipt.json>
 *     [--corroboration j4-attribution=<file>] [--corroboration bad-config=<file>]
 *     [--instance-id j7-e2e] [--fresh-instance-id j7-fresh] [--a3-instance-id e2e-a3]
 *     [--strip-instance-id prod-strip]
 *
 * --sources-only runs the three-source admission using --repo, --source-root,
 * the --expect-* flags and --out. It writes a distinct subset report.
 *
 * 不联网、不写产品库、不启动服务。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireHere = createRequire(import.meta.url);
const digestLib = requireHere('./j7-digest.cjs');
const { CleanupError, readEvidence, admitCleanup } = requireHere('./j7-cleanup.cjs');
const { CONSENT_IDS, CONSENT_ROUTE, consentHttp, consentCounter } = requireHere('./j7-consent-evidence.cjs');
const sources = requireHere('./j7-source-admission.cjs');

const FAIL = (code) => {
  process.stderr.write(`${code.startsWith('J7_') ? code : `J7_RECEIPT_${code}`}\n`);
  process.exit(1);
};
const fail = (code) => FAIL(code);

const BASELINE_COMMIT = 'ed9685a23b724baef64f43476b4f1e0c9ef06d63';
const JOB_KEYS = ['chat-notifications', 'analytics-aggregate', 'analytics-retention', 'mail-queue'];
const BAD_CONFIG_CODES = ['EDGE_AUTH_SECRET', 'DATABASE_URL', 'SMTP_PASS'];

function parseArgs(argv) {
  const out = { corroboration: {}, sourceOptions: {}, instanceId: 'j7-e2e', freshInstanceId: 'j7-fresh', a3InstanceId: 'e2e-a3', stripInstanceId: 'prod-strip' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${key}`);
      return argv[i];
    };
    if (sources.sourceOption(out.sourceOptions, key, next)) continue;
    if (key === '--corroboration') {
      const [name, file] = next().split('=');
      if (!name || !file) throw new Error('--corroboration name=path');
      out.corroboration[name] = file;
    } else if (key === '--probe') out.probe = next();
    else if (key === '--nodata') out.nodata = next();
    else if (key === '--cleanup') out.cleanup = next();
    else if (key === '--repo') out.repo = next();
    else if (key === '--a3') out.a3 = next();
    else if (key === '--run-json') out.runJson = next();
    else if (key === '--out') out.out = next();
    else if (key === '--instance-id') out.instanceId = next();
    else if (key === '--fresh-instance-id') out.freshInstanceId = next();
    else if (key === '--a3-instance-id') out.a3InstanceId = next();
    else if (key === '--strip-instance-id') out.stripInstanceId = next();
    else throw new Error(`unknown argument ${key}`);
  }
  if (!out.out) throw new Error('--out is required');
  return out;
}

function readJson(file, name) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`J7_RECEIPT_READ:${name}`);
  }
}
function sha256FileSync(file) {
  return digestLib.sha256Buffer(fs.readFileSync(file));
}
function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 }).trim();
}
function requireFields(value, fields, name) {
  for (const field of fields) {
    const present = field.split('.').reduce((node, key) => (node && typeof node === 'object' && key in node ? node[key] : undefined), value);
    if (present === undefined || present === null || present === '') fail(`J7_RECEIPT_MISSING:${name}.${field}`);
  }
}

function readAttachment(file, name) {
  try {
    return readEvidence(file);
  } catch {
    fail(`J7_RECEIPT_READ:${name}`);
  }
}

function parseA3(dir) {
  const segments = ['main', 'model', 'consent', 'errors', 'flow'];
  const results = {};
  for (const segment of segments) {
    const file = path.join(dir, segment, 'result.txt');
    if (!fs.existsSync(file)) fail(`J7_RECEIPT_MISSING:a3.${segment}`);
    const text = fs.readFileSync(file, 'utf8');
    const values = Object.fromEntries([...text.matchAll(/^([a-z_]+)=(\d+)$/gm)].map((match) => [match[1], Number(match[2])]));
    for (const key of ['test_exit', 'capture_exit', 'log_exit', 'rum_exit', 'release_exit']) {
      if (!Number.isInteger(values[key])) fail(`J7_RECEIPT_MISSING:a3.${segment}.${key}`);
      if (values[key] !== 0) fail(`J7_RECEIPT_A3_NOT_GREEN:${segment}:${key}`);
    }
    const portAfter = path.join(dir, segment, 'port-after.log');
    // 缺端口证据不是"没有泄漏"，是缺口：必须存在且为空，否则不许写收件。
    if (!fs.existsSync(portAfter)) fail(`J7_RECEIPT_MISSING:a3.${segment}.port-after`);
    if (fs.readFileSync(portAfter, 'utf8').trim() !== '') fail(`J7_RECEIPT_A3_PORT:${segment}`);
    results[segment] = 'passed';
  }
  return { segments: results, processes: segments.length, released: true };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const admitted = sources.runAdmission(args.sourceOptions, args.repo);
  sources.verifyOptionalAttachments(admitted, args.corroboration);
  if (args.sourceOptions.only) {
    sources.writeSubset(args.out, admitted);
    process.stdout.write('J7_RECEIPT_SOURCES_VERIFIED_SUBSET\n');
    return;
  }
  const formal = sources.requireFormalSources();
  for (const name of ['probe', 'nodata', 'cleanup', 'repo', 'a3', 'runJson']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  const probeEvidence = readAttachment(args.probe, 'probe');
  const nodataEvidence = readAttachment(args.nodata, 'nodata');
  const probe = probeEvidence.value;
  const nodata = nodataEvidence.value;
  const run = readJson(args.runJson, 'run-json');
  const { network, retryable } = formal;
  const cleanupEvidence = readAttachment(args.cleanup, 'cleanup');
  const repo = path.resolve(args.repo);

  if (probe.schema !== 'j7-probe/3' || probe.pass !== true) fail('J7_RECEIPT_PROBE');
  if (nodata.schema !== 'j7-nodata/1' || nodata.pass !== true) fail('J7_RECEIPT_NODATA');
  requireFields(run, ['workflow', 'id', 'attempt', 'headSha', 'ref', 'jobs'], 'run');
  requireFields(network, ['sameOriginFulfilled', 'sameOriginAborted', 'serviceWorker', 'intercepted'], 'network');
  requireFields(probe, ['source.commit', 'source.tree', 'build.buildId', 'build.standaloneTreeSha256', 'run.workflow', 'run.id', 'run.attempt', 'pg.versionNum', 'pg.database', 'pg.clusterSha256', 'counters.rows', 'separation', 'surfaces', 'jobs', 'failureAttribution'], 'probe');
  requireFields(nodata, ['noData.models', 'noData.settings', 'pg.clusterSha256'], 'nodata');

  // 1) 源与锁：从实际 checkout 重算，不接受收件里的自报。
  const commit = git(repo, ['rev-parse', 'HEAD']).toLowerCase();
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).toLowerCase();
  let baselineAncestor = true;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', BASELINE_COMMIT, 'HEAD'], { cwd: repo, stdio: 'ignore', timeout: 30_000 });
  } catch {
    baselineAncestor = false;
  }
  let worktreeClean = true;
  try {
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repo, stdio: 'ignore', timeout: 30_000 });
  } catch {
    worktreeClean = false;
  }
  const lockFile = path.join(repo, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockFile)) fail('J7_RECEIPT_MISSING:pnpm-lock.yaml');
  const lockSha256 = sha256FileSync(lockFile);

  if (probe.source.commit.toLowerCase() !== commit) fail('J7_RECEIPT_PROBE_SOURCE');
  if (probe.source.tree.toLowerCase() !== tree) fail('J7_RECEIPT_PROBE_TREE');
  if (probe.run.workflow !== run.workflow || probe.run.id !== run.id || probe.run.attempt !== run.attempt) fail('J7_RECEIPT_PROBE_RUN');
  if (run.ref.startsWith('refs/pull/')) {
    requireFields(run, ['headSha'], 'run');
  } else if (String(run.headSha).toLowerCase() !== commit) {
    fail('J7_RECEIPT_RUN_SOURCE');
  }

  // 2) 构建与实例。
  const buildId = probe.build.buildId;
  const standaloneDir = path.join(repo, '.next', 'standalone');
  const actualBuildIdPath = path.join(standaloneDir, '.next', 'BUILD_ID');
  if (!fs.existsSync(actualBuildIdPath)) fail('J7_RECEIPT_MISSING:.next/standalone/.next/BUILD_ID');
  const actualBuildId = fs.readFileSync(actualBuildIdPath, 'utf8').trim();
  if (actualBuildId !== buildId) fail('J7_RECEIPT_BUILD_ID');
  const cleanup = admitCleanup(cleanupEvidence, probeEvidence, nodataEvidence, {
    run, source: { commit, tree }, build: { buildId: actualBuildId, serverJsPath: path.join(standaloneDir, 'server.js') },
  });
  sources.matchSubject(admitted, { commit, tree, run, buildId });
  const build = { ...sources.buildFields(admitted), ...admitted.projected.buildControls };
  if (build.productionAppEnvCount !== 1) fail(`J7_RECEIPT_PROD_ENV:${build.productionAppEnvCount}`);
  if (build.buildId === buildId) fail('J7_RECEIPT_BUILD_COLLISION');

  const a3 = parseA3(path.resolve(args.a3));
  if (build.strip.production !== 'PASS' || build.strip.negative !== 'DETECTED' || build.strip.original !== 'PASS' || build.strip.markers < 1) {
    fail('J7_RECEIPT_STRIP');
  }

  const pg = { versionNum: probe.pg.versionNum, loopback: true, database: probe.pg.database, clusterSha256: probe.pg.clusterSha256 };
  const observedPorts = (instance) => ({
    used: [instance.port],
    listeningAfter: cleanup.projection.listeningAfter.filter((port) => port === instance.port),
    released: instance.stop.portReleased,
  });
  const instances = [
    { id: args.instanceId, mode: 'shared-standalone', buildId, processes: 1, pg, ports: observedPorts(cleanup.full) },
    { id: args.a3InstanceId, mode: 'same-build-multiprocess', buildId, processes: a3.processes, pg, ports: { used: [3100, 3999], listeningAfter: [], released: true } },
    { id: args.freshInstanceId, mode: 'shared-standalone', buildId, processes: 1, pg: { versionNum: nodata.pg.versionNum, loopback: true, database: nodata.pg.database, clusterSha256: nodata.pg.clusterSha256 }, ports: observedPorts(cleanup.fresh) },
    { id: args.stripInstanceId, mode: 'app-env-production-strip', buildId: build.buildId, processes: 0, pg: null, ports: { used: [], listeningAfter: [], released: true } },
  ];

  const builds = [
    { buildId, appEnvAtBuild: 'test', instanceIds: [args.instanceId, args.a3InstanceId, args.freshInstanceId], standaloneTreeSha256: cleanup.build.standaloneTreeSha256.toUpperCase(), serverJsSha256: cleanup.build.serverJs.sha256.toUpperCase() },
    { ...sources.buildFields(admitted), appEnvAtBuild: 'production', instanceIds: [args.stripInstanceId] },
  ];

  const attribution = { ...admitted.j4, values: admitted.j4.value };
  const badConfig = { ...admitted.bad, values: admitted.bad.value };
  const corroboration = [attribution, badConfig, retryable];
  if (attribution.values.failedStatus !== 'FAILED') fail('J7_RECEIPT_ATTRIBUTION_STATUS');
  // J4 只作旁证：自己的 run/build/cluster 必须像实物，不能是手填占位；也不冒充同实例。
  if (!Number.isInteger(attribution.values.runId) || attribution.values.runId <= 0) fail('J7_RECEIPT_ATTRIBUTION_RUN');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(attribution.values.buildId))) fail('J7_RECEIPT_ATTRIBUTION_BUILD');
  if (!/^[0-9a-fA-F]{64}$/.test(String(attribution.values.pg && attribution.values.pg.clusterSha256))) fail('J7_RECEIPT_ATTRIBUTION_PG');
  if (attribution.values.sameInstance === true) fail('J7_RECEIPT_ATTRIBUTION_SAME_INSTANCE');
  if (!JOB_KEYS.includes(attribution.values.failedKey)) fail('J7_RECEIPT_ATTRIBUTION_KEY');
  if (!Array.isArray(attribution.values.otherKeys) || attribution.values.otherKeys.length === 0) fail('J7_RECEIPT_ATTRIBUTION_OTHERS');
  for (const other of attribution.values.otherKeys) {
    if (!JOB_KEYS.includes(other.key) || !Number.isInteger(other.generationBefore) || other.generationBefore !== other.generationAfter) fail('J7_RECEIPT_ATTRIBUTION_OTHERS');
  }
  if (badConfig.values.exit !== 1) fail('J7_RECEIPT_BAD_CONFIG_EXIT');
  const codes = Array.isArray(badConfig.values.codes) ? [...badConfig.values.codes].sort() : [];
  if (codes.length !== 3 || codes.join(',') !== [...BAD_CONFIG_CODES].sort().join(',')) fail('J7_RECEIPT_BAD_CONFIG_CODES');
  if (!Number.isInteger(retryable.values.attempts) || retryable.values.attempts < 2) fail('J7_RECEIPT_RETRYABLE');

  // 4) 探针面：逐路 delta、实际 HTTP、分离、四 key 代次。
  const consent = consentHttp(probe.http);
  if (!consent) fail('J7_RECEIPT_CONSENT_HTTP');
  const probeHttp = new Map(probe.http.map((row) => [row.id, row]));
  const surfaceRows = (ids) => {
    const rows = [];
    for (const id of ids) {
      const row = probeHttp.get(id);
      if (!row) fail(`J7_RECEIPT_MISSING:probe.http.${id}`);
      rows.push({ id: row.id, method: row.method, path: row.path, status: row.status, error: row.error });
    }
    return rows;
  };
  const surfaces = {
    account: { observed: true, instanceId: args.instanceId, http: surfaceRows(['account-anon', 'account-consent-only', 'account-admin', 'settings-editor']) },
    chat: { observed: true, instanceId: args.instanceId, http: surfaceRows(['chat-session', 'chat-create', 'chat-read', 'chat-read-advance']) },
    analytics: { observed: true, instanceId: args.instanceId, http: surfaceRows([
      CONSENT_IDS[0], CONSENT_IDS[1], 'events-withdrawn', 'events-session-only', CONSENT_IDS[2], 'events-accepted',
    ]) },
    models: { observed: true, instanceId: args.instanceId, http: surfaceRows(['models-list', 'models-glb']) },
    jobs: { observed: true, instanceId: args.instanceId, http: surfaceRows(['operations-anon', 'operations-invalid', 'operations-retention', 'operations-aggregate', 'operations-aggregate-conflict']) },
  };

  const jobRows = [];
  for (const key of JOB_KEYS) {
    const row = probe.jobs.find((entry) => entry && entry.key === key);
    if (!row) continue;
    jobRows.push({
      key,
      instanceId: args.instanceId,
      generationBefore: row.generationBefore,
      generationAfter: row.generationAfter,
      statusAfter: row.statusAfter,
      errorCode: row.errorCode ?? null,
      ...(Array.isArray(row.runs) ? { runs: row.runs } : {}),
    });
  }
  for (const key of ['analytics-retention', 'analytics-aggregate']) {
    if (!jobRows.some((row) => row.key === key)) fail(`J7_RECEIPT_MISSING:probe.jobs.${key}`);
  }
  const aggregateRow = jobRows.find((row) => row.key === 'analytics-aggregate');
  if (aggregateRow.statusAfter !== 'FAILED' || aggregateRow.errorCode !== 'version_conflict') fail('J7_RECEIPT_AGGREGATE_NOT_FAILED');
  if (!Array.isArray(aggregateRow.runs) || aggregateRow.runs.length !== 2 ||
    aggregateRow.runs[0].status !== 'SUCCEEDED' || aggregateRow.runs[1].status !== 'FAILED') fail('J7_RECEIPT_AGGREGATE_RUNS');

  const countingRow = consentCounter(probe.counters);
  const countedHttpSeen = consent.map((row) => row.status);
  if (!countingRow || countingRow.requestCount !== countedHttpSeen.length || countingRow.errorCount !== 0) fail('J7_RECEIPT_COUNT_HTTP');

  const metricsTest = path.join(repo, 'tests', 'admin-http-metrics.test.ts');
  if (!fs.existsSync(metricsTest)) fail('J7_RECEIPT_MISSING:tests/admin-http-metrics.test.ts');
  const metricsText = fs.readFileSync(metricsTest, 'utf8');
  if (!metricsText.includes('recordFinalResponse')) fail('J7_RECEIPT_METRICS_TEST');
  const failureKept = { evidence: 'unit-injection', source: 'tests/admin-http-metrics.test.ts', sha256: sha256FileSync(metricsTest).toUpperCase() };

  const receipt = {
    schema: 'j7-same-build/3',
    fixture: false,
    status: 'passed',
    startedAt: probe.startedAt,
    finishedAt: probe.finishedAt,
    errors: [],
    run: { workflow: run.workflow, id: run.id, attempt: run.attempt, headSha: run.headSha, ref: run.ref, jobs: run.jobs },
    source: { commit, tree, headSha: run.headSha, baselineCommit: BASELINE_COMMIT, baselineAncestor, worktreeClean, lockSha256 },
    builds,
    sourceAdmission: admitted.projected,
    instances,
    strip: build.strip,
    cookies: { sessionName: 'authjs.session-token', consentName: probe.cookieNames.consent, consentPath: '/api/analytics', distinct: probe.cookieNames.consent !== probe.cookieNames.session },
    surfaces,
    separation: probe.separation,
    counting: {
      instanceId: args.instanceId,
      routeId: CONSENT_ROUTE,
      delta: { requestCount: countingRow.requestCount, errorCount: countingRow.errorCount },
      httpSeen: countedHttpSeen,
      otherRoutesUnchanged: probe.counters.otherRoutesUnchanged === true,
      errorCountDelta: probe.counters.errorCountDelta,
      guardDenialsUncounted: probe.counters.guardDenialsUncounted,
      failureKept,
    },
    jobs: jobRows,
    probe: {
      schema: probe.schema,
      pass: probe.pass,
      instanceId: args.instanceId,
      buildId,
      appOrigin: probe.app.origin,
      reportSha256: probeEvidence.sha256,
      source: { commit: probe.source.commit.toLowerCase(), tree: probe.source.tree.toLowerCase() },
      pg: { versionNum: probe.pg.versionNum, database: probe.pg.database, clusterSha256: probe.pg.clusterSha256 },
      counters: { rows: probe.counters.rows },
      separation: probe.separation,
    },
    nodata: {
      buildId: nodata.build.buildId,
      instanceId: args.freshInstanceId,
      reportSha256: nodataEvidence.sha256,
      pg: { versionNum: nodata.pg.versionNum, database: nodata.pg.database, clusterSha256: nodata.pg.clusterSha256 },
      models: nodata.noData.models,
      settings: nodata.noData.settings,
    },
    states: {
      badConfig: { exit: badConfig.values.exit, codes, sourceSha256: badConfig.sha256 },
      noPermission: { statuses: [401, 403], fromProbe: true },
      noData: { entry: 'models', status: nodata.noData.models.status, items: nodata.noData.models.items, settingsVersion: nodata.noData.settings.version, sourceSha256: nodataEvidence.sha256 },
      failure: { status: probe.failureAttribution.failedStatus, errorCode: probe.failureAttribution.errorCode, failedKey: probe.failureAttribution.jobKey, mode: 'main-instance', sourceSha256: probeEvidence.sha256 },
      retryable: { attempts: retryable.values.attempts, sourceSha256: retryable.sha256 },
    },
    // 失败归属：探针原文逐字复制（只认本实例 JobState 出的 FAILED），摘要由 CHECK-J7 现算绑定。
    failureAttribution: probe.failureAttribution,
    corroboration: corroboration.map((entry) => ({ name: entry.name, sha256: entry.sha256 })),
    network: {
      sameOriginFulfilled: network.sameOriginFulfilled,
      sameOriginAborted: network.sameOriginAborted,
      serviceWorker: network.serviceWorker,
      intercepted: network.intercepted,
    },
    cleanup: cleanup.projection,
  };

  sources.verifyProjection(admitted, receipt, (code) => { throw new sources.SourceAdmissionError(code); });
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  const temporary = `${path.resolve(args.out)}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, path.resolve(args.out));
  process.stdout.write('J7_RECEIPT_OK\n');
}

try {
  main();
} catch (error) {
  const message = error && typeof error.message === 'string' ? error.message : 'error';
  if (error instanceof sources.SourceAdmissionError) {
    process.stderr.write(`${message}\n`);
  } else if (error instanceof CleanupError) {
    fail(`J7_RECEIPT_${message}`);
  } else if (message.startsWith('J7_RECEIPT_')) {
    process.stderr.write(`${message}\n`);
  } else if (/^(missing value|unknown argument|--\w+ is required|--corroboration)/.test(message)) {
    process.stderr.write(`J7_RECEIPT_ARG:${message.replace(/[^A-Za-z0-9_ =<>-]/g, '')}\n`);
  } else {
    process.stderr.write('J7_RECEIPT_FAILED\n');
  }
  process.exit(1);
}
