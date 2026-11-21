#!/usr/bin/env node
/**
 * J6 证据复核器（R4）：只读 RUN.json，按构建/运行身份 + 源码/同意三阶段零写入/GLB/事件/DB/T12 前后行复算/安全规则判定。
 *
 * 用法：
 *   node CHECK-EVIDENCE.cjs --run <RUN目录> --expect-sha <GITHUB_SHA或HEAD> \
 *     --expect-tree <HEAD^{tree}> --expect-build-id <BUILD_ID> --repo <checkout> \
 *     [--spec <候选 spec 路径>] \
 *     [--expect-run <run_id> --expect-attempt <attempt> --expect-job <job> \
 *      --expect-workflow <workflow> --expect-ref <refs/...>] \
 *     [--out <结果 json>] [--receipt <RUNNER-RECEIPT.json>]
 *
 * 五个身份/仓库参数必填；给出 --receipt 时要求同时提供 --spec、--out 与五个 --expect-* runner 参数，
 * 且目标回执/结果文件在写出前不得已存在。只接受 closed=true、status=passed、errors=[]、retry=0 的 RUN。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKENS = {
  cssBg: '#ffffff',
  cssAccent: '#b45700',
  cssRadius: '0px',
  cssBorder: '2px',
  bodyBg: 'rgb(255, 255, 255)',
  bodyColor: 'rgb(0, 0, 0)',
  bodyFontSize: '16px',
  bodyLineHeight: '24px',
};
const SPEC_RELATIVE = 'e2e/j6-frontend-seam-evidence.spec.ts';
const REQUIRED_SOURCES = [
  'e2e/brand-smoke.spec.ts',
  'e2e/model-events.spec.ts',
  'e2e/analytics-consent.spec.ts',
  'e2e/analytics-job-runtime.spec.ts',
  'e2e/j6-frontend-seam-evidence.spec.ts',
  'src/lib/client/analytics.ts',
  'src/lib/server/analytics/aggregate-repo.ts',
  'src/lib/server/jobs/registry.ts',
  'src/lib/analytics/day-boundaries.ts',
  'src/lib/analytics/daily-aggregate.ts',
  'src/data/products.ts',
  'src/lib/catalog/catalog.ts',
  'src/lib/seo/categorySlugs.ts',
  'src/lib/server/published-models.ts',
];
const REQUIRED_SOURCE_SET = new Set(REQUIRED_SOURCES);
const RUNNER_KEYS = ['runId', 'runAttempt', 'job', 'workflow', 'ref', 'source'];
const GLB_FACT_KEYS = [
  'path', 'search', 'status', 'contentLength', 'contentType',
  'fromServiceWorker', 'servedFileSize', 'servedFileSha256',
  'bodyBytes', 'bodySha256', 'requestAt', 'responseAt',
];
const SITE_DELTA_KEYS = ['visitors', 'pageViews', 'productViews', 'modelStarts', 'modelSuccesses', 'modelFailures', 'durationMsSum'];
const PRODUCT_DELTA_KEYS = ['visitors', 'productViews', 'modelStarts', 'modelSuccesses', 'modelFailures', 'durationMsSum'];
const FORBIDDEN_KEYS = new Set([
  'cookie', 'cookies', 'authorization', 'token', 'secret', 'browserhash', 'browser_hash',
  'email', 'headers', 'setcookie', 'set_cookie', 'postdata', 'rawbody', 'raw_body', 'password',
]);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function isIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// 阶段 nonce 只接受 crypto.randomUUID() 的 v4 小写形式；不落任何秘密，仅用于区分上下文与阶段。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DB_NAME_RE = /^b10_j6_seam_[1-9][0-9]{0,19}_[1-9][0-9]{0,5}$/;
const CLUSTER_SHA_RE = /^[0-9A-F]{64}$/;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseNonNegBigInt(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function isValidLocalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTimezone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** 与 src/lib/analytics/day-boundaries.ts 的 siteLocalDate 同算法，按站点时区复算本地日。 */
function siteLocalDateOf(isoInstant, timeZone) {
  if (!isValidTimezone(timeZone) || !isIso(isoInstant)) return null;
  const instant = new Date(isoInstant);
  if (!Number.isFinite(instant.getTime())) return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    }).formatToParts(instant);
  } catch {
    return null;
  }
  const pick = (type) => {
    const val = parts.find((part) => part.type === type)?.value;
    return val && /^\d+$/.test(val) ? Number(val) : null;
  };
  let year = pick('year');
  let month = pick('month');
  let day = pick('day');
  const hour = pick('hour');
  if (year === null || month === null || day === null || hour === null) return null;
  if (hour === 24) {
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  const label = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidLocalDate(label) ? label : null;
}

function readFallbackProducts(repo) {
  const file = path.join(repo, 'src', 'data', 'products.ts');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const map = new Map();
  for (const match of text.matchAll(/\{\s*slug:\s*'([^']+)'\s*,\s*model:\s*'([^']+)'/g)) {
    map.set(match[1], match[2]);
  }
  return map.size > 0 ? map : null;
}

function sameGlbFact(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return GLB_FACT_KEYS.every((key) => left[key] === right[key]);
}

/** 校验并逐字段投影 runner，拒绝未知键或格式越界，回执不复制原始对象。 */
function projectRunner(runner, add) {
  if (!runner || typeof runner !== 'object' || Array.isArray(runner)) {
    add('E_RUNNER_MISSING');
    return null;
  }
  const extraKeys = Object.keys(runner).filter((key) => !RUNNER_KEYS.includes(key));
  if (extraKeys.length > 0) add('E_RUNNER_KEYS', extraKeys.join(','));
  if (runner.source === 'github') {
    const okRunId = typeof runner.runId === 'string' && /^[1-9]\d{0,19}$/.test(runner.runId);
    const okAttempt = typeof runner.runAttempt === 'string' && /^[1-9]\d{0,5}$/.test(runner.runAttempt);
    const okJob = typeof runner.job === 'string' && /^[A-Za-z0-9 ._-]{1,80}$/.test(runner.job);
    const okWorkflow = typeof runner.workflow === 'string' && /^[A-Za-z0-9 ._()/-]{1,120}$/.test(runner.workflow);
    const okRef = typeof runner.ref === 'string'
      && /^refs\/[A-Za-z0-9 ._()/-]{1,160}$/.test(runner.ref)
      && !runner.ref.includes('..');
    if (!okRunId) add('E_RUNNER_RUN_ID', String(runner.runId ?? null));
    if (!okAttempt) add('E_RUNNER_ATTEMPT', String(runner.runAttempt ?? null));
    if (!okJob) add('E_RUNNER_JOB', String(runner.job ?? null));
    if (!okWorkflow) add('E_RUNNER_WORKFLOW', String(runner.workflow ?? null));
    if (!okRef) add('E_RUNNER_REF', String(runner.ref ?? null));
    if (extraKeys.length === 0 && okRunId && okAttempt && okJob && okWorkflow && okRef) {
      return {
        source: 'github',
        runId: runner.runId,
        runAttempt: runner.runAttempt,
        job: runner.job,
        workflow: runner.workflow,
        ref: runner.ref,
      };
    }
    return null;
  }
  if (runner.source === 'local') {
    if (runner.runId !== null || runner.runAttempt !== null || runner.job !== null
        || runner.workflow !== null || runner.ref !== null) {
      add('E_RUNNER_LOCAL', JSON.stringify(runner));
      return null;
    }
    if (extraKeys.length > 0) return null;
    return {
      source: 'local',
      runId: null,
      runAttempt: null,
      job: null,
      workflow: null,
      ref: null,
    };
  }
  add('E_RUNNER_SOURCE', String(runner.source));
  return null;
}

function validateZeroConsentStage(stage, prefix, opts, add) {
  if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
    add(`${prefix}_MISSING`);
    return false;
  }
  let ok = true;
  if (stage.navigatedPath !== '/en/products') {
    add(`${prefix}_STAGE`, String(stage.navigatedPath));
    ok = false;
  }
  // 阶段身份与起止：缺字段、非法 nonce、时间倒序都拒；不接受“只有计数没有身份”的阶段块。
  if (!isUuid(stage.contextNonce)) {
    add(`${prefix}_CONTEXT`, String(stage.contextNonce));
    ok = false;
  }
  if (!isIso(stage.startedAt) || !isIso(stage.finishedAt)) {
    add(`${prefix}_TIME`, `${String(stage.startedAt)} -> ${String(stage.finishedAt)}`);
    ok = false;
  } else if (Date.parse(stage.finishedAt) < Date.parse(stage.startedAt)) {
    add(`${prefix}_TIME`, 'finishedAt < startedAt');
    ok = false;
  }
  if (opts.requireIsolated && stage.isolatedContext !== true) {
    add(`${prefix}_STAGE`, `isolatedContext=${String(stage.isolatedContext)}`);
    ok = false;
  }
  if (opts.requireConsentStatus && stage.consentPostStatus !== 200) {
    add(`${prefix}_STATUS`, String(stage.consentPostStatus));
    ok = false;
  }
  if (!nonNegInt(stage.eventPosts) || stage.eventPosts !== 0) {
    add(`${prefix}_POSTS`, String(stage.eventPosts));
    ok = false;
  }
  if (opts.requirePostAcceptZero && (!nonNegInt(stage.postAcceptEventPosts) || stage.postAcceptEventPosts !== 0)) {
    add(`${prefix}_POSTS`, `postAccept=${String(stage.postAcceptEventPosts)}`);
    ok = false;
  }
  if (!nonNegInt(stage.queueLength) || stage.queueLength !== 0) {
    add(`${prefix}_QUEUE`, String(stage.queueLength));
    ok = false;
  }
  if (stage.cookiePresent !== false) {
    add(`${prefix}_COOKIE`, String(stage.cookiePresent));
    ok = false;
  }
  if (stage.collecting !== false) {
    add(`${prefix}_COLLECTING`, String(stage.collecting));
    ok = false;
  }
  if (!nonNegInt(stage.dbBefore) || !nonNegInt(stage.dbAfter)
      || !Number.isInteger(stage.dbDelta) || stage.dbDelta !== 0 || stage.dbAfter !== stage.dbBefore) {
    add(`${prefix}_DB`, `${String(stage.dbBefore)}->${String(stage.dbAfter)} delta=${String(stage.dbDelta)}`);
    ok = false;
  }
  return ok;
}

