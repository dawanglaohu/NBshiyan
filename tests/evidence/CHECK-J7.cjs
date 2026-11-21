#!/usr/bin/env node
/**
 * J7 同构建收件复核器 v3（只读）。核 `j7-same-build/3`。
 *
 * R2.1 增加（主实例持久化失败归属）：
 *   聚合作业必须在本实例先 SUCCEEDED 再真实 FAILED/version_conflict（代次净 +2、租约释放、
 *   旧成功时刻与水位/指标不推进、其余 key 逐一相等、边界行恢复）；失败归属只认探针原文里的
 *   `failureAttribution`，J4 的独立容器报告仍只作 409/计划旁证，不能替代主实例。
 *
 * 相对 R1 的修复：
 *   J7R-03 / §11.3 —— 真正读 probe/nodata 文件并重算摘要；��路 delta 与真实 HTTP
 *   逐条交叉；唯一 test build；surface/instance/job 交叉绑定；单 PG cluster；
 *   otherKeys 逐 key 代次；routeId 白名单从实际 `metrics.ts` 读；source/lock/build
 *   摘要从实际 checkout 重算；必需状态按 (method,path,status,count) 去重匹配；
 *   badConfig 码集合相等。缺 --repo 不再是"可选手填"，正式模式直接拒绝。
 *
 * 用法（正式）：
 *   node CHECK-J7.cjs --receipt <file> --cleanup <f> --repo <checkout> --probe-report <f> --nodata-report <f>
 *     --source-root <private inputs> --expect-build-job-id <job id>
 *     [--corroboration j4-attribution=<f>] [--corroboration bad-config=<f>]
 *     --expect-sha <40hex> --expect-tree <40hex> --expect-run <id> --expect-attempt 1
 *     --expect-workflow CI --expect-build-id <id>
 * --sources-only compares a j7-source-subset/1 report against re-admitted raw inputs.
 * 离线自检：--selftest（允许 fixture:true、无 --repo）。
 * 退出码：0 = 通过；1 = 收件不合格；2 = 读文件失败。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const digest = require('./j7-digest.cjs');
const { CleanupError, readEvidence, admitCleanup } = require('./j7-cleanup.cjs');
const { CONSENT_IDS, CONSENT_ROUTE, consentHttp, consentCounter } = require('./j7-consent-evidence.cjs');
const sources = require('./j7-source-admission.cjs');

const SURFACES = ['account', 'chat', 'analytics', 'models', 'jobs'];
const JOB_KEYS = ['chat-notifications', 'analytics-aggregate', 'analytics-retention', 'mail-queue'];
const MODES = ['shared-standalone', 'same-build-multiprocess', 'app-env-production-strip'];
const JOB_STATUSES = ['NEVER', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL'];
const BAD_CONFIG_CODES = ['DATABASE_URL', 'EDGE_AUTH_SECRET', 'SMTP_PASS'];
const BASELINE_COMMIT = 'ed9685a23b724baef64f43476b4f1e0c9ef06d63';
const REQUIRED_CORROBORATION = ['j4-attribution', 'bad-config', 'retryable'];
const REQUIRED_STATUS = {
  account: [
    { method: 'GET', pathIncludes: '/api/admin/account', status: 200, count: 1 },
    { method: 'GET', pathIncludes: '/api/admin/account', status: 401, count: 2 },
    { method: 'GET', pathIncludes: '/api/admin/settings/analytics', status: 403, count: 1 },
  ],
  chat: [
    { method: 'POST', pathIncludes: '/api/chat/session', status: 200, count: 1 },
    { method: 'POST', pathIncludes: '/api/chat/conversations', status: 200, count: 1 },
    { method: 'GET', pathIncludes: '/api/chat/conversations/', status: 200, count: 1 },
    { method: 'POST', pathIncludes: '/read', status: 200, count: 1 },
  ],
  analytics: [
    { method: 'POST', pathIncludes: '/api/analytics/events', status: 200, count: 1 },
    { method: 'POST', pathIncludes: '/api/analytics/events', status: 403, count: 2 },
  ],
  models: [
    { method: 'GET', pathExact: '/api/models', status: 200, count: 1 },
    { method: 'GET', pathMatches: /^\/api\/models\/[a-z0-9]{20,40}\/(?:glb|lod|poster)(?:\?|$)/, status: 200, count: 1 },
  ],
  jobs: [
    { method: 'POST', pathIncludes: '/api/admin/cron/operations', status: 200, count: 3 },
    { method: 'POST', pathIncludes: '/api/admin/cron/operations', status: 401, count: 1 },
    { method: 'POST', pathIncludes: '/api/admin/cron/operations', status: 400, count: 1 },
  ],
};
const FORBIDDEN_KEY = /^(cookie|cookies|authorization|bearer|token|secret|email|headers|set-cookie|set_cookie|dsn|database_url|rawbody|raw_body|postdata|sessioncookie|session_cookie|totp|totpseed|totp_seed|password|passwordhash|pw)$/i;
const FORBIDDEN_TEXT = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i, 'E_SECRET_BEARER'],
  [/postgres(?:ql)?:\/\//i, 'E_SECRET_DSN'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'E_SECRET_EMAIL'],
  [/authjs\.session-token=[^"\s]+/i, 'E_SECRET_COOKIE_VALUE'],
  [/pj_analytics=[^"\s]+/i, 'E_SECRET_COOKIE_VALUE'],
  [/pj_chat=[^"\s]+/i, 'E_SECRET_COOKIE_VALUE'],
];

const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isHex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value);
const isInt = (value) => typeof value === 'number' && Number.isInteger(value);

function parseArgs(argv) {
  const out = { receipt: null, repo: null, probeReport: null, nodataReport: null, cleanup: null, corroboration: {}, sourceOptions: {}, expect: {}, selftest: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${key}`);
      return argv[i];
    };
    if (sources.sourceOption(out.sourceOptions, key, next)) continue;
    if (key === '--receipt') out.receipt = next();
    else if (key === '--repo') out.repo = next();
    else if (key === '--probe-report') out.probeReport = next();
    else if (key === '--nodata-report') out.nodataReport = next();
    else if (key === '--cleanup') out.cleanup = next();
    else if (key === '--corroboration') {
      const [name, file] = next().split('=');
      if (!name || !file) throw new Error('--corroboration name=path');
      out.corroboration[name] = file;
    } else if (key === '--selftest') out.selftest = true;
    else if (key === '--out') out.out = next();
    else throw new Error(`unknown argument ${key}`);
  }
  if (!out.receipt) throw new sources.SourceAdmissionError('E_J7_SOURCE_REPORT_REQUIRED');
  if (out.selftest && Object.hasOwn(out.sourceOptions, 'only')) throw new sources.SourceAdmissionError('E_J7_SOURCE_ARGS');
  const { sha, tree, workflow, run, attempt, buildId } = out.sourceOptions;
  out.expect = { sha, tree, workflow, run: Number(run), attempt: Number(attempt),
    buildIds: buildId?.split(',').map((value) => value.trim()).filter(Boolean) };
  return out;
}

function workflowJobs(repo) {
  const dir = path.join(repo, '.github', 'workflows');
  if (!fs.existsSync(dir)) return null;
  const names = new Set();
  for (const file of fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/);
    let inJobs = false;
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true;
        continue;
      }
      if (!inJobs) continue;
      if (/^\S/.test(line) && line.trim() !== '') {
        inJobs = false;
        continue;
      }
      const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (match) names.add(match[1]);
    }
  }
  return names.size > 0 ? names : null;
}

function metricsRouteIds(repo) {
  const file = path.join(repo, 'src', 'lib', 'server', 'http', 'metrics.ts');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const block = /export const API_ROUTE_IDS = \[([\s\S]*?)\] as const;/.exec(text);
  if (!block) return null;
  return new Set([...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

function validate(receipt, ctx) {
  const errors = [];
  const facts = { recorded: {}, incompatible: [] };
  const add = (code, detail) => errors.push({ code, detail: detail === undefined ? null : detail });
  if (!receipt || typeof receipt !== 'object') {
    add('E_RECEIPT_MISSING');
    return { ok: false, errors, facts };
  }
  if (receipt.schema !== 'j7-same-build/3') add('E_SCHEMA', String(receipt.schema));
  if (receipt.fixture !== false) add('E_FIXTURE_NOT_EVIDENCE', String(receipt.fixture));
  if (receipt.status !== 'passed') add('E_STATUS', String(receipt.status));
  if (!isIso(receipt.startedAt) || !isIso(receipt.finishedAt)) add('E_TIMESTAMPS');
  else if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) add('E_TIME_ORDER');
  if (!Array.isArray(receipt.errors) || receipt.errors.length !== 0) add('E_ERRORS', JSON.stringify(receipt.errors ?? null));

  if (!ctx.selftest) {
    if (!ctx.repo) add('E_REPO_REQUIRED');
    for (const field of ['sha', 'tree', 'workflow']) if (!ctx.expect[field]) add('E_EXPECT_REQUIRED', field);
    for (const field of ['run', 'attempt']) if (!isInt(ctx.expect[field])) add('E_EXPECT_REQUIRED', field);
    if (!Array.isArray(ctx.expect.buildIds) || ctx.expect.buildIds.length === 0) add('E_EXPECT_REQUIRED', 'buildId');
    if (!ctx.probeReport) add('E_PROBE_REPORT_REQUIRED');
    if (!ctx.nodataReport) add('E_NODATA_REPORT_REQUIRED');
    if (!ctx.cleanup) add('E_CLEANUP_FILE_REQUIRED');
    if (!ctx.admitted) add('E_J7_SOURCE_ROOT_REQUIRED');
    else {
      try {
        sources.matchSubject(ctx.admitted, { commit: receipt.source?.commit, tree: receipt.source?.tree,
          run: receipt.run ?? {}, buildId: receipt.builds?.find?.((build) => build?.appEnvAtBuild === 'test')?.buildId });
      } catch (error) { add(error instanceof sources.SourceAdmissionError ? error.message : 'E_J7_SOURCE_SUBJECT'); }
      sources.verifyProjection(ctx.admitted, receipt, add);
      try { sources.requireFormalSources(); } catch (error) {
        add(error instanceof sources.SourceAdmissionError ? error.message : 'E_J7_FORMAL_SOURCES_PENDING', sources.MISSING_FORMAL_SOURCES);
      }
    }
    if (!ctx.corroboration.retryable) add('E_CORROBORATION_REQUIRED', 'retryable');
  }

  const run = receipt.run;
  if (!run || typeof run !== 'object') add('E_RUN_MISSING');
  else {
    if (!['CI', 'Formal supplement (Linux)'].includes(run.workflow)) add('E_RUN_WORKFLOW', String(run.workflow));
    if (!isInt(run.id) || run.id <= 0) add('E_RUN_ID', String(run.id));
    if (!isInt(run.attempt) || run.attempt < 1) add('E_RUN_ATTEMPT', String(run.attempt));
    if (!isHex(run.headSha, 40)) add('E_RUN_HEAD', String(run.headSha));
    if (typeof run.ref !== 'string' || !/^refs\/(heads\/main|pull\/\d+\/(merge|head))$/.test(run.ref)) add('E_RUN_REF', String(run.ref));
    if (!Array.isArray(run.jobs) || run.jobs.length === 0) add('E_RUN_JOBS', JSON.stringify(run.jobs ?? null));
    else {
      const names = new Set();
      for (const job of run.jobs) {
        if (!job || typeof job.name !== 'string' || !job.name) add('E_RUN_JOB_NAME', JSON.stringify(job ?? null));
        else if (names.has(job.name)) add('E_RUN_JOB_DUPLICATE', job.name);
        else names.add(job.name);
        if (!job || !isInt(job.id) || job.id <= 0) add('E_RUN_JOB_ID', JSON.stringify(job ?? null));
      }
      const allowed = ctx.repo ? workflowJobs(ctx.repo) : null;
      if (allowed) {
        for (const name of names) if (!allowed.has(name)) add('E_RUN_JOB_UNKNOWN', name);
        if (!names.has('e2e')) add('E_RUN_JOB_MISSING', 'e2e');
      }
      if (!ctx.selftest) {
        if (run.workflow !== ctx.expect.workflow) add('E_RUN_WORKFLOW_EXPECT', `${run.workflow} != ${ctx.expect.workflow}`);
        if (run.id !== ctx.expect.run) add('E_RUN_ID_EXPECT', `${run.id} != ${ctx.expect.run}`);
        if (run.attempt !== ctx.expect.attempt) add('E_RUN_ATTEMPT_EXPECT', `${run.attempt} != ${ctx.expect.attempt}`);
      }
    }
  }

  const source = receipt.source;
  if (!source || typeof source !== 'object') add('E_SOURCE_MISSING');
  else {
    if (!isHex(source.commit, 40)) add('E_SOURCE_COMMIT', String(source.commit));
    if (!isHex(source.tree, 40)) add('E_SOURCE_TREE', String(source.tree));
    if (source.baselineCommit !== BASELINE_COMMIT) add('E_SOURCE_BASELINE', String(source.baselineCommit));
    if (source.baselineAncestor !== true) add('E_SOURCE_ANCESTOR', String(source.baselineAncestor));
    if (source.worktreeClean !== true) add('E_SOURCE_DIRTY', String(source.worktreeClean));
    if (!isHex(source.lockSha256, 64)) add('E_SOURCE_LOCK', String(source.lockSha256));
    if (run && isHex(run.headSha, 40) && typeof run.ref === 'string') {
      if (run.ref.startsWith('refs/pull/')) {
        if (!isHex(source.headSha, 40) || String(source.headSha).toLowerCase() !== run.headSha.toLowerCase()) add('E_RUN_SOURCE_MISMATCH', `source.headSha=${String(source.headSha)} run.headSha=${run.headSha}`);
      } else if (isHex(source.commit, 40) && source.commit.toLowerCase() !== run.headSha.toLowerCase()) {
        add('E_RUN_SOURCE_MISMATCH', `${source.commit} != ${run.headSha}`);
      }
    }
    if (!ctx.selftest) {
      if (source.commit.toLowerCase() !== String(ctx.expect.sha).toLowerCase()) add('E_SOURCE_SHA_EXPECT', `${source.commit} != ${ctx.expect.sha}`);
      if (source.tree.toLowerCase() !== String(ctx.expect.tree).toLowerCase()) add('E_SOURCE_TREE_EXPECT', `${source.tree} != ${ctx.expect.tree}`);
    }
  }

  const builds = Array.isArray(receipt.builds) ? receipt.builds : [];
  const instanceList = Array.isArray(receipt.instances) ? receipt.instances : [];
  const buildById = new Map();
  for (const build of builds) {
    if (!build || typeof build.buildId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(build.buildId)) {
      add('E_BUILD_ID', JSON.stringify(build ?? null));
      continue;
    }
    if (buildById.has(build.buildId)) add('E_BUILD_DUPLICATE', build.buildId);
    buildById.set(build.buildId, build);
    if (!Array.isArray(build.instanceIds) || build.instanceIds.length === 0) add('E_BUILD_INSTANCES', build.buildId);
    if (!['test', 'production'].includes(build.appEnvAtBuild)) add('E_BUILD_APP_ENV', `${build.buildId}=${String(build.appEnvAtBuild)}`);
    if (build.appEnvAtBuild === 'test' && !isHex(build.standaloneTreeSha256, 64)) add('E_BUILD_TREE_SHA', build.buildId);
    if (build.appEnvAtBuild === 'production') {
      if (isHex(build.serverJsSha256, 64)) {
        // 拿原构建（非 production）的 server.js 摘要顶替 production 摘要 = 替换证据。
        if (build.originalServerJsSha256 && String(build.serverJsSha256).toLowerCase() === String(build.originalServerJsSha256).toLowerCase()) add('E_BUILD_DIGEST_SUBSTITUTED', build.buildId);
      } else if (build.digestGap !== 'no-production-serverjs-digest' || build.serverJsSha256 !== null) {
        add('E_BUILD_SERVER_SHA', build.buildId);
      }
    }
  }
  const testBuilds = builds.filter((build) => build && build.appEnvAtBuild === 'test');
  const prodBuilds = builds.filter((build) => build && build.appEnvAtBuild === 'production');
  if (testBuilds.length !== 1) add('E_BUILD_TEST_COUNT', testBuilds.length);
  if (prodBuilds.length !== 1) add('E_BUILD_PROD_COUNT', prodBuilds.length);
  const testBuild = testBuilds.length === 1 ? testBuilds[0] : null;
  if (testBuild && ctx.expect.buildIds && ctx.expect.buildIds.length) {
    if (!ctx.expect.buildIds.includes(testBuild.buildId)) add('E_BUILD_ID_EXPECT', testBuild.buildId);
  }

  const instances = new Map();
  const modeCount = Object.fromEntries(MODES.map((mode) => [mode, 0]));
  for (const inst of instanceList) {
    if (!inst || typeof inst.id !== 'string' || !inst.id) {
      add('E_INSTANCE_ID', JSON.stringify(inst ?? null));
      continue;
    }
    if (instances.has(inst.id)) add('E_INSTANCE_DUPLICATE', inst.id);
    instances.set(inst.id, inst);
    const build = buildById.get(inst.buildId);
    if (!build) add('E_INSTANCE_BUILD', `${inst.id}=${String(inst.buildId)}`);
    if (!MODES.includes(inst.mode)) add('E_INSTANCE_MODE', `${inst.id}=${String(inst.mode)}`);
    else modeCount[inst.mode] += 1;
    if (!isInt(inst.processes) || inst.processes < 0) add('E_INSTANCE_PROCESSES', `${inst.id}=${String(inst.processes)}`);
    if (inst.mode === 'app-env-production-strip') {
      if (inst.processes !== 0) add('E_STRIP_PROCESSES', String(inst.processes));
      if (inst.pg !== null) add('E_STRIP_PG', JSON.stringify(inst.pg));
      if (build && build.appEnvAtBuild !== 'production') add('E_STRIP_BUILD', `${inst.id}=${build.appEnvAtBuild}`);
    } else {
      if (testBuild && inst.buildId !== testBuild.buildId) add('E_INSTANCE_NOT_TEST_BUILD', `${inst.id}=${inst.buildId}`);
      const pg = inst.pg;
      if (!pg || typeof pg !== 'object') add('E_INSTANCE_PG', inst.id);
      else {
        if (!isInt(pg.versionNum) || pg.versionNum < 170000 || pg.versionNum > 179999) add('E_PG_VERSION', `${inst.id}=${String(pg.versionNum)}`);
        if (pg.loopback !== true) add('E_PG_LOOPBACK', inst.id);
        if (typeof pg.database !== 'string' || !/^e2e(_j7_[0-9a-f]{12})?$/.test(pg.database)) add('E_PG_DATABASE', `${inst.id}=${String(pg.database)}`);
        if (!isHex(pg.clusterSha256, 64)) add('E_PG_CLUSTER', inst.id);
      }
      if (inst.mode === 'same-build-multiprocess' && !(isInt(inst.processes) && inst.processes >= 2)) add('E_MULTIPROC_COUNT', `${inst.id}=${String(inst.processes)}`);
    }
    const ports = inst.ports;
    if (!ports || typeof ports !== 'object') add('E_INSTANCE_PORTS', inst.id);
    else {
      if (!Array.isArray(ports.used) || ports.used.some((port) => !isInt(port) || port < 1 || port > 65535)) add('E_PORT_USED', inst.id);
      if (inst.mode !== 'app-env-production-strip' && (!Array.isArray(ports.used) || ports.used.length === 0)) add('E_PORT_USED', inst.id);
      if (inst.mode === 'app-env-production-strip' && Array.isArray(ports.used) && ports.used.length !== 0) add('E_PORT_USED', inst.id);
      if (!Array.isArray(ports.listeningAfter) || ports.listeningAfter.length !== 0) add('E_PORT_LEAK', `${inst.id}=${JSON.stringify(ports.listeningAfter ?? null)}`);
      if (ports.released !== true) add('E_PORT_NOT_RELEASED', inst.id);
    }
  }
  if (instanceList.length < 3) add('E_INSTANCES_SHORT', instanceList.length);
  for (const mode of MODES) if (modeCount[mode] < 1) add('E_MODE_MISSING', mode);
  for (const build of builds) {
    if (!build || !Array.isArray(build.instanceIds)) continue;
    for (const id of build.instanceIds) {
      const inst = instances.get(id);
      if (!inst) add('E_BUILD_INSTANCE_MISSING', `${build.buildId}:${id}`);
      else if (inst.buildId !== build.buildId) add('E_BUILD_INSTANCE_BUILD', `${build.buildId}:${id}`);
    }
  }
  for (const inst of instanceList) {
    const build = inst && buildById.get(inst.buildId);
    if (build && Array.isArray(build.instanceIds) && !build.instanceIds.includes(inst.id)) add('E_INSTANCE_NOT_IN_BUILD', `${inst.id}:${inst.buildId}`);
  }
  const clusters = new Set();
  for (const inst of instanceList) {
    if (inst && inst.mode !== 'app-env-production-strip' && inst.pg && isHex(inst.pg.clusterSha256, 64)) clusters.add(inst.pg.clusterSha256.toLowerCase());
  }
  if (clusters.size !== 1) add('E_PG_MULTI_CLUSTER', JSON.stringify([...clusters]));

  const strip = receipt.strip;
  if (!strip || typeof strip !== 'object') add('E_STRIP_MISSING');
  else {
    if (strip.production !== 'PASS') add('E_STRIP_PRODUCTION', String(strip.production));
    if (strip.negative !== 'DETECTED') add('E_STRIP_NEGATIVE', String(strip.negative));
    if (strip.original !== 'PASS') add('E_STRIP_ORIGINAL', String(strip.original));
    if (!isInt(strip.markers) || strip.markers < 1) add('E_STRIP_MARKERS', String(strip.markers));
  }

  const cookies = receipt.cookies;
  if (!cookies || typeof cookies !== 'object') add('E_COOKIES_MISSING');
  else {
    if (!['authjs.session-token', '__Secure-authjs.session-token'].includes(cookies.sessionName)) add('E_COOKIE_SESSION', String(cookies.sessionName));
    if (cookies.consentName !== 'pj_analytics') add('E_COOKIE_CONSENT', String(cookies.consentName));
    if (cookies.consentPath !== '/api/analytics') add('E_COOKIE_CONSENT_PATH', String(cookies.consentPath));
    if (cookies.distinct !== true || cookies.sessionName === cookies.consentName) add('E_COOKIE_CONFLATED');
  }

  const surfaces = receipt.surfaces;
  let probeInstanceId = null;
  if (!surfaces || typeof surfaces !== 'object') add('E_SURFACES_MISSING');
  else {
    for (const name of SURFACES) {
      const surface = surfaces[name];
      if (!surface || surface.observed !== true) {
        add('E_SURFACE_MISSING', name);
        continue;
      }
      const inst = instances.get(surface.instanceId);
      if (!inst) add('E_SURFACE_INSTANCE', `${name}:${String(surface.instanceId)}`);
      else if (inst.mode === 'app-env-production-strip') add('E_SURFACE_STRIP', name);
      else if (testBuild && inst.buildId !== testBuild.buildId) add('E_SURFACE_BUILD', `${name}:${inst.buildId}`);
      if (probeInstanceId === null) probeInstanceId = surface.instanceId;
      else if (surface.instanceId !== probeInstanceId) add('E_SURFACE_MULTI_INSTANCE', `${name}:${surface.instanceId} != ${probeInstanceId}`);
      const http = Array.isArray(surface.http) ? surface.http : [];
      if (http.length === 0) add('E_SURFACE_HTTP_EMPTY', name);
      if (name === 'analytics' && !consentHttp(http)) add('E_CONSENT_HTTP');
      const ids = new Set();
      for (const row of http) {
        if (!row || typeof row.method !== 'string' || typeof row.path !== 'string' || !isInt(row.status)) add('E_HTTP_SHAPE', `${name}:${JSON.stringify(row ?? null)}`);
        else if (typeof row.id === 'string') {
          if (ids.has(row.id)) add('E_HTTP_DUPLICATE', `${name}:${row.id}`);
          ids.add(row.id);
        }
      }
      const used = new Set();
      for (const requirement of REQUIRED_STATUS[name]) {
        let matched = 0;
        for (let index = 0; index < http.length; index += 1) {
          if (matched >= requirement.count) break;
          const row = http[index];
          if (!row || used.has(index)) continue;
          if (row.method !== requirement.method || row.status !== requirement.status) continue;
          if (requirement.pathExact !== undefined && row.path !== requirement.pathExact) continue;
          if (requirement.pathIncludes !== undefined && !row.path.includes(requirement.pathIncludes)) continue;
          if (requirement.pathMatches !== undefined && !requirement.pathMatches.test(row.path)) continue;
          used.add(index);
          matched += 1;
        }
        if (matched !== requirement.count) add('E_SURFACE_STATUS', `${name}:${requirement.method}:${requirement.status}:${matched}/${requirement.count}`);
      }
    }
    if (surfaces.jobs && Array.isArray(surfaces.jobs.http) && surfaces.jobs.http.some((row) => row && row.status === 409)) {
      facts.recorded.jobs409 = 'reported-not-required (matrix J7 does not require 409; J4 is corroboration)';
    }
  }

  const sep = receipt.separation;
  if (!sep || typeof sep !== 'object') add('E_SEPARATION_MISSING');
  else {
    if (!sep.authWithoutConsent || sep.authWithoutConsent.adminStatus !== 200) add('E_SEP_AUTH_STATUS', JSON.stringify(sep.authWithoutConsent ?? null));
    else {
      if (sep.authWithoutConsent.consentCookiePresent !== false) add('E_SEP_AUTH_CONSENT', String(sep.authWithoutConsent.consentCookiePresent));
      if (sep.authWithoutConsent.sessionCookiePresent !== true) add('E_SEP_AUTH_SESSION', String(sep.authWithoutConsent.sessionCookiePresent));
    }
    if (!sep.consentWithoutSession || sep.consentWithoutSession.sessionStatus !== 401) add('E_SEP_CONSENT_STATUS', JSON.stringify(sep.consentWithoutSession ?? null));
    else {
      if (sep.consentWithoutSession.sessionCookiePresent !== false) add('E_SEP_CONSENT_SESSION', String(sep.consentWithoutSession.sessionCookiePresent));
      if (sep.consentWithoutSession.consentCookiePresent !== true) add('E_SEP_CONSENT_COOKIE', String(sep.consentWithoutSession.consentCookiePresent));
      if (sep.consentWithoutSession.error !== 'unauthorized') add('E_SEP_CONSENT_ERROR', String(sep.consentWithoutSession.error));
    }
    const rejected = sep.consentRejectedNoEvents;
    if (!rejected || typeof rejected !== 'object') add('E_SEP_REJECT', JSON.stringify(rejected ?? null));
    else {
      if (rejected.acceptStatus !== 200 || rejected.withdrawStatus !== 200) add('E_SEP_REJECT_CONSENT', JSON.stringify(rejected));
      if (rejected.eventsStatus !== 403) add('E_SEP_REJECT_STATUS', String(rejected.eventsStatus));
      if (rejected.eventsError !== 'analytics_consent_required') add('E_SEP_REJECT_ERROR', String(rejected.eventsError));
      if (rejected.eventRowsForMarker !== 0) add('E_SEP_REJECT_EVENTS', String(rejected.eventRowsForMarker));
      if (rejected.analyticsEventDelta !== 0) add('E_SEP_REJECT_DELTA', String(rejected.analyticsEventDelta));
    }
  }

  const counting = receipt.counting;
  if (!counting || typeof counting !== 'object') add('E_COUNTING_MISSING');
  else {
    const allowed = ctx.repo ? metricsRouteIds(ctx.repo) : null;
    if (typeof counting.routeId !== 'string' || !counting.routeId.includes(' /api/')) add('E_COUNT_ROUTE', String(counting.routeId));
    else if (allowed && !allowed.has(counting.routeId)) add('E_COUNT_ROUTE_UNKNOWN', counting.routeId);
    if (counting.routeId !== CONSENT_ROUTE || !isDeepStrictEqual(counting.httpSeen, CONSENT_IDS.map(() => 200))) add('E_CONSENT_COUNT');
    const delta = counting.delta;
    if (!delta || !isInt(delta.requestCount) || !isInt(delta.errorCount)) add('E_COUNT_DELTA_SHAPE', JSON.stringify(delta ?? null));
    if (!Array.isArray(counting.httpSeen) || counting.httpSeen.some((value) => !isInt(value))) add('E_COUNT_HTTP', JSON.stringify(counting.httpSeen ?? null));
    else if (delta && isInt(delta.requestCount) && delta.requestCount !== counting.httpSeen.length) add('E_COUNT_DELTA', `${delta.requestCount} != ${counting.httpSeen.length}`);
    else if (delta && isInt(delta.errorCount)) {
      const fiveXx = counting.httpSeen.filter((status) => status >= 500 && status <= 599).length;
      if (delta.errorCount !== fiveXx) add('E_COUNT_ERROR_DELTA', `${delta.errorCount} != ${fiveXx}`);
    }
    if (counting.otherRoutesUnchanged !== true) add('E_COUNT_OTHER_ROUTES', String(counting.otherRoutesUnchanged));
    if (counting.errorCountDelta !== 0) add('E_COUNT_ERROR_TOTAL', String(counting.errorCountDelta));
    const inst = instances.get(counting.instanceId);
    if (!inst) add('E_COUNT_INSTANCE', String(counting.instanceId));
    else if (testBuild && inst.buildId !== testBuild.buildId) add('E_COUNT_BUILD', inst.buildId);
    if (!counting.failureKept || counting.failureKept.evidence !== 'unit-injection') add('E_COUNT_FAILURE_EVIDENCE', JSON.stringify(counting.failureKept ?? null));
    else if (counting.failureKept.source !== 'tests/admin-http-metrics.test.ts' || !isHex(counting.failureKept.sha256, 64)) add('E_COUNT_FAILURE_SOURCE', JSON.stringify(counting.failureKept));
  }

  const jobs = Array.isArray(receipt.jobs) ? receipt.jobs : [];
  const jobByKey = new Map();
  for (const job of jobs) {
    if (!job || !JOB_KEYS.includes(job.key)) {
      add('E_JOB_KEY', JSON.stringify(job ?? null));
      continue;
    }
    if (jobByKey.has(job.key)) add('E_JOB_DUPLICATE', job.key);
    jobByKey.set(job.key, job);
    if (!isInt(job.generationBefore) || job.generationBefore < 0) add('E_JOB_GEN_BEFORE', job.key);
    if (!isInt(job.generationAfter) || job.generationAfter < job.generationBefore) add('E_JOB_GEN_AFTER', `${job.key}:${String(job.generationAfter)}`);
    if (!JOB_STATUSES.includes(job.statusAfter)) add('E_JOB_STATUS', `${job.key}=${String(job.statusAfter)}`);
    const inst = instances.get(job.instanceId);
    if (!inst) add('E_JOB_INSTANCE', `${job.key}:${String(job.instanceId)}`);
    else if (testBuild && inst.buildId !== testBuild.buildId) add('E_JOB_BUILD', `${job.key}:${inst.buildId}`);
  }
  if (jobs.length < 2) add('E_JOBS_COUNT', jobs.length);
  const retentionJob = jobByKey.get('analytics-retention');
  if (!retentionJob) add('E_JOB_MISSING', 'analytics-retention');
  else if (retentionJob.generationAfter !== retentionJob.generationBefore + 1) add('E_JOB_NOT_RUN', `analytics-retention:${retentionJob.generationBefore}->${retentionJob.generationAfter}`);
  else if (retentionJob.statusAfter !== 'SUCCEEDED') add('E_JOB_NOT_SUCCEEDED', `analytics-retention=${retentionJob.statusAfter}`);
  const aggregateJob = jobByKey.get('analytics-aggregate');
  if (!aggregateJob) add('E_JOB_MISSING', 'analytics-aggregate');
  else {
    // R2.1：聚合作业在同一实例上先 SUCCEEDED（暖态）再真实 FAILED，代次净 +2。
    if (aggregateJob.generationAfter !== aggregateJob.generationBefore + 2) add('E_JOB_FAILED_GEN', `${aggregateJob.generationBefore}->${aggregateJob.generationAfter}`);
    if (aggregateJob.statusAfter !== 'FAILED') add('E_JOB_FAILED_STATUS', String(aggregateJob.statusAfter));
    if (aggregateJob.errorCode !== 'version_conflict') add('E_JOB_FAILED_CODE', String(aggregateJob.errorCode));
    const runs = Array.isArray(aggregateJob.runs) ? aggregateJob.runs : [];
    if (runs.length !== 2 || runs[0].status !== 'SUCCEEDED' || runs[1].status !== 'FAILED' ||
      runs[1].generation !== aggregateJob.generationBefore + 2) add('E_JOB_RUNS', JSON.stringify(runs));
  }
  for (const [key, job] of jobByKey) {
    if (key !== 'analytics-aggregate' && job.statusAfter === 'FAILED') add('E_JOB_OTHER_FAILED', key);
  }

  const probe = receipt.probe;
  if (!probe || typeof probe !== 'object') add('E_PROBE_MISSING');
  else {
    if (probe.schema !== 'j7-probe/3') add('E_PROBE_SCHEMA', String(probe.schema));
    if (probe.pass !== true) add('E_PROBE_FAIL', String(probe.pass));
    if (!isHex(probe.reportSha256, 64)) add('E_PROBE_SHA', String(probe.reportSha256));
    if (probe.instanceId !== probeInstanceId) add('E_PROBE_INSTANCE', `${String(probe.instanceId)} != ${String(probeInstanceId)}`);
    if (testBuild && probe.buildId !== testBuild.buildId) add('E_PROBE_BUILD', String(probe.buildId));
    if (source && probe.source && (probe.source.commit !== source.commit || probe.source.tree !== source.tree)) add('E_PROBE_SOURCE', JSON.stringify(probe.source));
    const inst = instances.get(probe.instanceId);
    if (inst && inst.pg && probe.pg && String(probe.pg.clusterSha256).toLowerCase() !== String(inst.pg.clusterSha256).toLowerCase()) add('E_PROBE_CLUSTER', String(probe.pg.clusterSha256));
    if (!probe.counters || !Array.isArray(probe.counters.rows)) add('E_PROBE_COUNTERS', JSON.stringify(probe.counters ?? null));
    else if (counting) {
      const row = counting.routeId === CONSENT_ROUTE ? consentCounter(probe.counters) :
        probe.counters.rows.find((entry) => entry && entry.routeId === counting.routeId);
      if (!row) add('E_PROBE_COUNT_ROUTE', counting.routeId);
      else if (row.requestCount !== counting.delta.requestCount || row.errorCount !== counting.delta.errorCount) add('E_PROBE_COUNT_DIFF', JSON.stringify(row));
    }
    if (probe.separation && sep && JSON.stringify(probe.separation) !== JSON.stringify(sep)) add('E_PROBE_SEPARATION', 'probe.separation != receipt.separation');
  }

  const nodata = receipt.nodata;
  if (!nodata || typeof nodata !== 'object') add('E_NODATA_MISSING');
  else {
    if (!isHex(nodata.reportSha256, 64)) add('E_NODATA_SHA', String(nodata.reportSha256));
    const inst = instances.get(nodata.instanceId);
    if (!inst) add('E_NODATA_INSTANCE', String(nodata.instanceId));
    else {
      if (testBuild && inst.buildId !== testBuild.buildId) add('E_NODATA_BUILD', inst.buildId);
      if (!inst.pg || !nodata.pg || String(inst.pg.clusterSha256).toLowerCase() !== String(nodata.pg.clusterSha256).toLowerCase()) add('E_NODATA_CLUSTER');
      const probeInstance = instances.get(probeInstanceId);
      if (probeInstance && probeInstance.pg && nodata.pg && probeInstance.pg.database === nodata.pg.database) add('E_NODATA_SAME_DB', nodata.pg.database);
      if (nodata.pg && typeof nodata.pg.database === 'string' && !/^e2e_j7_[0-9a-f]{12}$/.test(nodata.pg.database)) add('E_NODATA_DB_NAME', nodata.pg.database);
    }
    if (!nodata.models || nodata.models.status !== 200 || nodata.models.items !== 0) add('E_NODATA_MODELS', JSON.stringify(nodata.models ?? null));
    if (!nodata.settings || nodata.settings.status !== 200 || nodata.settings.version !== 0) add('E_NODATA_SETTINGS', JSON.stringify(nodata.settings ?? null));
  }

  // 主实例持久化失败归属（R2.1）：只认本实例 JobState 出来的 FAILED，J4 文件不作替代。
  const attributionNow = receipt.failureAttribution;
  if (!attributionNow || typeof attributionNow !== 'object') add('E_ATTRIBUTION_MISSING');
  else {
    if (attributionNow.mode !== 'main-instance') add('E_ATTRIBUTION_MODE', String(attributionNow.mode));
    if (attributionNow.jobKey !== 'analytics-aggregate') add('E_ATTRIBUTION_KEY', String(attributionNow.jobKey));
    if (attributionNow.errorCode !== 'version_conflict') add('E_ATTRIBUTION_CODE', String(attributionNow.errorCode));
    if (attributionNow.failedStatus !== 'FAILED') add('E_ATTRIBUTION_STATUS', String(attributionNow.failedStatus));
    if (attributionNow.httpStatus !== 200) add('E_ATTRIBUTION_HTTP', String(attributionNow.httpStatus));
    if (!attributionNow.responseCounts || attributionNow.responseCounts.candidateCount !== 0) add('E_ATTRIBUTION_COUNTS', JSON.stringify(attributionNow.responseCounts ?? null));
    const warm = attributionNow.warm;
    const failed = attributionNow.failed;
    if (!warm || typeof warm !== 'object' || !failed || typeof failed !== 'object') add('E_ATTRIBUTION_SHAPE', 'warm/failed missing');
    else {
      if (!isInt(warm.generation) || !isInt(failed.generation) || failed.generation !== warm.generation + 1) add('E_ATTRIBUTION_GEN', `${String(warm.generation)}->${String(failed.generation)}`);
      if (failed.lastStatus !== 'FAILED') add('E_ATTRIBUTION_FAILED_STATUS', String(failed.lastStatus));
      if (failed.lastErrorCode !== 'version_conflict') add('E_ATTRIBUTION_FAILED_CODE', String(failed.lastErrorCode));
      if (failed.leaseReleased !== true) add('E_ATTRIBUTION_LEASE', String(failed.leaseReleased));
      if (!isIso(warm.lastSucceededAt)) add('E_ATTRIBUTION_WARM_CLOCK', String(warm.lastSucceededAt));
      // 失败不许推进「上次成功」：这是 persisted FAILED 与假 SUCCEEDED 的分界。
      if (failed.lastSucceededAt !== warm.lastSucceededAt) add('E_ATTRIBUTION_SUCCESS_OVERSHOOT', `${String(failed.lastSucceededAt)} != ${String(warm.lastSucceededAt)}`);
      if (failed.candidateCount !== 0) add('E_ATTRIBUTION_FAILED_COUNTS', String(failed.candidateCount));
      if (!isInt(failed.timezoneRevision) || failed.timezoneRevision !== warm.timezoneRevision) add('E_ATTRIBUTION_REVISION', `${String(failed.timezoneRevision)} != ${String(warm.timezoneRevision)}`);
      if (!isIso(failed.lastFinishedAt)) add('E_ATTRIBUTION_FINISH_CLOCK', String(failed.lastFinishedAt));
      if (isIso(warm.lastSucceededAt) && isIso(failed.lastFinishedAt) && Date.parse(failed.lastFinishedAt) < Date.parse(warm.lastSucceededAt)) add('E_ATTRIBUTION_FINISH_BEFORE_WARM');
      const watermark = attributionNow.watermark;
      if (!warm.sourceThrough || !watermark || watermark.sourceThroughBefore !== warm.sourceThrough ||
        watermark.sourceThroughAfter !== warm.sourceThrough || watermark.unchanged !== true) add('E_ATTRIBUTION_WATERMARK', JSON.stringify(watermark ?? null));
    }
    const fixture = attributionNow.fixture;
    if (!fixture || typeof fixture !== 'object') add('E_ATTRIBUTION_FIXTURE', JSON.stringify(fixture ?? null));
    else {
      if (fixture.table !== 'AnalyticsRollupDay') add('E_ATTRIBUTION_FIXTURE_TABLE', String(fixture.table));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fixture.siteDate))) add('E_ATTRIBUTION_FIXTURE_DAY', String(fixture.siteDate));
      if (!isInt(fixture.timezoneRevisionActual) || fixture.timezoneRevisionActual < 0) add('E_ATTRIBUTION_FIXTURE_REV', String(fixture.timezoneRevisionActual));
      // 只允许"真实 revision 再 +1"这一类边界冲突行；写成一个固定常数就是造结果。
      if (fixture.timezoneRevisionWritten !== fixture.timezoneRevisionActual + 1) add('E_ATTRIBUTION_FIXTURE_WRITE', `${String(fixture.timezoneRevisionWritten)} != actual+1`);
      if (!isInt(fixture.minutesFromLocalMidnight) || fixture.minutesFromLocalMidnight < 5 || fixture.minutesFromLocalMidnight > 24 * 60 - 5) add('E_ATTRIBUTION_FIXTURE_BOUNDARY', String(fixture.minutesFromLocalMidnight));
      if (fixture.restored !== true) add('E_ATTRIBUTION_FIXTURE_RESTORE', String(fixture.restored));
      if (typeof fixture.existedBefore !== 'boolean') add('E_ATTRIBUTION_FIXTURE_PREVIOUS', String(fixture.existedBefore));
      if (!isIso(fixture.pgNow)) add('E_ATTRIBUTION_FIXTURE_CLOCK', String(fixture.pgNow));
      if (typeof fixture.timezone !== 'string' || fixture.timezone.length < 1) add('E_ATTRIBUTION_FIXTURE_TZ', String(fixture.timezone));
      else if (isIso(fixture.pgNow)) {
        // 边界日必须由 PG 时钟 + 真实站点时区推出；按 UTC 日或另挑时区都会在这里拒。
        try {
          const parts = new Intl.DateTimeFormat('en-CA', { timeZone: fixture.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(fixture.pgNow));
          const pick = (type) => (parts.find((part) => part.type === type) ?? {}).value;
          if (`${pick('year')}-${pick('month')}-${pick('day')}` !== fixture.siteDate) add('E_ATTRIBUTION_FIXTURE_DAY_TZ', `${String(fixture.siteDate)} != tz(${String(fixture.pgNow)})`);
        } catch {
          add('E_ATTRIBUTION_FIXTURE_TZ', String(fixture.timezone));
        }
      }
    }
    const others = attributionNow.otherKeys;
    if (!Array.isArray(others) || others.length === 0) add('E_ATTRIBUTION_OTHER_MISSING');
    else {
      const seenOther = new Set();
      for (const other of others) {
        if (!other || !JOB_KEYS.includes(other.key) || other.key === 'analytics-aggregate' || other.key === 'analytics-retention') {
          add('E_ATTRIBUTION_OTHER_KEY', JSON.stringify(other ?? null));
          continue;
        }
        if (seenOther.has(other.key)) add('E_ATTRIBUTION_OTHER_DUPLICATE', other.key);
        seenOther.add(other.key);
        if (!isInt(other.generationBefore) || other.generationBefore !== other.generationAfter) add('E_ATTRIBUTION_OTHER_GEN', other.key);
        if (other.statusBefore !== other.statusAfter) add('E_ATTRIBUTION_OTHER_STATUS', other.key);
        if (other.lastSucceededAtBefore !== other.lastSucceededAtAfter) add('E_ATTRIBUTION_OTHER_CLOCK', other.key);
      }
      for (const key of jobByKey.keys()) {
        if (key === 'analytics-aggregate' || key === 'analytics-retention') continue;
        if (!seenOther.has(key)) add('E_ATTRIBUTION_OTHER_MISSING', key);
      }
    }
    const metrics = attributionNow.metrics;
    if (!metrics || !isHex(metrics.before, 64) || metrics.before !== metrics.afterFailure || metrics.before !== metrics.afterRestore) {
      add('E_ATTRIBUTION_METRICS', JSON.stringify(metrics ?? null));
    } else if (metrics.afterFixture === metrics.before) add('E_ATTRIBUTION_METRICS_INVISIBLE');
    else if (metrics.unchangedByFailure !== true || metrics.restoredToBaseline !== true) add('E_ATTRIBUTION_METRICS_FLAGS', JSON.stringify(metrics));
    // 同一实例 / 同一构建 / 同一 PG：与收件里的探针身份逐项绑定。
    const boundInstant = (probe && probe.instanceId) ? instances.get(probe.instanceId) : null;
    if (!boundInstant) add('E_ATTRIBUTION_INSTANCE', String(probe && probe.instanceId));
    else if (testBuild && boundInstant.buildId !== testBuild.buildId) add('E_ATTRIBUTION_BUILD', boundInstant.buildId);
    if (!probe || attributionNow.buildId !== probe.buildId) add('E_ATTRIBUTION_BUILD_MISMATCH', `${String(attributionNow.buildId)} != ${String(probe && probe.buildId)}`);
    if (!probe || !probe.pg || !attributionNow.pg ||
      String(attributionNow.pg.clusterSha256).toLowerCase() !== String(probe.pg.clusterSha256).toLowerCase() ||
      attributionNow.pg.database !== probe.pg.database) add('E_ATTRIBUTION_PG', JSON.stringify(attributionNow.pg ?? null));
    if (source && attributionNow.source &&
      (String(attributionNow.source.commit).toLowerCase() !== source.commit || String(attributionNow.source.tree).toLowerCase() !== source.tree)) add('E_ATTRIBUTION_SOURCE', JSON.stringify(attributionNow.source));
    if (probe && attributionNow.appOrigin !== probe.appOrigin) add('E_ATTRIBUTION_ORIGIN', `${String(attributionNow.appOrigin)} != ${String(probe.appOrigin)}`);
    if (!attributionNow.window || !isIso(attributionNow.window.startedAt) || !isIso(attributionNow.window.endedAt) ||
      Date.parse(attributionNow.window.endedAt) < Date.parse(attributionNow.window.startedAt)) add('E_ATTRIBUTION_WINDOW', JSON.stringify(attributionNow.window ?? null));
    else if (failed && isIso(failed.lastFinishedAt) &&
      (Date.parse(failed.lastFinishedAt) < Date.parse(attributionNow.window.startedAt) || Date.parse(failed.lastFinishedAt) > Date.parse(attributionNow.window.endedAt))) {
      add('E_ATTRIBUTION_FINISH_OUTSIDE', String(failed.lastFinishedAt));
    }
  }

  const states = receipt.states;
  if (!states || typeof states !== 'object') add('E_STATES_MISSING');
  else {
    const bad = states.badConfig;
    if (!bad || bad.exit !== 1 || !isHex(bad.sourceSha256, 64)) add('E_STATE_BAD_CONFIG', JSON.stringify(bad ?? null));
    else {
      const codes = Array.isArray(bad.codes) ? [...bad.codes].sort() : [];
      if (codes.length !== 3 || codes.join(',') !== [...BAD_CONFIG_CODES].sort().join(',')) add('E_STATE_BAD_CONFIG_CODES', JSON.stringify(bad.codes));
    }
    const denied = states.noPermission;
    if (!denied || denied.fromProbe !== true || !Array.isArray(denied.statuses) || !denied.statuses.includes(401) || !denied.statuses.includes(403)) add('E_STATE_NO_PERMISSION', JSON.stringify(denied ?? null));
    const noData = states.noData;
    if (!noData || noData.entry !== 'models' || noData.items !== 0 || noData.status !== 200) add('E_STATE_NO_DATA', JSON.stringify(noData ?? null));
    const failure = states.failure;
    if (!failure || failure.status !== 'FAILED' || typeof failure.errorCode !== 'string' || !failure.errorCode) add('E_STATE_FAILURE', JSON.stringify(failure ?? null));
    const retry = states.retryable;
    if (!retry || !isInt(retry.attempts) || retry.attempts < 2) add('E_STATE_RETRYABLE', JSON.stringify(retry ?? null));
  }

  // failureAttribution 的逐项校验在上面的主实例块里（同一份对象，只核一次）。

  const corroboration = Array.isArray(receipt.corroboration) ? receipt.corroboration : [];
  const seen = new Set();
  for (const entry of corroboration) {
    if (!entry || typeof entry.name !== 'string' || !isHex(entry.sha256, 64)) add('E_CORROBORATION_SHAPE', JSON.stringify(entry ?? null));
    else {
      if (seen.has(entry.name)) add('E_CORROBORATION_DUPLICATE', entry.name);
      seen.add(entry.name);
    }
  }
  for (const name of REQUIRED_CORROBORATION) if (!seen.has(name)) add('E_CORROBORATION_MISSING', name);

  const network = receipt.network;
  if (!network || typeof network !== 'object') add('E_NETWORK_MISSING');
  else {
    if (network.sameOriginFulfilled !== 0) add('E_NETWORK_FULFILLED', String(network.sameOriginFulfilled));
    if (network.sameOriginAborted !== 0) add('E_NETWORK_ABORTED', String(network.sameOriginAborted));
    if (network.serviceWorker !== false) add('E_NETWORK_SERVICE_WORKER', String(network.serviceWorker));
    if (!Array.isArray(network.intercepted) || network.intercepted.length !== 0) add('E_NETWORK_INTERCEPTED', JSON.stringify(network.intercepted ?? null));
  }

  const cleanup = receipt.cleanup;
  if (!cleanup || typeof cleanup !== 'object') add('E_CLEANUP_MISSING');
  else {
    // 清理必须是实际附件：独立摘要 + 本次 run/job/tree 绑定 + 成功观测出来的端口空闲。
    if (!isHex(cleanup.sourceSha256, 64)) add('E_CLEANUP_SOURCE', String(cleanup.sourceSha256));
    if (cleanup.observed !== true) add('E_CLEANUP_OBSERVED', String(cleanup.observed));
    if (cleanup.appStopped !== true) add('E_CLEANUP_APP', String(cleanup.appStopped));
    if (cleanup.probeExited !== true) add('E_CLEANUP_PROBE', String(cleanup.probeExited));
    if (!Array.isArray(cleanup.listeningAfter) || cleanup.listeningAfter.length !== 0) add('E_CLEANUP_LISTENING', JSON.stringify(cleanup.listeningAfter ?? null));
    if (!isInt(cleanup.strayLogs) || cleanup.strayLogs !== 0) add('E_CLEANUP_LOGS', String(cleanup.strayLogs));
    if (!receipt.run || cleanup.runId !== receipt.run.id || cleanup.attempt !== receipt.run.attempt) add('E_CLEANUP_BIND', `${String(cleanup.runId)}/${String(cleanup.attempt)}`);
    if (!receipt.source || String(cleanup.tree).toLowerCase() !== receipt.source.tree) add('E_CLEANUP_BIND_TREE', String(cleanup.tree));
    const ports = Array.isArray(cleanup.ports) ? cleanup.ports : [];
    if (ports.length === 0) add('E_CLEANUP_PORTS', JSON.stringify(cleanup.ports ?? null));
    for (const entry of ports) {
      if (!entry || !isInt(entry.port)) add('E_CLEANUP_PORT', JSON.stringify(entry ?? null));
      else if (entry.state !== 'free') add('E_CLEANUP_PORT_STATE', `${entry.port}=${String(entry.state)}`);
      // 只认成功观测；rc 非 0 / 常量自报的空闲一律不是证据。
      else if (!['ports.cjs', 'ss-rc0', 'tcp-connect'].includes(entry.observedBy)) add('E_CLEANUP_PORT_OBSERVER', `${entry.port}=${String(entry.observedBy)}`);
    }
    const roles = Array.isArray(cleanup.roles) ? cleanup.roles : [];
    for (const role of ['app', 'init', 'stop']) {
      const entry = roles.find((item) => item && item.role === role);
      if (!entry || !isInt(entry.exit)) add('E_CLEANUP_ROLE', role);
      else if (entry.exit !== 0) add('E_CLEANUP_ROLE_EXIT', `${role}=${entry.exit}`);
    }
  }

  const walkKeys = (value, trail = []) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkKeys(item, trail.concat(String(index))));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (!(trail[0] === 'cookies')) {
          if (key === 'cookie' || key === 'cookies' || key === 'authorization' || key === 'headers') continue;
          if (FORBIDDEN_KEY.test(key)) add('E_SECRET_FIELD', trail.concat(key).join('.'));
        }
        walkKeys(child, trail.concat(key));
      }
    }
  };
  walkKeys(receipt);
  const walkValues = (value, trail = []) => {
    if (typeof value === 'string') {
      for (const [pattern, code] of FORBIDDEN_TEXT) if (pattern.test(value)) add(code, trail.join('.'));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walkValues(item, trail.concat(String(index))));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walkValues(child, trail.concat(key));
    }
  };
  walkValues(receipt);

  // 实际 checkout / 产物重算：不接受手填摘要。
  if (ctx.repo) {
    const repo = path.resolve(ctx.repo);
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim().toLowerCase();
      const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim().toLowerCase();
      if (source && head !== String(source.commit).toLowerCase()) add('E_REPO_HEAD', `${head} != ${source.commit}`);
      if (source && tree !== String(source.tree).toLowerCase()) add('E_REPO_TREE', `${tree} != ${source.tree}`);
      let clean = true;
      try {
        execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: repo, stdio: 'ignore' });
      } catch {
        clean = false;
      }
      if (!clean) add('E_REPO_DIRTY');
      const lock = path.join(repo, 'pnpm-lock.yaml');
      if (!fs.existsSync(lock)) add('E_REPO_LOCK_MISSING');
      else if (source && digest.sha256FileSync(lock) !== String(source.lockSha256).toLowerCase()) add('E_REPO_LOCK', 'lock digest mismatch');
      const buildIdPath = path.join(repo, '.next', 'standalone', '.next', 'BUILD_ID');
      const standalone = path.join(repo, '.next', 'standalone');
      if (!fs.existsSync(standalone)) {
        // 离线收件目录只带 git checkout，不带构建树。此时整树摘要只能由探针在运行时自算并以报告摘要绑定，
        // 这里如实记录"未重算"，不伪造通过。
        facts.treeDigest = 'not-recomputed:no-standalone';
      } else {
        if (!fs.existsSync(buildIdPath)) add('E_REPO_BUILD_ID_MISSING');
        else {
          const actual = fs.readFileSync(buildIdPath, 'utf8').trim();
          if (testBuild && actual !== testBuild.buildId) add('E_REPO_BUILD_ID', `${actual} != ${testBuild.buildId}`);
        }
        if (testBuild) {
          try {
            const actualTree = digest.treeDigestSync(standalone).sha256;
            if (actualTree !== String(testBuild.standaloneTreeSha256).toLowerCase()) add('E_REPO_TREE_DIGEST', 'standalone tree digest mismatch');
          } catch {
            add('E_REPO_TREE_DIGEST', 'unreadable standalone tree');
          }
        }
      }
      const metricsTest = path.join(repo, 'tests', 'admin-http-metrics.test.ts');
      if (counting && counting.failureKept && isHex(counting.failureKept.sha256, 64)) {
        if (!fs.existsSync(metricsTest)) add('E_REPO_METRICS_TEST_MISSING');
        else if (digest.sha256FileSync(metricsTest) !== String(counting.failureKept.sha256).toLowerCase()) add('E_REPO_METRICS_TEST', 'digest mismatch');
      }
      // 失败归属的场景必须仍由产品真实代码产生：错误映射与"旧代次"触发条件都在源里。
      const squeeze = (text) => text.replace(/\s+/g, ' ');
      const registrySource = path.join(repo, 'src', 'lib', 'server', 'jobs', 'registry.ts');
      const aggregateSource = path.join(repo, 'src', 'lib', 'server', 'analytics', 'aggregate.ts');
      if (!fs.existsSync(registrySource)) add('E_REPO_FAILURE_SOURCE', 'registry.ts missing');
      else if (!squeeze(fs.readFileSync(registrySource, 'utf8')).includes("if (error instanceof AggregateVersionConflict) return 'version_conflict';")) add('E_REPO_FAILURE_REGISTRY');
      if (!fs.existsSync(aggregateSource)) add('E_REPO_FAILURE_SOURCE', 'aggregate.ts missing');
      else if (!squeeze(fs.readFileSync(aggregateSource, 'utf8')).includes('if (storedRevision !== null && storedRevision > timezoneRevision) {')) add('E_REPO_FAILURE_TRIGGER');
    } catch {
      add('E_REPO_GIT');
    }
  }

  // 探针/旁证文件：重算摘要 + 逐条交叉。
  const verifyFile = (file, expected, code) => {
    if (!file) return null;
    try {
      const evidence = readEvidence(file);
      if (!isHex(expected, 64) || evidence.sha256 !== expected.toUpperCase()) add(code, 'digest mismatch');
      return evidence;
    } catch {
      add(code, 'unreadable evidence');
      return null;
    }
  };
  const probeEvidence = verifyFile(ctx.probeReport, probe?.reportSha256, 'E_PROBE_REPORT');
  const probeFile = probeEvidence?.value;
  if (probeFile && probe) {
    if (probeFile.schema !== 'j7-probe/3' || probeFile.pass !== true) add('E_PROBE_REPORT_SHAPE');
    if (probeFile.build && probeFile.build.buildId !== probe.buildId) add('E_PROBE_REPORT_BUILD');
    if (probeFile.pg && probeFile.pg.clusterSha256 !== probe.pg.clusterSha256) add('E_PROBE_REPORT_PG');
    // 失败归属必须能在探针原文里逐字节找到；收件里另写一份就是手填。
    if (!probeFile.failureAttribution) add('E_ATTRIBUTION_FILE_MISSING');
    else if (attributionNow && JSON.stringify(probeFile.failureAttribution) !== JSON.stringify(attributionNow)) add('E_ATTRIBUTION_FILE_DIFF');
    if (probeFile.app && probeFile.app.origin !== probe.appOrigin) add('E_PROBE_REPORT_ORIGIN');
    const rawConsent = consentHttp(probeFile.http);
    if (!rawConsent) add('E_PROBE_CONSENT_HTTP');
    const rawCount = consentCounter(probeFile.counters);
    if (!rawCount || rawCount.requestCount !== CONSENT_IDS.length || rawCount.errorCount !== 0) add('E_PROBE_CONSENT_COUNT');
    const byId = new Map((Array.isArray(probeFile.http) ? probeFile.http : []).filter(Boolean).map((row) => [row.id, row]));
    for (const name of SURFACES) {
      const surface = surfaces && surfaces[name];
      for (const row of (surface && Array.isArray(surface.http) ? surface.http : [])) {
        const actual = byId.get(row.id);
        if (!actual) add('E_PROBE_ROW_MISSING', `${name}:${row.id}`);
        else if (actual.method !== row.method || actual.path !== row.path || actual.status !== row.status || actual.error !== row.error) add('E_PROBE_ROW_DIFF', `${name}:${row.id}`);
      }
    }
    for (const job of jobs) {
      const actual = (probeFile.jobs ?? []).find((entry) => entry && entry.key === job.key);
      if (!actual) add('E_PROBE_JOB_MISSING', job.key);
      else if (actual.generationBefore !== job.generationBefore || actual.generationAfter !== job.generationAfter || actual.statusAfter !== job.statusAfter) add('E_PROBE_JOB_DIFF', job.key);
    }
  }
  const nodataEvidence = verifyFile(ctx.nodataReport, nodata?.reportSha256, 'E_NODATA_REPORT');
  const nodataFile = nodataEvidence?.value;
  const cleanupEvidence = verifyFile(ctx.cleanup, cleanup?.sourceSha256, 'E_CLEANUP_FILE');
  if (cleanupEvidence && cleanup) {
    const raw = cleanupEvidence.value;
    if (ctx.selftest && raw.schema === undefined) {
      // Legacy self-test fixtures are flat projections. Formal validation always requires the runner attachment.
      for (const key of ['appStopped', 'probeExited', 'runId', 'attempt', 'ports', 'roles']) {
        if (!isDeepStrictEqual(raw[key], cleanup[key])) {
          add('E_CLEANUP_FILE_DIFF');
          break;
        }
      }
    } else if (!probeEvidence || !nodataEvidence) {
      add('E_CLEANUP_REPORTS_REQUIRED');
    } else {
      try {
        const serverJsPath = ctx.repo && path.join(ctx.repo, '.next', 'standalone', 'server.js');
        const admitted = admitCleanup(cleanupEvidence, probeEvidence, nodataEvidence, {
          run, source, build: { ...testBuild, serverJsPath },
        });
        if (!isDeepStrictEqual(admitted.projection, { ...cleanup, sourceSha256: cleanup.sourceSha256?.toUpperCase() })) {
          add('E_CLEANUP_FILE_DIFF');
        }
        if (admitted.build.serverJs.sha256.toUpperCase() !== testBuild.serverJsSha256?.toUpperCase()) {
          add('E_CLEANUP_SERVER_JS');
        }
      } catch (error) {
        add(error instanceof CleanupError ? `E_${error.message}` : 'E_CLEANUP_FILE');
      }
    }
  }
  if (nodataFile && nodata) {
    if (nodataFile.schema !== 'j7-nodata/1' || nodataFile.pass !== true) add('E_NODATA_REPORT_SHAPE');
    if (nodataFile.noData && (nodataFile.noData.models?.items !== nodata.models?.items || nodataFile.noData.settings?.version !== nodata.settings?.version)) add('E_NODATA_REPORT_DIFF');
    if (nodataFile.pg && nodataFile.pg.clusterSha256 !== nodata.pg?.clusterSha256) add('E_NODATA_REPORT_PG');
  }
  for (const entry of corroboration) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (!ctx.selftest && (entry.name === 'bad-config' || entry.name === 'j4-attribution')) continue;
    const file = ctx.corroboration[entry.name];
    if (!file) {
      if (!ctx.selftest) add('E_CORROBORATION_FILE', entry.name);
      continue;
    }
    if (!fs.existsSync(file)) {
      add('E_CORROBORATION_FILE', entry.name);
      continue;
    }
    const actual = digest.sha256FileSync(file).toUpperCase();
    if (!isHex(entry.sha256, 64) || actual !== String(entry.sha256).toUpperCase()) add('E_CORROBORATION_DIGEST', entry.name);
    let value = null;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      add('E_CORROBORATION_JSON', entry.name);
    }
    if (value && entry.name === 'bad-config' && states && states.badConfig) {
      const codes = Array.isArray(value.codes) ? [...value.codes].sort() : [];
      const claimed = Array.isArray(states.badConfig.codes) ? [...states.badConfig.codes].sort() : [];
      if (codes.join(',') !== claimed.join(',') || value.exit !== states.badConfig.exit) add('E_CORROBORATION_VALUE', entry.name);
    }
    if (value && entry.name === 'retryable' && states && states.retryable && value.attempts !== states.retryable.attempts) add('E_CORROBORATION_VALUE', entry.name);
    if (value && entry.name === 'j4-attribution' && attributionNow) {
      // J4 只是旁证：自己的 key/码/状态与收件里的主实例归属一致即可，不要求同 build/cluster。
      if (value.failedKey !== attributionNow.jobKey || value.errorCode !== attributionNow.errorCode || value.failedStatus !== attributionNow.failedStatus) add('E_CORROBORATION_VALUE', entry.name);
    }
  }

  facts.surfaces = SURFACES.filter((name) => surfaces && surfaces[name] && surfaces[name].observed === true).length;
  facts.builds = builds.length;
  facts.instances = instanceList.length;
  facts.jobs = jobs.length;
  facts.probe = Boolean(probe && probe.pass === true);
  facts.failureAttribution = Boolean(attributionNow && attributionNow.mode === 'main-instance');
  facts.repoVerified = Boolean(ctx.repo);
  return { ok: errors.length === 0, errors, facts };
}

function main() {
  const ctx = parseArgs(process.argv.slice(2));
  if (!ctx.selftest && (ctx.sourceOptions.root || ctx.sourceOptions.only)) {
    ctx.admitted = sources.runAdmission(ctx.sourceOptions, ctx.repo);
    sources.verifyOptionalAttachments(ctx.admitted, ctx.corroboration);
  }
  if (ctx.sourceOptions.only) {
    if (!sources.sameFile(ctx.receipt, sources.subsetBytes(ctx.admitted))) {
      throw new sources.SourceAdmissionError('E_J7_SOURCE_SUBSET_DIFF');
    }
    printResult(ctx, { schema: 'j7-source-subset-check/1', subsetVerified: true, formalQualified: false,
      pending: sources.MISSING_FORMAL_SOURCES });
    return;
  }
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(ctx.receipt, 'utf8'));
  } catch (error) {
    process.stderr.write(`J7_CHECK_READ_FAILED ${String(error && error.message ? error.message : error)}\n`);
    process.exit(2);
  }
  if (!ctx.selftest && receipt?.schema !== 'j7-same-build/3') throw new sources.SourceAdmissionError('E_J7_SOURCE_SCOPE');
  const result = validate(receipt, ctx);
  const output = { schema: 'j7-check/3', receipt: path.resolve(ctx.receipt), selftest: ctx.selftest, ...result };
  printResult(ctx, output);
  process.exitCode = result.ok ? 0 : 1;
}

function printResult(ctx, output) {
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (ctx.out) fs.writeFileSync(ctx.out, text, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(text);
}

if (require.main === module) {
  try { main(); } catch (error) {
    const expected = error instanceof sources.SourceAdmissionError ? error.message : 'E_J7_CHECK_INPUT';
    process.stderr.write(`${expected}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validate, parseArgs, workflowJobs, metricsRouteIds };