function validateDailyRowShape(row, kind, phase, expectedDimension, settings, siteDay, add) {
  const isBaseline = phase === 'baseline';
  if (row.dimension !== expectedDimension) {
    add(isBaseline ? 'E_AGG_BASELINE_DIM' : kind === 'site' ? 'E_AGG_SITE_DIM' : 'E_AGG_PRODUCT_DIM', String(row.dimension));
  }
  if (row.localDate !== siteDay) {
    add(isBaseline ? 'E_AGG_BASELINE_LOCAL_DATE' : kind === 'site' ? 'E_AGG_SITE_LOCAL_DATE' : 'E_AGG_PRODUCT_LOCAL_DATE', `${row.localDate} != ${siteDay}`);
  }
  if (settings && typeof settings.timezone === 'string' && Number.isInteger(settings.timezoneRevision)) {
    if (row.timezone !== settings.timezone) {
      add(isBaseline ? 'E_AGG_BASELINE_TZ' : kind === 'site' ? 'E_AGG_SITE_TZ' : 'E_AGG_PRODUCT_TZ', `${row.timezone} != ${settings.timezone}`);
    }
    if (row.timezoneRevision !== settings.timezoneRevision) {
      add(isBaseline ? 'E_AGG_BASELINE_REV' : kind === 'site' ? 'E_AGG_SITE_REV' : 'E_AGG_PRODUCT_REV', `${row.timezoneRevision} != ${settings.timezoneRevision}`);
    }
  }
  const pageViewsOk = kind === 'site' ? nonNegInt(row.pageViews) : row.pageViews === null;
  const countsOk = nonNegInt(row.visitors)
    && pageViewsOk
    && nonNegInt(row.productViews)
    && nonNegInt(row.modelStarts)
    && nonNegInt(row.modelSuccesses)
    && nonNegInt(row.modelFailures)
    && parseNonNegBigInt(row.durationMsSum) !== null
    && (!isBaseline || row.sourceThrough === null || isIso(row.sourceThrough));
  if (!countsOk) {
    add('E_AGG_ROW_SHAPE', `${phase}.${kind}`);
  }
  return countsOk;
}

function walkKeys(value, visit, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, visit, trail.concat(String(index))));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, trail.concat(key).join('.'));
      walkKeys(child, visit, trail.concat(key));
    }
  }
}

function validateJ6Network(run, add) {
  const { evidence } = run;
  const observation = evidence.networkObservation;
  const network = evidence.network;
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  if (!exact(observation, ['method', 'browserBlocked', 'windows']) || observation.method !== 'playwright-context-guard/1'
      || !Array.isArray(observation.windows) || observation.windows.length !== 2) {
    add('E_NETWORK_OBSERVATION');
    return null;
  }
  if (!exact(network, ['sameOriginFulfilled', 'sameOriginAborted', 'serviceWorker', 'intercepted'])) {
    add('E_NETWORK_MISSING');
    return null;
  }
  const expected = ['scope', 'contextNonce', 'startedAt', 'finishedAt', 'guardedPages', 'sameOriginRequests',
    'sameOriginResponses', 'sameOriginNetworkFailures', 'sameOriginDocumentSuccesses', 'serviceWorkerHits', 'registeredRoutes', 'blocked'];
  const main = observation.windows[0];
  const rejected = observation.windows[1];
  for (const [scope, window] of [['main', main], ['rejected', rejected]]) {
    if (!exact(window, expected) || window.scope !== scope) {
      add('E_NETWORK_WINDOW', scope);
      return null;
    }
  }
  let ok = true;
  const reject = (code, detail) => { ok = false; add(code, detail); };
  for (const window of [main, rejected]) {
    const { scope, guardedPages, sameOriginRequests: requests, sameOriginResponses: responses,
      sameOriginNetworkFailures: failures, sameOriginDocumentSuccesses: documents, serviceWorkerHits, registeredRoutes } = window;
    const times = [run.startedAt, window.startedAt, window.finishedAt, run.finishedAt];
    if (!times.every(isIso) || times.some((time, i) => i > 0 && Date.parse(time) < Date.parse(times[i - 1]))) {
      reject('E_NETWORK_WINDOW', scope);
    }
    if (![guardedPages, requests, responses, failures, documents, serviceWorkerHits, registeredRoutes].every(nonNegInt)
        || guardedPages === 0 || requests === 0 || responses === 0 || documents === 0
        || responses > requests || failures > requests || documents > responses || serviceWorkerHits > requests + responses) {
      reject('E_NETWORK_WITNESS', scope);
    }
    if (registeredRoutes !== 0) reject('E_NETWORK_ROUTE_REGISTRY', scope);
    if (!Array.isArray(window.blocked) || window.blocked.length !== 0) reject('E_NETWORK_INTERCEPTED', scope);
  }
  const consent = evidence.consent;
  const pre = consent?.preConsent;
  const withdraw = consent?.withdrawn;
  const deny = consent?.rejected;
  const glb = evidence.glb?.chosen;
  if (!isUuid(main.contextNonce) || !isUuid(rejected.contextNonce) || main.contextNonce === rejected.contextNonce
      || main.contextNonce !== pre?.contextNonce || main.contextNonce !== withdraw?.contextNonce
      || rejected.contextNonce !== deny?.contextNonce) reject('E_NETWORK_CONTEXT');
  const ms = (time) => Date.parse(time);
  const timing = deny?.browserTiming;
  const timingKeys = ['pageCreationStartedAt', 'navigationStartedAt', 'denialConfirmedAt', 'contextClosedAt'];
  const isCanonicalUtcMs = (time) => {
    if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)) return false;
    const millis = ms(time);
    return Number.isFinite(millis) && new Date(millis).toISOString() === time;
  };
  const rejectedCoverage = [deny?.startedAt, rejected.startedAt, timing?.pageCreationStartedAt,
    timing?.navigationStartedAt, timing?.denialConfirmedAt, timing?.contextClosedAt, deny?.finishedAt, rejected.finishedAt];
  if (!exact(timing, timingKeys)
      || !timingKeys.every((key) => isCanonicalUtcMs(timing[key]))
      || !rejectedCoverage.every(isIso)
      || rejectedCoverage.some((time, i) => i > 0 && ms(time) < ms(rejectedCoverage[i - 1]))) {
    reject('E_NETWORK_COVERAGE', 'rejected');
  }
  const coverage = [pre?.startedAt, withdraw?.finishedAt];
  if (!coverage.every(isIso)
      || !(ms(main.startedAt) <= ms(pre.startedAt) && ms(withdraw.finishedAt) <= ms(rejected.startedAt)
        && ms(rejected.finishedAt) <= ms(main.finishedAt)
        && Number.isFinite(glb?.requestAt) && Number.isFinite(glb?.responseAt)
        && ms(main.startedAt) <= glb.requestAt && glb.responseAt <= ms(main.finishedAt))) {
    reject('E_NETWORK_COVERAGE');
  }
  if (network.sameOriginFulfilled !== 0 || network.sameOriginAborted !== 0) reject('E_NETWORK_ROUTE_ACTION');
  if (network.serviceWorker !== false || main.serviceWorkerHits !== 0 || rejected.serviceWorkerHits !== 0
      || glb?.fromServiceWorker !== false) reject('E_NETWORK_SERVICE_WORKER');
  if (!Array.isArray(observation.browserBlocked) || observation.browserBlocked.length !== 0
      || !Array.isArray(network.intercepted) || network.intercepted.length !== 0) reject('E_NETWORK_INTERCEPTED');
  return ok ? {
    sameOriginFulfilled: network.sameOriginFulfilled,
    sameOriginAborted: network.sameOriginAborted,
    serviceWorker: network.serviceWorker,
    intercepted: network.intercepted,
  } : null;
}

function validateEvidence(run, ctx, build) {
  const errors = [];
  const facts = {};
  const add = (code, detail) => errors.push({ code, detail: detail === undefined ? null : detail });
  const evidence = run && typeof run === 'object' ? run.evidence : null;
  const identity = run && typeof run === 'object' ? run.identity : null;

  if (run?.schema !== 'j6-frontend-seam/2') add('E_RUN_SCHEMA', String(run?.schema));
  if (run?.closed !== true) add('E_RUN_UNCLOSED', String(run?.closed));
  if (run?.status !== 'passed') add('E_RUN_NOT_PASSED', String(run?.status));
  if (!Array.isArray(run?.errors) || run.errors.length !== 0) add('E_RUN_ERRORS', JSON.stringify(run?.errors ?? null));
  if (!isIso(run?.startedAt) || !isIso(run?.finishedAt)) add('E_RUN_TIMESTAMPS', `${run?.startedAt} -> ${run?.finishedAt}`);
  if (isIso(run?.startedAt) && isIso(run?.finishedAt) && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) {
    add('E_RUN_TIME_ORDER');
  }
  if (ctx.runDir && path.resolve(run?.root ?? '') !== path.resolve(ctx.runDir)) add('E_RUN_ROOT', String(run?.root));
  if (!evidence || typeof evidence !== 'object') {
    add('E_EVIDENCE_MISSING');
    return { ok: false, errors, facts };
  }

  if (!identity || typeof identity !== 'object') {
    add('E_IDENTITY_MISSING');
    return { ok: false, errors, facts };
  }
  if (String(identity.head).toLowerCase() !== ctx.expectSha.toLowerCase()) add('E_IDENTITY_SHA', `${identity.head} != ${ctx.expectSha}`);
  if (String(identity.tree).toLowerCase() !== ctx.expectTree.toLowerCase()) add('E_IDENTITY_TREE', `${identity.tree} != ${ctx.expectTree}`);
  if (identity.githubSha && String(identity.githubSha).toLowerCase() !== String(identity.head).toLowerCase()) {
    add('E_IDENTITY_GITHUB_SHA', `${identity.githubSha} != ${identity.head}`);
  }
  if (String(identity.buildId) !== String(ctx.expectBuildId)) add('E_IDENTITY_BUILD_ID', `${identity.buildId} != ${ctx.expectBuildId}`);
  const repo = path.resolve(ctx.repo);
  if (build === null) {
    const buildIdPath = path.join(repo, '.next', 'standalone', '.next', 'BUILD_ID');
    if (!fs.existsSync(buildIdPath)) add('E_BUILD_ID_FILE_MISSING', buildIdPath);
    else if (fs.readFileSync(buildIdPath, 'utf8').trim() !== String(ctx.expectBuildId)) add('E_BUILD_ID_FILE_MISMATCH');
    const serverEntry = path.join(repo, '.next', 'standalone', 'server.js');
    if (!fs.existsSync(serverEntry)) add('E_CARRIER_MISSING', serverEntry);
  } else if (!/^[A-Za-z0-9_-]{1,64}$/.test(ctx.expectBuildId)
      || build?.rootBuildId !== ctx.expectBuildId || build.standaloneBuildId !== ctx.expectBuildId
      || !Number.isSafeInteger(build.serverJsBytes) || build.serverJsBytes <= 0
      || typeof build.serverJsSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(build.serverJsSha256)) {
    add('E_BUILD_REPLAY_IDENTITY');
  }

  const sources = Array.isArray(run.sources) ? run.sources : [];
  if (sources.length < 6) add('E_SOURCES_SHORT', sources.length);
  const sourceMap = new Map();
  for (const entry of sources) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      add('E_SOURCE_SHAPE', JSON.stringify(entry));
      continue;
    }
    const relative = entry.path.replace(/\\/g, '/');
    if (relative.startsWith('/') || relative.includes('..')) add('E_SOURCE_PATH', relative);
    if (sourceMap.has(relative)) add('E_SOURCE_DUPLICATE', relative);
    if (!REQUIRED_SOURCE_SET.has(relative)) add('E_SOURCE_UNEXPECTED', relative);
    const file = path.join(repo, relative);
    if (!fs.existsSync(file)) {
      add('E_SOURCE_MISSING', relative);
      continue;
    }
    const actual = sha256File(file);
    if (actual !== entry.sha256.toUpperCase()) add('E_SOURCE_HASH', `${relative} ${actual} != ${entry.sha256}`);
    sourceMap.set(relative, entry.sha256.toUpperCase());
  }
  const specSource = sourceMap.get(SPEC_RELATIVE);
  if (!specSource) add('E_SPEC_SOURCE_MISSING', SPEC_RELATIVE);
  for (const required of REQUIRED_SOURCES) {
    if (!sourceMap.has(required)) add('E_SOURCE_REQUIRED', required);
  }
  facts.spec = specSource ?? null;

  // runner 身份：完整校验五字段与键白名单；CI 传入期望时逐项比对。
  const runner = identity.runner;
  const projectedRunner = projectRunner(runner, add);
  facts.runner = projectedRunner;
  if (ctx.expectRun !== undefined && ctx.expectRun !== null && String(runner?.runId ?? '') !== String(ctx.expectRun)) {
    add('E_RUNNER_EXPECT_RUN', `${runner?.runId} != ${ctx.expectRun}`);
  }
  if (ctx.expectAttempt !== undefined && ctx.expectAttempt !== null && String(runner?.runAttempt ?? '') !== String(ctx.expectAttempt)) {
    add('E_RUNNER_EXPECT_ATTEMPT', `${runner?.runAttempt} != ${ctx.expectAttempt}`);
  }
  if (ctx.expectJob !== undefined && ctx.expectJob !== null && String(runner?.job ?? '') !== String(ctx.expectJob)) {
    add('E_RUNNER_EXPECT_JOB', `${runner?.job} != ${ctx.expectJob}`);
  }
  if (ctx.expectWorkflow !== undefined && ctx.expectWorkflow !== null && String(runner?.workflow ?? '') !== String(ctx.expectWorkflow)) {
    add('E_RUNNER_EXPECT_WORKFLOW', `${runner?.workflow} != ${ctx.expectWorkflow}`);
  }
  if (ctx.expectRef !== undefined && ctx.expectRef !== null && String(runner?.ref ?? '') !== String(ctx.expectRef)) {
    add('E_RUNNER_EXPECT_REF', `${runner?.ref} != ${ctx.expectRef}`);
  }

  // 未重试：证据只在 0 retry 的用例上成立。
  const testFact = evidence.test;
  if (!testFact || typeof testFact !== 'object' || testFact.status !== 'passed') add('E_RUN_TEST_STATUS', JSON.stringify(testFact ?? null));
  if (testFact && testFact.retry !== 0) add('E_RUN_RETRY', String(testFact.retry));
  if (ctx.specPath) {
    if (!fs.existsSync(ctx.specPath)) add('E_SPEC_CANDIDATE_MISSING', ctx.specPath);
    else {
      const candidateHash = sha256File(ctx.specPath);
      if (specSource && candidateHash !== specSource) add('E_SPEC_CANDIDATE_DRIFT', `${candidateHash} != ${specSource}`);
    }
  }
  const installedSpec = path.join(repo, SPEC_RELATIVE);
  if (!fs.existsSync(installedSpec)) add('E_SPEC_NOT_INSTALLED', SPEC_RELATIVE);
  else if (specSource && sha256File(installedSpec) !== specSource) add('E_SPEC_INSTALLED_DRIFT', SPEC_RELATIVE);

  const tokens = evidence.tokens;
  if (!tokens || typeof tokens !== 'object') add('E_TOKENS_MISSING');
  else {
    for (const [key, expected] of Object.entries(TOKENS)) {
      if (tokens[key] !== expected) add('E_TOKEN_VALUE', `${key}=${String(tokens[key])} != ${expected}`);
    }
    if (tokens.heroBtnBorderWidth !== TOKENS.cssBorder) add('E_TOKEN_BUTTON_BORDER', String(tokens.heroBtnBorderWidth));
    if (tokens.heroBtnBorderRadius !== TOKENS.cssRadius) add('E_TOKEN_BUTTON_RADIUS', String(tokens.heroBtnBorderRadius));
  }

  const catalog = evidence.catalog;
  if (!catalog || typeof catalog !== 'object') add('E_CATALOG_MISSING');
  else {
    if (!Array.isArray(catalog.apiModelsGets) || catalog.apiModelsGets.length !== 0) add('E_CATALOG_API_MODELS', JSON.stringify(catalog.apiModelsGets));
    if (catalog.ssrStatus !== 200) add('E_CATALOG_SSR_STATUS', String(catalog.ssrStatus));
    if (catalog.ssrHasTitle !== true) add('E_CATALOG_SSR_TITLE');
    if (!(num(catalog.ssrArticleCardCount) >= 12)) add('E_CATALOG_SSR_CARDS', String(catalog.ssrArticleCardCount));
  }

  // R4 同意与零写入门：逐字段核对同意前、独立拒绝上下文、同意后撤回三阶段的网络与持久零写入。
  const consent = evidence.consent;
  let preStageOk = false;
  let rejectStageOk = false;
  let withdrawStageOk = false;
  if (!consent || typeof consent !== 'object') add('E_CONSENT_MISSING');
  else {
    if (consent.postStatus !== 200) add('E_CONSENT_STATUS', String(consent.postStatus));
    if (consent.grantedCookieShape !== true) add('E_CONSENT_GRANT_SHAPE');
    if (consent.collecting !== true) add('E_CONSENT_COLLECTING');
    if (!nonNegInt(consent.preConsentPosts) || consent.preConsentPosts !== 0) {
      add('E_CONSENT_PRE_POSTS', String(consent.preConsentPosts));
    }
    if (!nonNegInt(consent.postAcceptEventPosts) || consent.postAcceptEventPosts !== 0) {
      add('E_CONSENT_PRE_POSTS', `postAccept=${String(consent.postAcceptEventPosts)}`);
    }
    preStageOk = validateZeroConsentStage(consent.preConsent, 'E_CONSENT_PRE', {
      requireIsolated: false,
      requireConsentStatus: false,
      requirePostAcceptZero: true,
    }, add);
    rejectStageOk = validateZeroConsentStage(consent.rejected, 'E_CONSENT_REJECT', {
      requireIsolated: true,
      requireConsentStatus: true,
      requirePostAcceptZero: false,
    }, add);
    withdrawStageOk = validateZeroConsentStage(consent.withdrawn, 'E_CONSENT_WITHDRAW', {
      requireIsolated: false,
      requireConsentStatus: true,
      requirePostAcceptZero: false,
    }, add);
    // 接受/撤回必须同主上下文；独立拒绝必须是另一个 nonce，且整段晚于撤回结束（A32 整段复制按此拒）。
    if (preStageOk && withdrawStageOk) {
      if (consent.preConsent.contextNonce !== consent.withdrawn.contextNonce) {
        add('E_CONSENT_CONTEXT_SPLIT', `${consent.preConsent.contextNonce} != ${consent.withdrawn.contextNonce}`);
      }
      if (Date.parse(consent.withdrawn.startedAt) < Date.parse(consent.preConsent.finishedAt)) {
        add('E_CONSENT_WITHDRAW_TIME', `${consent.withdrawn.startedAt} < preConsent.finishedAt ${consent.preConsent.finishedAt}`);
      }
    }
    if (withdrawStageOk && rejectStageOk) {
      if (consent.rejected.contextNonce === consent.withdrawn.contextNonce) {
        add('E_CONSENT_REJECT_CONTEXT', 'rejected reuses main-context nonce');
      }
      if (Date.parse(consent.rejected.startedAt) < Date.parse(consent.withdrawn.finishedAt)) {
        add('E_CONSENT_REJECT_TIME', `${consent.rejected.startedAt} < withdrawn.finishedAt ${consent.withdrawn.finishedAt}`);
      }
    }
    if (isIso(run.startedAt) && isIso(run.finishedAt)) {
      const runStart = Date.parse(run.startedAt);
      const runEnd = Date.parse(run.finishedAt);
      if (runStart <= runEnd) {
        for (const name of ['preConsent', 'withdrawn', 'rejected']) {
          const stage = consent[name];
          if (!isIso(stage?.startedAt) || !isIso(stage?.finishedAt)) continue;
          const stageStart = Date.parse(stage.startedAt);
          const stageEnd = Date.parse(stage.finishedAt);
          if (stageStart <= stageEnd && (stageStart < runStart || stageEnd > runEnd)) {
            add('E_CONSENT_RUN_WINDOW', name);
          }
        }
      }
    }
  }

  const navigation = evidence.navigation;
  if (!navigation || navigation.homeMarkerKept !== true || navigation.productsMarkerKept !== true) {
    add('E_NAVIGATION_MARKER', JSON.stringify(navigation ?? null));
  }

  const events = evidence.events;
  const association = events?.association;
  const glb = evidence.glb;
  const glbFacts = Array.isArray(glb?.facts) ? glb.facts : [];
  const catalogModel = evidence.catalog?.model;
  const fallbackProducts = readFallbackProducts(repo);

  if (!catalogModel || typeof catalogModel !== 'object'
      || typeof catalogModel.slug !== 'string' || !catalogModel.slug
      || typeof catalogModel.path !== 'string'
      || typeof catalogModel.search !== 'string') {
    add('E_CATALOG_MODEL_MISSING');
  } else {
    if (catalogModel.source !== 'api' && catalogModel.source !== 'fallback') {
      add('E_CATALOG_SOURCE', String(catalogModel.source));
    }
    if (association && typeof association.productSlug === 'string' && catalogModel.slug !== association.productSlug) {
      add('E_CATALOG_SLUG_MISMATCH', `${catalogModel.slug} != ${association.productSlug}`);
    }
    if (glb?.card && typeof glb.card.slug === 'string' && catalogModel.slug !== glb.card.slug) {
      add('E_CATALOG_SLUG_MISMATCH', `${catalogModel.slug} != card:${glb.card.slug}`);
    }
    if (glb && (glb.catalogPath !== catalogModel.path || glb.catalogSearch !== catalogModel.search)) {
      add('E_GLB_CATALOG_ECHO', `${String(glb.catalogPath)}${String(glb.catalogSearch)} != ${catalogModel.path}${catalogModel.search}`);
    }
    if (catalogModel.source === 'fallback') {
      if (!/^\/models\/[^/]+\.glb$/.test(catalogModel.path)) add('E_GLB_PATH', catalogModel.path);
      if (catalogModel.search !== '') add('E_GLB_SEARCH', catalogModel.search);
      if (catalogModel.apiModelId !== null || catalogModel.apiVersion !== null
          || (catalogModel.apiUpdatedAt !== undefined && catalogModel.apiUpdatedAt !== null)) {
        add('E_GLB_API_ID', 'fallback must not set api fields');
      }
      if (!fallbackProducts) add('E_CATALOG_PRODUCTS_MISSING');
      else if (fallbackProducts.get(catalogModel.slug) !== catalogModel.path) {
        add('E_GLB_SLUG_PATH', `${catalogModel.slug}: ${catalogModel.path} != ${String(fallbackProducts.get(catalogModel.slug) ?? null)}`);
      }
    } else if (catalogModel.source === 'api') {
      const apiPathMatch = /^\/api\/models\/([^/]+)\/glb$/.exec(catalogModel.path);
      if (!apiPathMatch) {
        add('E_GLB_PATH', catalogModel.path);
      } else {
        const pathId = apiPathMatch[1];
        if (!/^[a-z0-9]{20,40}$/.test(pathId) || typeof catalogModel.apiModelId !== 'string' || catalogModel.apiModelId !== pathId) {
          add('E_GLB_API_ID', `${String(catalogModel.apiModelId)} != ${pathId}`);
        }
      }
      if (typeof catalogModel.apiVersion !== 'string' || !/^[0-9a-z]{1,16}$/.test(catalogModel.apiVersion)) {
        add('E_GLB_API_VERSION', String(catalogModel.apiVersion));
      } else {
        if (catalogModel.search !== `?v=${catalogModel.apiVersion}`) {
          add('E_GLB_SEARCH', `${catalogModel.search} != ?v=${catalogModel.apiVersion}`);
        }
        if (!isIso(catalogModel.apiUpdatedAt)
            || new Date(catalogModel.apiUpdatedAt).getTime().toString(36) !== catalogModel.apiVersion) {
          add('E_GLB_API_VERSION', `updatedAt=${String(catalogModel.apiUpdatedAt)} != v=${catalogModel.apiVersion}`);
        }
      }
    }
  }

  for (const fact of glbFacts) {
    if (!fact || typeof fact !== 'object') {
      add('E_GLB_FACT', JSON.stringify(fact));
      continue;
    }
    const isStatic = typeof fact.path === 'string' && /^\/models\/[^/]+\.glb$/.test(fact.path);
    const isApi = typeof fact.path === 'string' && /^\/api\/models\/[^/]+\/glb$/.test(fact.path);
    if (!isStatic && !isApi) add('E_GLB_PATH', String(fact.path));
    if (isStatic && fact.status === 200) {
      const served = path.join(repo, 'public', fact.path);
      if (!fs.existsSync(served)) add('E_GLB_FILE_MISSING', fact.path);
      else if (num(fact.servedFileSize) !== fs.statSync(served).size) add('E_GLB_FILE_SIZE', `${fact.path} ${fact.servedFileSize} != ${fs.statSync(served).size}`);
      if (num(fact.contentLength) !== null && fact.contentLength <= 0) add('E_GLB_CONTENT_LENGTH', `${fact.path} ${fact.contentLength}`);
    }
  }

  // facts 中与目录路径匹配的响应必须唯一且自身为 200/非 SW/真实字节；chosen 必须与该唯一事实逐字段相等。
  const matchingFacts = catalogModel && typeof catalogModel.path === 'string'
    ? glbFacts.filter((fact) => fact && fact.path === catalogModel.path)
    : [];
  if (catalogModel && typeof catalogModel.path === 'string' && matchingFacts.length !== 1) {
    add('E_GLB_FACT_COUNT', `${catalogModel.path} count=${matchingFacts.length}`);
  }
  const matchedFact = matchingFacts.length === 1 ? matchingFacts[0] : null;
  const chosen = glb?.chosen;

  const verifyGlbResponse = (target, label) => {
    if (typeof target.path !== 'string' || !/^(\/models\/[^/]+\.glb|\/api\/models\/[^/]+\/glb)$/.test(target.path)) {
      add('E_GLB_PATH', `${label}:${String(target.path)}`);
    }
    if (catalogModel && typeof catalogModel.path === 'string' && target.path !== catalogModel.path) {
      add('E_GLB_SLUG_PATH', `${label}:${target.path} != ${catalogModel.path}`);
    }
    if (typeof catalogModel?.search === 'string' && target.search !== catalogModel.search) {
      add('E_GLB_SEARCH', `${label}:${target.search} != ${catalogModel.search}`);
    }
    if (target.status !== 200) add('E_GLB_STATUS', `${label}:${String(target.status)}`);
    if (target.fromServiceWorker !== false) add('E_GLB_SERVICE_WORKER', `${label}:${String(target.fromServiceWorker)}`);
    if (!(num(target.bodyBytes) > 1_000)) add('E_GLB_BODY', `${label}:${String(target.bodyBytes)}`);
    if (typeof target.bodySha256 !== 'string' || !/^[0-9A-F]{64}$/.test(target.bodySha256)) {
      add('E_GLB_BODY_SHA', `${label}:${String(target.bodySha256)}`);
    }
    if (num(target.requestAt) === null || num(target.responseAt) === null || target.responseAt < target.requestAt) {
      add('E_GLB_TIME_ORDER', `${label}:${String(target.requestAt)}->${String(target.responseAt)}`);
    }
    if (catalogModel?.source === 'fallback') {
      const served = path.join(repo, 'public', target.path);
      if (!fs.existsSync(served)) add('E_GLB_FILE_MISSING', target.path);
      else {
        const bytes = fs.readFileSync(served);
        const size = bytes.length;
        const digest = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
        if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'glTF') {
          add('E_GLB_MAGIC', target.path);
        }
        if (size !== target.bodyBytes || size !== target.servedFileSize) {
          add('E_GLB_FILE_SIZE', `${label}:${target.path} body=${target.bodyBytes} served=${target.servedFileSize} disk=${size}`);
        }
        if (digest !== target.bodySha256 || digest !== target.servedFileSha256) {
          add('E_GLB_FILE_SHA', `${label}:${target.path} body=${target.bodySha256} served=${target.servedFileSha256} disk=${digest}`);
        }
      }
    } else if (catalogModel?.source === 'api') {
      const apiMatch = typeof target.path === 'string' ? /^\/api\/models\/([^/]+)\/glb$/.exec(target.path) : null;
      const pathId = apiMatch ? apiMatch[1] : null;
      if (!pathId || !/^[a-z0-9]{20,40}$/.test(pathId) || pathId !== catalogModel.apiModelId) {
        add('E_GLB_API_ID', `${label}:${String(pathId)} != ${String(catalogModel.apiModelId)}`);
      }
      const version = (() => {
        try { return new URLSearchParams(target.search).get('v'); } catch { return null; }
      })();
      if (version !== catalogModel.apiVersion) {
        add('E_GLB_API_VERSION', `${label}:${String(version)} != ${String(catalogModel.apiVersion)}`);
      }
      if (target.servedFileSize !== null || target.servedFileSha256 !== null) {
        add('E_GLB_API_STATIC_FIELDS', label);
      }
    }
  };

  if (!chosen || typeof chosen !== 'object') {
    add('E_GLB_CHOSEN_MISSING');
  } else {
    verifyGlbResponse(chosen, 'chosen');
    if (matchedFact) verifyGlbResponse(matchedFact, 'fact');
    if (!matchedFact || !sameGlbFact(matchedFact, chosen)) {
      add('E_GLB_FACT_MISMATCH');
    }
  }
  facts.glb = {
    count: glbFacts.length,
    matchedCount: matchingFacts.length,
    chosen: glb?.chosen?.path ?? null,
    catalog: catalogModel?.path ?? null,
    source: catalogModel?.source ?? null,
  };

  const starts = Array.isArray(events?.starts) ? events.starts : [];
  const terminals = Array.isArray(events?.terminals) ? events.terminals : [];
  const pageViews = Array.isArray(events?.pageViews) ? events.pageViews : [];
  const productViews = Array.isArray(events?.productViews) ? events.productViews : [];
  const responseStatuses = Array.isArray(events?.responseStatuses) ? events.responseStatuses : [];
  const posts = Array.isArray(events?.posts) ? events.posts : [];
  if (!association || typeof association !== 'object') add('E_ASSOCIATION_MISSING');
  if (posts.length === 0) add('E_EVENT_POSTS_EMPTY');
  if (responseStatuses.length !== posts.length) add('E_EVENT_STATUS_COUNT', `${responseStatuses.length} != ${posts.length}`);
  if (responseStatuses.some((status) => status !== 200)) add('E_EVENT_STATUS', JSON.stringify(responseStatuses));

  let matchedStart = null;
  let matchedTerminal = null;
  if (association) {
    const { viewId, navigationId, productSlug, startEventId, terminalEventId, pageViewEventId, productViewEventId, oneTerminalForView } = association;
    if (typeof viewId !== 'string' || !viewId) add('E_ASSOC_VIEW_ID');
    if (typeof navigationId !== 'string' || !navigationId) add('E_ASSOC_NAV_ID');
    if (typeof productSlug !== 'string' || !productSlug) add('E_ASSOC_SLUG');
    if (oneTerminalForView !== true) add('E_ASSOC_TERMINAL_COUNT');
    const matchingStarts = starts.filter((event) => event.viewId === viewId);
    const matchingTerminals = terminals.filter((event) => event.viewId === viewId);
    if (matchingStarts.length !== 1) add('E_ASSOC_START_COUNT', matchingStarts.length);
    if (matchingTerminals.length !== 1) add('E_ASSOC_TERMINAL_TOTAL', matchingTerminals.length);
    const start = matchingStarts[0];
    const terminal = matchingTerminals[0];
    matchedStart = start ?? null;
    matchedTerminal = terminal ?? null;
    if (!start || start.eventId !== startEventId) add('E_ASSOC_START_ID');
    if (!terminal || terminal.eventId !== terminalEventId) add('E_ASSOC_TERMINAL_ID');
    if (terminal && terminal.kind !== 'model_load_success') add('E_ASSOC_TERMINAL_KIND', String(terminal.kind));
    if (start && terminal) {
      if (start.navigationId !== terminal.navigationId) add('E_ASSOC_NAV_MISMATCH');
      if (start.productSlug !== terminal.productSlug) add('E_ASSOC_SLUG_MISMATCH');
      if (start.navigationId !== navigationId) add('E_ASSOC_NAV_VALUE');
      if (start.productSlug !== productSlug) add('E_ASSOC_SLUG_VALUE');
    }
    const startAt = isIso(start?.occurredAt) ? Date.parse(start.occurredAt) : NaN;
    const successAt = isIso(terminal?.occurredAt) ? Date.parse(terminal.occurredAt) : NaN;
    if (!Number.isFinite(startAt) || !Number.isFinite(successAt)) {
      add('E_GLB_WINDOW_TIME');
    } else if (successAt < startAt) {
      add('E_ASSOC_TIME_ORDER', `${start.occurredAt} > ${terminal.occurredAt}`);
    } else if (glb?.chosen) {
      const checkResponseInWindow = (target, label) => {
        if (num(target?.responseAt) === null
            || target.responseAt < startAt - 2_000 || target.responseAt > successAt + 2_000) {
          add('E_GLB_WINDOW', `${label}:${String(target?.responseAt)} not in [${startAt - 2_000}, ${successAt + 2_000}]`);
        }
      };
      checkResponseInWindow(glb.chosen, 'chosen');
      if (matchedFact && matchedFact !== glb.chosen) checkResponseInWindow(matchedFact, 'fact');
      if (glb.window && (glb.window.startAt !== startAt || glb.window.successAt !== successAt)) {
        add('E_GLB_WINDOW_DRIFT', `${String(glb.window.startAt)}..${String(glb.window.successAt)} != ${startAt}..${successAt}`);
      }
    }
    if (glb?.chosen) {
      if (glb.card?.slug !== productSlug) add('E_GLB_CARD_SLUG', `${glb.card?.slug} != ${productSlug}`);
      if (glb.card?.stateAfter !== 'ready') add('E_GLB_CARD_STATE', String(glb.card?.stateAfter));
      if (glb.card?.stateAtPointer === 'ready') add('E_GLB_CARD_PRE');
    }
    const pv = pageViews.find((view) => view.eventId === pageViewEventId);
    if (!pv) add('E_ASSOC_PAGE_VIEW');
    else {
      if (pv.path !== '/en/products') add('E_ASSOC_PAGE_VIEW_PATH', String(pv.path));
      if (pv.navigationId !== navigationId) add('E_ASSOC_PAGE_VIEW_NAV');
    }
    const productView = productViews.find((view) => view.eventId === productViewEventId);
    if (!productView) add('E_ASSOC_PRODUCT_VIEW');
    else {
      if (productView.navigationId !== navigationId) add('E_ASSOC_PRODUCT_VIEW_NAV');
      if (productView.productSlug !== productSlug) add('E_ASSOC_PRODUCT_VIEW_SLUG');
    }
    if (starts.length !== new Set(starts.map((event) => event.eventId)).size) add('E_ASSOC_START_DUPLICATE');
    facts.association = { viewId, navigationId, productSlug, starts: starts.length, terminals: terminals.length };
  }

  const db = evidence.db;
  const dbRows = Array.isArray(db?.rows) ? db.rows : [];
  if (!db || typeof db !== 'object') add('E_DB_MISSING');
  else {
    // 原始 cluster 标识不得进 RUN：只接受三元组投影，且三元组要与 runner 的 service 侧独立读取相等。
    walkKeys(db, (key, trail) => {
      if (/system[_-]?identifier/i.test(key)) add('E_DB_PG_RAW', trail);
    });
    const pg = db.pg;
    let pgOk = true;
    if (!pg || typeof pg !== 'object' || Array.isArray(pg)) {
      add('E_DB_PG_MISSING');
      pgOk = false;
    } else {
      const pgKeys = Object.keys(pg).sort();
      if (pgKeys.join(',') !== 'clusterSha256,database,serverVersionNum') {
        add('E_DB_PG_SHAPE', pgKeys.join(','));
        pgOk = false;
      }
      if (typeof pg.database !== 'string' || !DB_NAME_RE.test(pg.database)) {
        add('E_DB_PG_DATABASE', String(pg.database));
        pgOk = false;
      } else {
        const expectedName = ctx.expectPgDatabase
          || (ctx.expectRun && ctx.expectAttempt ? `b10_j6_seam_${ctx.expectRun}_${ctx.expectAttempt}` : null);
        if (expectedName && pg.database !== expectedName) {
          add('E_DB_PG_DATABASE', `${pg.database} != ${expectedName}`);
          pgOk = false;
        }
      }
      if (!Number.isInteger(pg.serverVersionNum) || pg.serverVersionNum < 170000 || pg.serverVersionNum > 179999) {
        add('E_DB_PG_VERSION', String(pg.serverVersionNum));
        pgOk = false;
      } else if (ctx.expectPgVersion && pg.serverVersionNum !== Number(ctx.expectPgVersion)) {
        add('E_DB_PG_VERSION', `${pg.serverVersionNum} != ${ctx.expectPgVersion}`);
        pgOk = false;
      }
      if (typeof pg.clusterSha256 !== 'string' || !CLUSTER_SHA_RE.test(pg.clusterSha256)) {
        add('E_DB_PG_CLUSTER', String(pg.clusterSha256));
        pgOk = false;
      } else if (ctx.expectPgCluster && pg.clusterSha256 !== ctx.expectPgCluster) {
        add('E_DB_PG_CLUSTER', `${pg.clusterSha256} != ${ctx.expectPgCluster}`);
        pgOk = false;
      }
      if (pgOk) {
        facts.pg = { database: pg.database, serverVersionNum: pg.serverVersionNum, clusterSha256: pg.clusterSha256 };
      }
    }
    const rows = dbRows;
    const ids = Array.isArray(db.eventIds) ? db.eventIds : [];
    if (rows.length === 0) add('E_DB_EMPTY');
    if (db.rowCount !== rows.length) add('E_DB_ROW_COUNT', `${db.rowCount} != ${rows.length}`);
    if (ids.length !== rows.length) add('E_DB_ID_COUNT', `${ids.length} != ${rows.length}`);
    if (new Set(ids).size !== ids.length) add('E_DB_ID_DUPLICATE');
    if (!isIso(db.maxReceivedAt)) add('E_DB_MAX_RECEIVED', String(db.maxReceivedAt));
    const receivedMsList = [];
    for (const row of rows) {
      if (!row || !ids.includes(row.eventId)) add('E_DB_EVENT_ID', JSON.stringify(row?.eventId ?? null));
      if (row && row.kind === 'model_load_failure') add('E_DB_UNEXPECTED_FAILURE', row.eventId);
      if (!isIso(row?.occurredAt) || !isIso(row?.receivedAt)) add('E_DB_TIME', JSON.stringify(row?.eventId ?? null));
      else receivedMsList.push(Date.parse(row.receivedAt));
    }
    if (isIso(db.maxReceivedAt) && receivedMsList.length === rows.length && rows.length > 0) {
      const actualMaxReceived = Math.max(...receivedMsList);
      if (Date.parse(db.maxReceivedAt) !== actualMaxReceived) {
        add('E_DB_MAX_RECEIVED_DRIFT', `${db.maxReceivedAt} != ${new Date(actualMaxReceived).toISOString()}`);
      }
    }
    if (association) {
      const byId = new Map(rows.map((row) => [row.eventId, row]));
      const startRow = byId.get(association.startEventId);
      const terminalRow = byId.get(association.terminalEventId);
      const pageRow = byId.get(association.pageViewEventId);
      const productViewRow = byId.get(association.productViewEventId);
      if (!startRow || startRow.kind !== 'model_view_start' || startRow.viewId !== association.viewId) add('E_DB_START');
      if (!terminalRow || terminalRow.kind !== 'model_load_success' || terminalRow.viewId !== association.viewId) add('E_DB_TERMINAL');
      if (!pageRow || pageRow.kind !== 'page_view' || pageRow.path !== '/en/products' || pageRow.navigationId !== association.navigationId) add('E_DB_PAGE_VIEW');
      if (!productViewRow || productViewRow.kind !== 'product_view' || productViewRow.productSlug !== association.productSlug || productViewRow.navigationId !== association.navigationId) {
        add('E_DB_PRODUCT_VIEW');
      }
      if (startRow && startRow.productSlug !== association.productSlug) add('E_DB_START_SLUG');
      if (terminalRow && terminalRow.navigationId !== association.navigationId) add('E_DB_TERMINAL_NAV');

      // 同 eventId 核对客户端上报投影与数据库持久集合、字段、occurredAt 及合法顺序。
      const allProjected = [
        ...pageViews.map((item) => ({ ...item, expectedKind: 'page_view' })),
        ...productViews.map((item) => ({ ...item, expectedKind: 'product_view' })),
        ...starts.map((item) => ({ ...item, expectedKind: 'model_view_start' })),
        ...terminals.map((item) => ({ ...item, expectedKind: item?.kind ?? 'model_load_success' })),
      ];
      const projectedIds = new Set(allProjected.map((item) => item?.eventId).filter((id) => typeof id === 'string'));
      if (projectedIds.size !== allProjected.length || projectedIds.size !== rows.length
          || rows.some((row) => !projectedIds.has(row.eventId))) {
        add('E_DB_EVENT_SET_MISMATCH', `projected=${projectedIds.size} db=${rows.length}`);
      }
      for (const projected of allProjected) {
        if (!projected || typeof projected.eventId !== 'string') continue;
        const persisted = byId.get(projected.eventId);
        if (!persisted || !isIso(persisted.occurredAt)) continue;
        if (persisted.kind !== projected.expectedKind) {
          add('E_DB_EVENT_SET_MISMATCH', `${projected.eventId} kind ${persisted.kind} != ${projected.expectedKind}`);
        }
        if (projected.productSlug !== undefined && persisted.productSlug !== projected.productSlug) {
          add('E_DB_EVENT_SET_MISMATCH', `${projected.eventId} slug ${String(persisted.productSlug)} != ${String(projected.productSlug)}`);
        }
        if (projected.durationMs !== undefined && persisted.durationMs !== projected.durationMs) {
          add('E_DB_EVENT_SET_MISMATCH', `${projected.eventId} durationMs ${String(persisted.durationMs)} != ${String(projected.durationMs)}`);
        }
        if (projected.occurredAt !== undefined && (!isIso(projected.occurredAt) || Date.parse(projected.occurredAt) !== Date.parse(persisted.occurredAt))) {
          add('E_DB_OCCURRED_AT', `${projected.eventId}: ${String(projected.occurredAt)} != ${persisted.occurredAt}`);
        }
      }
      if (matchedStart && startRow && isIso(startRow.occurredAt)) {
        if (!isIso(matchedStart.occurredAt) || Date.parse(matchedStart.occurredAt) !== Date.parse(startRow.occurredAt)) {
          add('E_DB_OCCURRED_AT', `start:${String(matchedStart.occurredAt)} != ${startRow.occurredAt}`);
        }
      }
      if (matchedTerminal && terminalRow && isIso(terminalRow.occurredAt)) {
        if (!isIso(matchedTerminal.occurredAt) || Date.parse(matchedTerminal.occurredAt) !== Date.parse(terminalRow.occurredAt)) {
          add('E_DB_OCCURRED_AT', `terminal:${String(matchedTerminal.occurredAt)} != ${terminalRow.occurredAt}`);
        }
      }
      if (startRow && terminalRow && isIso(startRow.occurredAt) && isIso(terminalRow.occurredAt)) {
        const dbStartAt = Date.parse(startRow.occurredAt);
        const dbSuccessAt = Date.parse(terminalRow.occurredAt);
        if (dbSuccessAt < dbStartAt) add('E_DB_TIME_ORDER', `${startRow.occurredAt} > ${terminalRow.occurredAt}`);
        else if (matchedFact && (num(matchedFact.responseAt) === null
            || matchedFact.responseAt < dbStartAt - 2_000 || matchedFact.responseAt > dbSuccessAt + 2_000)) {
          add('E_GLB_WINDOW', `db:${String(matchedFact.responseAt)} not in [${dbStartAt - 2_000}, ${dbSuccessAt + 2_000}]`);
        }
      }
    }
    // 同意撤回与独立拒绝阶段必须在授权事件持久化之后观测且零增长，禁止借旧快照冒充。
    if (preStageOk && withdrawStageOk && rows.length > 0) {
      if (consent.withdrawn.dbBefore < consent.preConsent.dbAfter + rows.length) {
        add('E_CONSENT_WITHDRAW_ORDER', `${consent.withdrawn.dbBefore} < ${consent.preConsent.dbAfter} + ${rows.length}`);
      }
    }
    if (withdrawStageOk && rejectStageOk) {
      if (consent.rejected.dbBefore < consent.withdrawn.dbAfter) {
        add('E_CONSENT_REJECT_ORDER', `${consent.rejected.dbBefore} < ${consent.withdrawn.dbAfter}`);
      }
    }
    facts.db = { rows: rows.length, ids: ids.length };
  }

  if (preStageOk && rejectStageOk && withdrawStageOk) {
    facts.consent = {
      preConsentPosts: 0,
      rejectedPosts: 0,
      withdrawnPosts: 0,
      dbProgression: [
        consent.preConsent.dbBefore,
        consent.preConsent.dbAfter,
        consent.withdrawn.dbBefore,
        consent.withdrawn.dbAfter,
        consent.rejected.dbAfter,
      ],
    };
  }

  const aggregate = evidence.aggregate;
  if (!aggregate || typeof aggregate !== 'object') add('E_AGG_MISSING');
  else {
    const settings = aggregate.settings;
    if (!settings || typeof settings.timezone !== 'string' || !Number.isInteger(settings.timezoneRevision)) {
      add('E_AGG_SETTINGS');
    } else if (!isValidTimezone(settings.timezone)) {
      add('E_AGG_TIMEZONE', settings.timezone);
    }
    for (const phase of ['baseline', 'after']) {
      const job = aggregate[phase]?.job;
      if (!job) add(`E_AGG_${phase.toUpperCase()}_JOB_MISSING`);
      else {
        if (job.status !== 200) add(`E_AGG_${phase.toUpperCase()}_HTTP`, String(job.status));
        if (job.lastStatus !== 'SUCCEEDED') add(`E_AGG_${phase.toUpperCase()}_STATUS`, String(job.lastStatus));
        if (job.lockedUntil !== null) add(`E_AGG_${phase.toUpperCase()}_LOCKED`, JSON.stringify(job.lockedUntil));
      }
    }
    const baselineJob = aggregate.baseline?.job;
    const afterJob = aggregate.after?.job;
    if (baselineJob && afterJob) {
      if (!nonNegInt(baselineJob.generation) || !nonNegInt(afterJob.generation) || afterJob.generation <= baselineJob.generation) {
        add('E_AGG_JOB_GENERATION', `${String(baselineJob.generation)} -> ${String(afterJob.generation)}`);
      }
      if (isIso(baselineJob.succeededAt) && isIso(afterJob.startedAt)
          && Date.parse(afterJob.startedAt) < Date.parse(baselineJob.succeededAt)) {
        add('E_AGG_JOB_ORDER', `${afterJob.startedAt} < ${baselineJob.succeededAt}`);
      }
    }
    if (!afterJob || num(afterJob.candidateCount) === null || afterJob.candidateCount < 1) add('E_AGG_NO_TARGETS', String(afterJob?.candidateCount));
    if (!isIso(afterJob?.startedAt)) add('E_AGG_STARTED_AT', String(afterJob?.startedAt));
    if (isIso(afterJob?.startedAt) && isIso(db?.maxReceivedAt)) {
      if (Date.parse(afterJob.startedAt) < Date.parse(db.maxReceivedAt) - 2_000) add('E_AGG_BEFORE_EVENTS', `${afterJob.startedAt} < ${db.maxReceivedAt}`);
    }
    const site = aggregate.after?.site;
    const product = aggregate.after?.product;
    const baselineSite = aggregate.baseline?.site ?? null;
    const baselineProduct = aggregate.baseline?.product ?? null;
    const expectedProductDim = association && typeof association.productSlug === 'string'
      ? `product:${association.productSlug}`
      : null;

    if (!site || typeof site !== 'object') add('E_AGG_SITE_MISSING');
    if (!product || typeof product !== 'object') add('E_AGG_PRODUCT_MISSING');
    if (!isValidLocalDate(aggregate.siteDay) || aggregate.localDate !== aggregate.siteDay) {
      add('E_AGG_LOCAL_DATE', `${aggregate.localDate} != ${aggregate.siteDay}`);
    }
    if (!isValidLocalDate(aggregate.siteDay) || aggregate.eventDay !== aggregate.siteDay) {
      add('E_AGG_EVENT_DAY', `${aggregate.eventDay} != ${aggregate.siteDay}`);
    }

    let siteAfterShapeOk = false;
    let productAfterShapeOk = false;
    let siteBeforeShapeOk = baselineSite === null;
    let productBeforeShapeOk = baselineProduct === null;
    if (site && typeof site === 'object') {
      siteAfterShapeOk = validateDailyRowShape(site, 'site', 'after', 'site', settings, aggregate.siteDay, add);
    }
    if (product && typeof product === 'object' && expectedProductDim) {
      productAfterShapeOk = validateDailyRowShape(product, 'product', 'after', expectedProductDim, settings, aggregate.siteDay, add);
    } else if (product && typeof product === 'object') {
      if (product.localDate !== aggregate.siteDay) add('E_AGG_PRODUCT_LOCAL_DATE', `${product.localDate} != ${aggregate.siteDay}`);
    }
    if (baselineSite !== null) {
      if (typeof baselineSite !== 'object' || Array.isArray(baselineSite)) {
        add('E_AGG_ROW_SHAPE', 'baseline.site');
      } else {
        siteBeforeShapeOk = validateDailyRowShape(baselineSite, 'site', 'baseline', 'site', settings, aggregate.siteDay, add);
      }
    }
    if (baselineProduct !== null) {
      if (typeof baselineProduct !== 'object' || Array.isArray(baselineProduct) || !expectedProductDim) {
        add('E_AGG_ROW_SHAPE', 'baseline.product');
      } else {
        productBeforeShapeOk = validateDailyRowShape(baselineProduct, 'product', 'baseline', expectedProductDim, settings, aggregate.siteDay, add);
      }
    }

    // T12 按持久事件的 occurredAt 与站点时区分日，receivedAt 只作快照水位。
    let recomputedDay = null;
    if (settings && isValidTimezone(settings.timezone) && dbRows.length > 0) {
      const occurredDays = new Set();
      for (const row of dbRows) {
        const day = siteLocalDateOf(row?.occurredAt, settings.timezone);
        if (!day) add('E_AGG_OCCURRED_TIME', String(row?.eventId ?? null));
        else occurredDays.add(day);
      }
      if (occurredDays.size > 1) {
        add('E_AGG_OCCURRED_DAY_SPAN', [...occurredDays].sort().join(','));
      } else if (occurredDays.size === 1) {
        recomputedDay = [...occurredDays][0];
        if (aggregate.siteDay !== recomputedDay || aggregate.eventDay !== recomputedDay
            || aggregate.localDate !== recomputedDay
            || site?.localDate !== recomputedDay || product?.localDate !== recomputedDay) {
          add('E_AGG_OCCURRED_DAY', `recomputed=${recomputedDay} siteDay=${String(aggregate.siteDay)} eventDay=${String(aggregate.eventDay)}`);
        }
      }
    }

    if (site && settings) {
      if (!isIso(site.sourceThrough)) add('E_AGG_SITE_SOURCE', String(site.sourceThrough));
      else if (isIso(db?.maxReceivedAt) && Date.parse(site.sourceThrough) < Date.parse(db.maxReceivedAt)) {
        add('E_AGG_SITE_SOURCE_BEHIND', `${site.sourceThrough} < ${db.maxReceivedAt}`);
      }
      if (baselineSite?.sourceThrough && isIso(site.sourceThrough) && isIso(baselineSite.sourceThrough)
          && Date.parse(site.sourceThrough) < Date.parse(baselineSite.sourceThrough)) {
        add('E_AGG_SITE_SOURCE_BEHIND', `${site.sourceThrough} < baseline ${baselineSite.sourceThrough}`);
      }
    }
    if (product && settings) {
      if (!isIso(product.sourceThrough)) add('E_AGG_PRODUCT_SOURCE', String(product.sourceThrough));
      else if (isIso(db?.maxReceivedAt) && Date.parse(product.sourceThrough) < Date.parse(db.maxReceivedAt)) {
        add('E_AGG_PRODUCT_SOURCE_BEHIND', `${product.sourceThrough} < ${db.maxReceivedAt}`);
      }
      if (baselineProduct?.sourceThrough && isIso(product.sourceThrough) && isIso(baselineProduct.sourceThrough)
          && Date.parse(product.sourceThrough) < Date.parse(baselineProduct.sourceThrough)) {
        add('E_AGG_PRODUCT_SOURCE_BEHIND', `${product.sourceThrough} < baseline ${baselineProduct.sourceThrough}`);
      }
    }

    const expected = aggregate.expected;
    const delta = aggregate.delta;
    if (!expected || !delta) add('E_AGG_EXPECTED_MISSING');
    else {
      const slug = association?.productSlug;
      const successes = terminals.filter((event) => event.kind === 'model_load_success');
      const successesForSlugList = successes.filter((event) => event.productSlug === slug);
      const successesForSlug = successesForSlugList.length;
      if (successes.length < 1) add('E_AGG_EXPECTED_SUCCESS', String(successes.length));
      if (expected.successesAll !== successes.length) add('E_AGG_EXPECTED_SUCCESSES_ALL', `${expected.successesAll} != ${successes.length}`);
      if (expected.successesForSlug !== successesForSlug) add('E_AGG_EXPECTED_SUCCESSES_SLUG', `${expected.successesForSlug} != ${successesForSlug}`);
      const durationSum = successes.reduce((sum, event) => sum + BigInt(Math.max(0, Math.trunc(num(event.durationMs) ?? 0))), 0n);
      const durationSumForSlug = successesForSlugList.reduce((sum, event) => sum + BigInt(Math.max(0, Math.trunc(num(event.durationMs) ?? 0))), 0n);
      if (expected.durationMs !== String(durationSum)) add('E_AGG_EXPECTED_DURATION', `${expected.durationMs} != ${durationSum}`);
      if (expected.durationMsForSlug !== String(durationSumForSlug)) {
        add('E_AGG_EXPECTED_PRODUCT_DURATION', `${String(expected.durationMsForSlug)} != ${durationSumForSlug}`);
      }
      if (expected.startsAll !== starts.length) add('E_AGG_EXPECTED_STARTS_ALL', `${expected.startsAll} != ${starts.length}`);
      const expectedSlug = starts.filter((event) => event.productSlug === slug).length;
      if (expected.startsForSlug !== expectedSlug) add('E_AGG_EXPECTED_STARTS_SLUG', `${expected.startsForSlug} != ${expectedSlug}`);
      if (expected.pageViews !== pageViews.length) add('E_AGG_EXPECTED_PAGE_VIEWS', `${expected.pageViews} != ${pageViews.length}`);
      const expectedProductViews = productViews.filter((view) => view.productSlug === slug).length;
      if (expected.productViews !== expectedProductViews) add('E_AGG_EXPECTED_PRODUCT_VIEWS', `${expected.productViews} != ${expectedProductViews}`);

      const siteDelta = delta.site;
      const productDelta = delta.product;
      if (!siteDelta || !productDelta) add('E_AGG_DELTA_MISSING');
      else {
        if (siteDelta.pageViews !== expected.pageViews) add('E_AGG_DELTA_PAGE_VIEWS', String(siteDelta.pageViews));
        if (siteDelta.productViews !== productViews.length) add('E_AGG_DELTA_PRODUCT_VIEWS', String(siteDelta.productViews));
        if (siteDelta.modelStarts !== expected.startsAll) add('E_AGG_DELTA_SITE_STARTS', String(siteDelta.modelStarts));
        if (siteDelta.modelSuccesses !== expected.successesAll) add('E_AGG_DELTA_SITE_SUCCESS', String(siteDelta.modelSuccesses));
        if (siteDelta.modelFailures !== 0) add('E_AGG_DELTA_SITE_FAILURE', String(siteDelta.modelFailures));
        if (siteDelta.durationMsSum !== expected.durationMs) add('E_AGG_DELTA_DURATION', `${siteDelta.durationMsSum} != ${expected.durationMs}`);
        if (productDelta.modelStarts !== expected.startsForSlug) add('E_AGG_DELTA_PRODUCT_STARTS', String(productDelta.modelStarts));
        if (productDelta.modelSuccesses !== expected.successesForSlug) add('E_AGG_DELTA_PRODUCT_SUCCESS', String(productDelta.modelSuccesses));
        if (productDelta.modelFailures !== 0) add('E_AGG_DELTA_PRODUCT_FAILURE', String(productDelta.modelFailures));
        if (productDelta.productViews !== expected.productViews) add('E_AGG_DELTA_PRODUCT_VIEW', String(productDelta.productViews));
        if (productDelta.durationMsSum !== expected.durationMsForSlug) {
          add('E_AGG_DELTA_PRODUCT_DURATION', `${String(productDelta.durationMsSum)} != ${String(expected.durationMsForSlug)}`);
        }

        // R4：按采集器同一缺行置零与 BigInt 规则，直接从 baseline / after 日行独立复算增量并对账持久表。
        if (siteAfterShapeOk && productAfterShapeOk && siteBeforeShapeOk && productBeforeShapeOk) {
          const siteAfterDuration = BigInt(site.durationMsSum);
          const siteBeforeDuration = BigInt(baselineSite?.durationMsSum ?? '0');
          const productAfterDuration = BigInt(product.durationMsSum);
          const productBeforeDuration = BigInt(baselineProduct?.durationMsSum ?? '0');
          const recomputedSiteDelta = {
            visitors: site.visitors - (baselineSite?.visitors ?? 0),
            pageViews: site.pageViews - (baselineSite?.pageViews ?? 0),
            productViews: site.productViews - (baselineSite?.productViews ?? 0),
            modelStarts: site.modelStarts - (baselineSite?.modelStarts ?? 0),
            modelSuccesses: site.modelSuccesses - (baselineSite?.modelSuccesses ?? 0),
            modelFailures: site.modelFailures - (baselineSite?.modelFailures ?? 0),
            durationMsSum: String(siteAfterDuration - siteBeforeDuration),
          };
          const recomputedProductDelta = {
            visitors: product.visitors - (baselineProduct?.visitors ?? 0),
            productViews: product.productViews - (baselineProduct?.productViews ?? 0),
            modelStarts: product.modelStarts - (baselineProduct?.modelStarts ?? 0),
            modelSuccesses: product.modelSuccesses - (baselineProduct?.modelSuccesses ?? 0),
            modelFailures: product.modelFailures - (baselineProduct?.modelFailures ?? 0),
            durationMsSum: String(productAfterDuration - productBeforeDuration),
          };
          const hasRegression = [
            recomputedSiteDelta.visitors,
            recomputedSiteDelta.pageViews,
            recomputedSiteDelta.productViews,
            recomputedSiteDelta.modelStarts,
            recomputedSiteDelta.modelSuccesses,
            recomputedSiteDelta.modelFailures,
            recomputedProductDelta.visitors,
            recomputedProductDelta.productViews,
            recomputedProductDelta.modelStarts,
            recomputedProductDelta.modelSuccesses,
            recomputedProductDelta.modelFailures,
          ].some((item) => item < 0)
            || siteAfterDuration < siteBeforeDuration
            || productAfterDuration < productBeforeDuration;
          if (hasRegression) {
            add('E_AGG_ROW_REGRESSED');
          }
          if ((!baselineSite && recomputedSiteDelta.visitors < 1)
              || (!baselineProduct && recomputedProductDelta.visitors < 1)
              || (dbRows.length > 0 && (recomputedSiteDelta.visitors > dbRows.length || recomputedProductDelta.visitors > dbRows.length))) {
            add('E_AGG_VISITORS_IMPOSSIBLE', `site=${recomputedSiteDelta.visitors} product=${recomputedProductDelta.visitors}`);
          }
          for (const key of SITE_DELTA_KEYS) {
            if (siteDelta[key] !== recomputedSiteDelta[key]) {
              add('E_AGG_ROW_DELTA_MISMATCH', `site.${key}: delta=${String(siteDelta[key])} rowDiff=${String(recomputedSiteDelta[key])}`);
            }
          }
          for (const key of PRODUCT_DELTA_KEYS) {
            if (productDelta[key] !== recomputedProductDelta[key]) {
              add('E_AGG_ROW_DELTA_MISMATCH', `product.${key}: delta=${String(productDelta[key])} rowDiff=${String(recomputedProductDelta[key])}`);
            }
          }
          if (dbRows.length > 0 && typeof slug === 'string') {
            const dbPageViews = dbRows.filter((row) => row.kind === 'page_view').length;
            const dbProductViewsAll = dbRows.filter((row) => row.kind === 'product_view').length;
            const dbProductViewsSlug = dbRows.filter((row) => row.kind === 'product_view' && row.productSlug === slug).length;
            const dbStartsAll = dbRows.filter((row) => row.kind === 'model_view_start').length;
            const dbStartsSlug = dbRows.filter((row) => row.kind === 'model_view_start' && row.productSlug === slug).length;
            const dbSuccessRows = dbRows.filter((row) => row.kind === 'model_load_success');
            const dbSuccessRowsSlug = dbSuccessRows.filter((row) => row.productSlug === slug);
            const dbFailuresAll = dbRows.filter((row) => row.kind === 'model_load_failure').length;
            const dbDurationAll = dbSuccessRows.reduce((sum, row) => sum + BigInt(Math.max(0, Math.trunc(num(row.durationMs) ?? 0))), 0n);
            const dbDurationSlug = dbSuccessRowsSlug.reduce((sum, row) => sum + BigInt(Math.max(0, Math.trunc(num(row.durationMs) ?? 0))), 0n);
            if (recomputedSiteDelta.pageViews !== dbPageViews
                || recomputedSiteDelta.productViews !== dbProductViewsAll
                || recomputedSiteDelta.modelStarts !== dbStartsAll
                || recomputedSiteDelta.modelSuccesses !== dbSuccessRows.length
                || recomputedSiteDelta.modelFailures !== dbFailuresAll
                || recomputedSiteDelta.durationMsSum !== String(dbDurationAll)
                || recomputedProductDelta.productViews !== dbProductViewsSlug
                || recomputedProductDelta.modelStarts !== dbStartsSlug
                || recomputedProductDelta.modelSuccesses !== dbSuccessRowsSlug.length
                || recomputedProductDelta.modelFailures !== 0
                || recomputedProductDelta.durationMsSum !== String(dbDurationSlug)) {
              add('E_AGG_ROW_DB_MISMATCH', `siteDiff=${JSON.stringify(recomputedSiteDelta)} productDiff=${JSON.stringify(recomputedProductDelta)}`);
            }
          }
          facts.aggregate = {
            siteDay: aggregate.siteDay ?? null,
            localDate: aggregate.localDate ?? null,
            recomputedDay,
            recomputedSiteDelta,
            recomputedProductDelta,
          };
        } else {
          facts.aggregate = { siteDay: aggregate.siteDay ?? null, localDate: aggregate.localDate ?? null, recomputedDay };
        }
      }
    }
  }

  const network = validateJ6Network(run, add);

  const safety = evidence.safety;
  if (!safety || safety.noRouteInterception !== true || safety.noStorageWrites !== true
      || safety.noDirectWrites !== true || safety.traceDisabled !== true) {
    add('E_SAFETY_FLAGS', JSON.stringify(safety ?? null));
  }

  walkKeys(run, (key, trail) => {
    if (FORBIDDEN_KEYS.has(String(key).toLowerCase())) add('E_PII_KEY', trail);
  });
  const text = JSON.stringify(run);
  if (/https?:\/\//.test(text)) add('E_PII_URL');
  if (text.length > 262_144) add('E_RUN_SIZE', text.length);

  if (network && errors.length === 0) facts.network = network;
  return { ok: errors.length === 0, errors, facts };
}

function validate(run, ctx) {
  return validateEvidence(run, ctx, null);
}

// Internal entry for the source admission helper. The helper verifies the provenance of build.
function replayForAdmission(run, ctx, build) {
  const result = validateEvidence(run, ctx, build ?? {});
  return { ...checkReport(result, path.resolve(ctx.runDir), ctx), buildBasis: 'authenticated-build-step' };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    args[key.slice(2)] = value;
    index += 1;
  }
  return args;
}

function safeHex40(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{40}$/.test(value) ? value : null;
}

function safeBuildId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : null;
}

function checkReport(result, runDir, ctx) {
  return {
    schema: 'j6-frontend-seam-check/2',
    ok: result.ok,
    run: runDir,
    identity: {
      expectSha: ctx.expectSha,
      expectTree: ctx.expectTree,
      expectBuildId: ctx.expectBuildId,
      expectRun: ctx.expectRun ?? null,
      expectAttempt: ctx.expectAttempt ?? null,
      expectJob: ctx.expectJob ?? null,
      expectWorkflow: ctx.expectWorkflow ?? null,
      expectRef: ctx.expectRef ?? null,
      expectPgDatabase: ctx.expectPgDatabase ?? null,
      expectPgVersion: ctx.expectPgVersion ?? null,
      expectPgCluster: ctx.expectPgCluster ?? null,
    },
    errorCount: result.errors.length,
    errors: result.errors,
    facts: result.facts,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['run', 'expect-sha', 'expect-tree', 'expect-build-id', 'repo'];
  const missing = required.filter((key) => !args[key]);
  if (missing.length > 0) {
    console.error(`CHECK_EVIDENCE_ARGS missing=${missing.join(',')}`);
    process.exit(2);
  }
  if (args.receipt) {
    const receiptRequired = ['spec', 'out', 'expect-run', 'expect-attempt', 'expect-job', 'expect-workflow', 'expect-ref'];
    const receiptMissing = receiptRequired.filter((key) => !args[key]);
    if (receiptMissing.length > 0) {
      console.error(`CHECK_EVIDENCE_RECEIPT_ARGS missing=${receiptMissing.join(',')}`);
      process.exit(2);
    }
  }
  // PG 身份三元组：要么全给（runner 在 service 侧独立读到后必须全给），要么全不给（离线 validate 调用）。
  const pgArgs = ['expect-pg-database', 'expect-pg-version', 'expect-pg-cluster'];
  const pgGiven = pgArgs.filter((key) => args[key]);
  if (pgGiven.length !== 0 && pgGiven.length !== pgArgs.length) {
    console.error(`CHECK_EVIDENCE_PG_ARGS incomplete=${pgGiven.join(',')}`);
    process.exit(2);
  }
  if (args.receipt && pgGiven.length !== pgArgs.length) {
    console.error('CHECK_EVIDENCE_PG_ARGS receipt requires database/version/cluster');
    process.exit(2);
  }
  if (args['expect-pg-database'] && !DB_NAME_RE.test(args['expect-pg-database'])) {
    console.error(`CHECK_EVIDENCE_PG_DATABASE_ARG ${args['expect-pg-database']}`);
    process.exit(2);
  }
  if (args['expect-pg-version'] && !/^17[0-9]{4}$/.test(args['expect-pg-version'])) {
    console.error(`CHECK_EVIDENCE_PG_VERSION_ARG ${args['expect-pg-version']}`);
    process.exit(2);
  }
  if (args['expect-pg-cluster'] && !CLUSTER_SHA_RE.test(args['expect-pg-cluster'])) {
    console.error(`CHECK_EVIDENCE_PG_CLUSTER_ARG ${args['expect-pg-cluster']}`);
    process.exit(2);
  }
  const runDir = path.resolve(args.run);
  const runFile = path.join(runDir, 'RUN.json');
  if (!fs.existsSync(runFile)) {
    console.error(`CHECK_EVIDENCE_RUN_MISSING ${runFile}`);
    process.exit(2);
  }
  const checkFile = args.out ? path.resolve(args.out) : null;
  const receiptFile = args.receipt ? path.resolve(args.receipt) : null;
  if (receiptFile) {
    if (!(receiptFile === runDir || receiptFile.startsWith(`${runDir}${path.sep}`))) {
      console.error(`CHECK_EVIDENCE_RECEIPT_OUTSIDE ${receiptFile}`);
      process.exit(2);
    }
    if (!(checkFile === runDir || checkFile.startsWith(`${runDir}${path.sep}`))) {
      console.error(`CHECK_EVIDENCE_OUT_OUTSIDE ${checkFile}`);
      process.exit(2);
    }
    if (fs.existsSync(checkFile)) {
      console.error(`CHECK_EVIDENCE_OUT_EXISTS ${checkFile}`);
      process.exit(2);
    }
    if (fs.existsSync(receiptFile)) {
      console.error(`CHECK_EVIDENCE_RECEIPT_EXISTS ${receiptFile}`);
      process.exit(2);
    }
  }
  let run;
  try {
    run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  } catch (error) {
    console.error(`CHECK_EVIDENCE_RUN_JSON ${error.message}`);
    process.exit(2);
  }
  const ctx = {
    runDir: args.run,
    repo: args.repo,
    specPath: args.spec,
    expectSha: args['expect-sha'],
    expectTree: args['expect-tree'],
    expectBuildId: args['expect-build-id'],
    expectRun: args['expect-run'],
    expectAttempt: args['expect-attempt'],
    expectJob: args['expect-job'],
    expectWorkflow: args['expect-workflow'],
    expectRef: args['expect-ref'],
    expectPgDatabase: args['expect-pg-database'] ?? null,
    expectPgVersion: args['expect-pg-version'] ?? null,
    expectPgCluster: args['expect-pg-cluster'] ?? null,
  };
  const result = validate(run, ctx);
  const output = checkReport(result, runDir, ctx);
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (checkFile) {
    fs.writeFileSync(checkFile, text);
  }
  // 固定 runner 回执：只写经逐字段校验投影的 runner 与实物摘要，不复制原始对象。
  if (receiptFile) {
    const receipt = {
      schema: 'j6-runner-receipt/1',
      runner: result.facts.runner ?? null,
      head: safeHex40(run?.identity?.head),
      tree: safeHex40(run?.identity?.tree),
      buildId: safeBuildId(run?.identity?.buildId),
      // 只投影经校验的 PG 三元组；原始 system identifier 与私有日志都不进回执。
      pg: result.facts.pg ?? null,
      checker: { file: path.basename(__filename), sha256: sha256File(__filename) },
      run: { file: 'RUN.json', bytes: fs.statSync(runFile).size, sha256: sha256File(runFile) },
      check: { file: path.basename(checkFile), bytes: fs.statSync(checkFile).size, sha256: sha256File(checkFile) },
      spec: { sha256: result.facts.spec ?? null },
      verdict: result.ok ? 'PASS' : 'FAIL',
      receiptAt: new Date().toISOString(),
    };
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  process.stdout.write(text);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();
module.exports = {
  validate,
  replayForAdmission,
  projectRunner,
  siteLocalDateOf,
  TOKENS,
  SPEC_RELATIVE,
  REQUIRED_SOURCES,
};
