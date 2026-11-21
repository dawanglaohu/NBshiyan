#!/usr/bin/env node
/**
 * J7 同构建探针（`j7-probe/2`）——真实 Next + 真实 PG17 上的一次性核验。
 *
 * 与 R1 的差别（B10-FORMAL-J7-R2）：
 *   - 计数边界按真实包装入口分开：settings 的 guard 级 401 显式不计数（delta=0），
 *     POST /api/admin/account/session/activity 的 401 由 fromGuard→finish→record 计数，
 *     作为"真正包装过的响应正控"；并用错误码拒绝 forbidorigin 之类的错层 403。
 *   - separation 由本次真实鉴权生产者产出：scripts/create-admin.mjs 建一次性管理员
 *     + Auth.js credentials(/api/auth/callback/credentials, TOTP) 登录 → 管理员 200 且
 *     无同意 cookie；同意 cookie 由 POST /api/analytics/consent 真实签发；撤回后
 *     events 403 且该 eventId 在 AnalyticsEvent 中 0 行。
 *   - 构建摘要由探针自己按整树逐文件重算；PG 身份带 cluster SHA-256（不出原始值）。
 *   - 可选 nodata 模式：在同一构建、同一 PG17 集群的独占新库上观察"无数据"合同。
 *
 * B10-FORMAL-J7-R2.1（`j7-probe/3`）：
 *   - 主实例持久化失败归属：聚合先真实 SUCCEEDED 固定暖态（lastSucceededAt / sourceThrough /
 *     revision / 其余每 key 前态），再用 PG 时钟 + 真实 settings revision 定出当前站点日，
 *     只在该一次性库里把 `AnalyticsRollupDay` 的该日 `timezoneRevision` 写成 revision+1，
 *     让真实 `POST /api/admin/cron/operations` 自己走 `AggregateVersionConflict` 并持久化
 *     FAILED/`version_conflict`；断言代次+1、租约释放、旧成功时刻/水位/指标不推进、
 *     其余 key 逐一相等，最后恢复边界行并核对整库指纹回到造 fixture 之前。
 *   - 失败归属只由本实例的 JobState 给出；J4 的独立容器报告只作旁证，不冒充同实例。
 *
 * 只允许 loopback；只调既有产品入口；失败只输出一行固定码并退出 1，不写半份报告。
 * 报告不含 cookie 值、Bearer、DSN、邮箱、TOTP 种子、响应正文。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);
const digestLib = requireFromHere('./j7-digest.cjs');

const FAIL = (code) => {
  process.stderr.write(`${code.startsWith('J7_') ? code : `J7_PROBE_${code}`}\n`);
  process.exit(1);
};
const fail = (code) => FAIL(code);

function env(name, { optional = false } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (optional) return null;
    fail(`J7_PROBE_ENV_MISSING:${name}`);
  }
  return value;
}
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}
function parseLoopbackUrl(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`J7_PROBE_URL_INVALID:${name}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`J7_PROBE_URL_INVALID:${name}`);
  if (!isLoopbackHost(url.hostname)) fail(`J7_PROBE_URL_NOT_LOOPBACK:${name}`);
  if (url.pathname !== '/' || url.search || url.hash) fail(`J7_PROBE_URL_NOT_ORIGIN:${name}`);
  return url;
}
function parseLoopbackDb(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('J7_PROBE_DB_INVALID');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') fail('J7_PROBE_DB_INVALID');
  if (!isLoopbackHost(url.hostname)) fail('J7_PROBE_DB_NOT_LOOPBACK');
  if (url.search || url.hash) fail('J7_PROBE_DB_QUERY');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/^e2e(_j7_[0-9a-f]{12})?$/.test(database)) fail(`J7_PROBE_DB_NAME:${database}`);
  return { url: raw, database };
}

/** 极简 cookie jar：只保留 name=value，不落盘、不进报告。 */
class Jar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(response) {
    const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  has(name) {
    return this.cookies.has(name);
  }
  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  names() {
    return [...this.cookies.keys()].sort();
  }
}

function totp(secretBase32, at = Date.now()) {
  try {
    return digestLib.totp(secretBase32, at);
  } catch {
    fail('J7_PROBE_TOTP_SECRET');
  }
}

async function request(appUrl, jar, spec) {
  const url = new URL(spec.path, appUrl);
  const headers = { origin: appUrl.origin, accept: 'application/json', ...(spec.headers ?? {}) };
  if (jar.cookies.size > 0) headers.cookie = jar.header();
  let body;
  if (spec.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(spec.json);
  } else if (spec.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(spec.form).toString();
  }
  let response;
  try {
    response = await fetch(url, {
      method: spec.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(Number(process.env.J7_PROBE_TIMEOUT_MS ?? '15000')),
    });
  } catch (error) {
    fail(`J7_PROBE_FETCH:${spec.id}:${error && error.name === 'TimeoutError' ? 'timeout' : 'error'}`);
  }
  jar.absorb(response);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (spec.expectStatus !== undefined && response.status !== spec.expectStatus) {
    fail(`J7_PROBE_STATUS:${spec.id}:${spec.expectStatus}:${response.status}`);
  }
  if (spec.expectError !== undefined) {
    const got = parsed && typeof parsed.error === 'string' ? parsed.error : null;
    if (got !== spec.expectError) fail(`J7_PROBE_ERROR:${spec.id}:${spec.expectError}:${got ?? 'null'}`);
  }
  return { id: spec.id, method: spec.method, path: spec.path, status: response.status, error: parsed && typeof parsed.error === 'string' ? parsed.error : null, body: parsed, location: response.headers.get('location') };
}

function adminRow(application) {
  return { id: application.id, method: application.method, path: application.path, status: application.status, error: application.error };
}

function counterMap(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.localDate}|${row.timezoneRevision}|${row.routeId}`, {
      routeId: row.routeId,
      requestCount: Number(row.requestCount),
      errorCount: Number(row.errorCount),
    });
  }
  return map;
}
function routeTotals(map) {
  const totals = new Map();
  for (const value of map.values()) {
    const current = totals.get(value.routeId) ?? { requestCount: 0, errorCount: 0 };
    current.requestCount += value.requestCount;
    current.errorCount += value.errorCount;
    totals.set(value.routeId, current);
  }
  return totals;
}
function jobMap(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.key, {
      generation: Number(row.generation),
      lastStatus: row.lastStatus,
      lastErrorCode: row.lastErrorCode ?? null,
      leaseOwner: row.leaseOwner ?? null,
      lockedUntil: row.lockedUntil ? new Date(row.lockedUntil).toISOString() : null,
      lastStartedAt: row.lastStartedAt ? new Date(row.lastStartedAt).toISOString() : null,
      lastSucceededAt: row.lastSucceededAt ? new Date(row.lastSucceededAt).toISOString() : null,
      lastFinishedAt: row.lastFinishedAt ? new Date(row.lastFinishedAt).toISOString() : null,
      summary: row.summary ?? null,
    });
  }
  return map;
}

/**
 * 站点本地日：独立用 `Intl` 实现，不 import 产品代码，避免"用被测逻辑证明被测逻辑"。
 * 时区字符串先做一次格式化校验，非法时区在写 fixture 之前就拒绝。
 */
function siteLocalDateSafe(date, timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
  } catch {
    fail(`J7_PROBE_TIMEZONE_INVALID:${String(timeZone).slice(0, 40)}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const pick = (type) => (parts.find((part) => part.type === type) ?? {}).value;
  const value = `${pick('year')}-${pick('month')}-${pick('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('J7_PROBE_LOCAL_DATE');
  return value;
}

/** 距本地午夜多少分钟：用来拒绝在日界附近"择时"造冲突。 */
function minutesFromLocalMidnight(date, timeZone) {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) fail('J7_PROBE_LOCAL_CLOCK');
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * 分析数据的整体指纹：把每张表按 `to_jsonb` 规范化后排序拼接再取 md5，
 * 由探针自己算 SHA-256。只比较「本次失败有没有推进水位/指标」，
 * 不代表任何业务含义，也不进收件正文以外的计算。
 */
async function analyticsFingerprint(prisma) {
  const tables = ['AnalyticsEvent', 'AnalyticsRollupDay', 'AnalyticsDailyRollup', 'AnalyticsDaily', 'AnalyticsAggregateDayState', 'AnalyticsDayChange', 'SiteSetting'];
  const parts = [];
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) AS digest FROM "${table}" t`,
    );
    parts.push(`${table}:${String(rows[0]?.digest ?? '')}`);
  }
  return parts.join('|');
}
function sameJobs(before, after) {
  if (before.size !== after.size) return false;
  for (const [key, value] of before) {
    if (JSON.stringify(value) !== JSON.stringify(after.get(key))) return false;
  }
  return true;
}

function consentVersionFromSource(repo) {
  const file = path.join(repo, 'src', 'lib', 'consent.ts');
  try {
    const match = /CONSENT_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(file, 'utf8'));
    if (match) return Number(match[1]);
  } catch {
    /* fall through */
  }
  return null;
}

function seedUser({ repo, role, totpSecret, label }) {
  const email = `j7-${label}-${crypto.randomBytes(6).toString('hex')}@example.test`;
  const password = crypto.randomBytes(24).toString('base64url');
  const result = spawnSync(process.execPath, [path.join('scripts', 'create-admin.mjs')], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ADMIN_SEED_EMAIL: email,
      ADMIN_SEED_PASSWORD: password,
      ADMIN_SEED_NAME: `J7 ${label}`,
      ADMIN_SEED_ROLE: role,
      ADMIN_SEED_TOTP_SECRET: totpSecret,
    },
  });
  if (result.status !== 0) fail(`J7_PROBE_SEED:${label}`);
  return { email, password };
}

async function login(appUrl, { email, password }, totpSecret) {
  const jar = new Jar();
  const csrf = await request(appUrl, jar, { id: 'csrf', method: 'GET', path: '/api/auth/csrf', expectStatus: 200 });
  const token = csrf.body && typeof csrf.body.csrfToken === 'string' ? csrf.body.csrfToken : null;
  if (!token) fail('J7_PROBE_CSRF');
  const response = await request(appUrl, jar, {
    id: 'login',
    method: 'POST',
    path: '/api/auth/callback/credentials',
    form: { csrfToken: token, email, password, totp: totp(totpSecret) },
    expectStatus: 302,
  });
  const location = response.location ?? '';
  if (location.includes('error=')) fail('J7_PROBE_LOGIN');
  if (!jar.names().some((name) => /^(?:__Secure-)?authjs\.session-token$/.test(name))) fail('J7_PROBE_LOGIN_COOKIE');
  return jar;
}

async function main() {
  const mode = env('J7_MODE');
  if (!['full', 'nodata'].includes(mode)) fail('J7_PROBE_MODE');
  const appUrl = parseLoopbackUrl(env('J7_APP_URL'), 'J7_APP_URL');
  const db = parseLoopbackDb(env('J7_PROBE_DB_URL'));
  const standaloneDir = path.resolve(env('J7_STANDALONE_DIR'));
  const repo = path.resolve(env('J7_REPO'));
  const sourceCommit = env('J7_SOURCE_COMMIT');
  const sourceTree = env('J7_SOURCE_TREE');
  const buildId = env('J7_BUILD_ID');
  const runId = Number(env('J7_RUN_ID'));
  const runAttempt = Number(env('J7_RUN_ATTEMPT'));
  const workflow = env('J7_WORKFLOW');
  const reportPath = path.resolve(env('J7_REPORT'));
  const totpSecret = env('J7_ADMIN_TOTP_SECRET');
  const expectPgMajor = Number(process.env.J7_EXPECT_PG_MAJOR ?? '17');
  const allowWrites = process.env.J7_ALLOW_WRITES === '1';

  if (!/^[0-9a-f]{40}$/i.test(sourceCommit)) fail('J7_PROBE_SOURCE_COMMIT');
  if (!/^[0-9a-f]{40}$/i.test(sourceTree)) fail('J7_PROBE_SOURCE_TREE');
  if (!Number.isInteger(runId) || runId <= 0) fail('J7_PROBE_RUN_ID');
  if (!Number.isInteger(runAttempt) || runAttempt < 1) fail('J7_PROBE_RUN_ATTEMPT');
  if (!['CI', 'Formal supplement (Linux)'].includes(workflow)) fail('J7_PROBE_WORKFLOW');
  if (fs.existsSync(reportPath)) fail('J7_PROBE_REPORT_EXISTS');
  if (mode === 'full' && !allowWrites) fail('J7_PROBE_WRITES_NOT_ALLOWED');
  if (process.env.DATABASE_URL !== db.url) fail('J7_PROBE_DB_URL_MISMATCH');

  const buildIdPath = path.join(standaloneDir, '.next', 'BUILD_ID');
  if (!fs.existsSync(buildIdPath)) fail('J7_PROBE_BUILD_ID_FILE_MISSING');
  const fileBuildId = fs.readFileSync(buildIdPath, 'utf8').trim();
  if (fileBuildId !== buildId) fail('J7_PROBE_BUILD_ID_MISMATCH');
  let tree;
  try {
    tree = await digestLib.treeDigest(standaloneDir);
  } catch (error) {
    fail(`J7_PROBE_TREE:${error && error.message ? error.message.slice(0, 80) : 'error'}`);
  }

  const { PrismaClient } = createRequire(path.join(repo, 'package.json'))('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: db.url } } });
  const startedAt = new Date().toISOString();
  let report;
  try {
    const versionRows = await prisma.$queryRawUnsafe(`SELECT current_setting('server_version_num')::int AS version_num`);
    const pgVersionNum = Number(versionRows[0]?.version_num ?? 0);
    if (!Number.isInteger(pgVersionNum) || Math.floor(pgVersionNum / 10000) !== expectPgMajor) fail(`J7_PROBE_PG_MAJOR:${pgVersionNum}`);
    const clusterRows = await prisma.$queryRawUnsafe(`SELECT system_identifier::text AS system_identifier FROM pg_control_system()`);
    const systemIdentifier = clusterRows[0]?.system_identifier;
    if (typeof systemIdentifier !== 'string' || !/^\d{1,32}$/.test(systemIdentifier)) fail('J7_PROBE_CLUSTER_ID');
    const clusterSha256 = digestLib.clusterDigest(systemIdentifier);
    const pg = { versionNum: pgVersionNum, database: db.database, clusterSha256 };

    const health = await request(appUrl, new Jar(), { id: 'health', method: 'GET', path: '/api/health', expectStatus: 200 });

    if (mode === 'nodata') {
      const admin = seedUser({ repo, role: 'ADMIN', totpSecret, label: 'nodata' });
      const jar = await login(appUrl, admin, totpSecret);
      const settings = await request(appUrl, jar, { id: 'settings', method: 'GET', path: '/api/admin/settings/analytics', expectStatus: 200 });
      const models = await request(appUrl, new Jar(), { id: 'models', method: 'GET', path: '/api/models', expectStatus: 200 });
      const items = Array.isArray(models.body?.items) ? models.body.items : null;
      if (!items) fail('J7_PROBE_NODATA_MODELS_SHAPE');
      const modelRows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "Model3D"`);
      const modelCount = Number(modelRows[0]?.count ?? -1);
      if (modelCount !== 0) fail(`J7_PROBE_NODATA_DB_NOT_EMPTY:${modelCount}`);
      if (items.length !== 0) fail(`J7_PROBE_NODATA_MODELS_NOT_EMPTY:${items.length}`);
      if (settings.body?.version !== 0 || settings.body?.timezone !== 'UTC') fail('J7_PROBE_NODATA_SETTINGS');
      report = {
        schema: 'j7-nodata/1',
        pass: true,
        mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        source: { commit: sourceCommit.toLowerCase(), tree: sourceTree.toLowerCase() },
        build: { buildId, standaloneTreeSha256: tree.sha256.toUpperCase(), files: tree.files },
        run: { workflow, id: runId, attempt: runAttempt },
        app: { origin: appUrl.origin, health: health.status },
        pg,
        noData: {
          models: { status: models.status, items: items.length, database: db.database, modelRows: modelCount },
          settings: { status: settings.status, version: settings.body.version, timezone: settings.body.timezone, timezoneRevision: settings.body.timezoneRevision },
        },
      };
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      const temporary = `${reportPath}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, reportPath);
      process.stdout.write('J7_PROBE_OK\n');
      return;
    }

    const cronSecret = env('J7_CRON_SECRET');
    const consentVersion = Number(process.env.J7_CONSENT_VERSION ?? consentVersionFromSource(repo) ?? '0');
    if (!Number.isInteger(consentVersion) || consentVersion < 1) fail('J7_PROBE_CONSENT_VERSION');

    const cookieName = { session: 'authjs.session-token', consent: 'pj_analytics', chat: 'pj_chat' };
    const http = [];
    const countersBefore = routeTotals(counterMap(await prisma.$queryRawUnsafe(`SELECT "localDate","timezoneRevision","routeId","requestCount","errorCount" FROM "ApiDailyCounter"`)));
    const jobsBeforeDenials = jobMap(await prisma.$queryRawUnsafe(`SELECT key,"leaseOwner",generation,"lockedUntil","lastStartedAt","lastSucceededAt","lastFinishedAt","lastStatus","lastErrorCode","summary" FROM "JobState"`));
    const analyticsEventsBefore = Number((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "AnalyticsEvent"`))[0]?.count ?? -1);

    // A. 计数边界：guard 级拒绝不计数，包装过的拒绝计数。
    const anonymous = new Jar();
    http.push(adminRow(await request(appUrl, anonymous, { id: 'settings-anon', method: 'GET', path: '/api/admin/settings/analytics', expectStatus: 401, expectError: 'unauthorized' })));
    http.push(adminRow(await request(appUrl, anonymous, { id: 'account-anon', method: 'GET', path: '/api/admin/account', expectStatus: 401, expectError: 'unauthorized' })));
    http.push(adminRow(await request(appUrl, anonymous, { id: 'operations-anon', method: 'POST', path: '/api/admin/cron/operations', json: { jobKey: 'analytics-aggregate' }, expectStatus: 401, expectError: 'unauthorized' })));
    const pseudo = new Jar();
    pseudo.cookies.set('authjs.session-token', 'j7-probe-not-a-real-session');
    http.push(adminRow(await request(appUrl, pseudo, { id: 'activity-pseudo', method: 'POST', path: '/api/admin/account/session/activity', json: {}, expectStatus: 401, expectError: 'unauthorized' })));
    const jobsAfterDenials = jobMap(await prisma.$queryRawUnsafe(`SELECT key,"leaseOwner",generation,"lockedUntil","lastStartedAt","lastSucceededAt","lastFinishedAt","lastStatus","lastErrorCode","summary" FROM "JobState"`));
    if (!sameJobs(jobsBeforeDenials, jobsAfterDenials)) fail('J7_PROBE_JOBSTATE_CHANGED');

    // B. 真实鉴权生产者：管理员 200 且无同意 cookie；EDITOR 在 ADMIN-only 入口 403。
    const adminSeed = seedUser({ repo, role: 'ADMIN', totpSecret, label: 'admin' });
    const adminJar = await login(appUrl, adminSeed, totpSecret);
    if (adminJar.has(cookieName.consent)) fail('J7_PROBE_CONSENT_LEAK');
    const account = await request(appUrl, adminJar, { id: 'account-admin', method: 'GET', path: '/api/admin/account', expectStatus: 200 });
    if (account.body?.role !== 'ADMIN' || account.body?.totpEnabled !== true) fail('J7_PROBE_ADMIN_IDENTITY');
    if (account.body?.currentDevice?.current !== true || account.body?.currentDevice?.revokedAt) fail('J7_PROBE_ADMIN_DEVICE');
    const authWithoutConsent = { adminStatus: account.status, sessionCookiePresent: true, consentCookiePresent: adminJar.has(cookieName.consent), userDigest: digestLib.sha256Text(String(account.body?.id ?? '')).slice(0, 32) };
    http.push(adminRow(account));
    const settingsAdmin = await request(appUrl, adminJar, { id: 'settings-admin', method: 'GET', path: '/api/admin/settings/analytics', expectStatus: 200 });
    http.push(adminRow(settingsAdmin));
    const editorSeed = seedUser({ repo, role: 'EDITOR', totpSecret, label: 'editor' });
    const editorJar = await login(appUrl, editorSeed, totpSecret);
    const settingsEditor = await request(appUrl, editorJar, { id: 'settings-editor', method: 'GET', path: '/api/admin/settings/analytics', expectStatus: 403, expectError: 'forbidden' });
    http.push(adminRow(settingsEditor));

    // C. 同意分离：同意 cookie 由真实同意入口签发；仅有同意仍无会话；撤回后零事件。
    const consentJar = new Jar();
    const accepted = await request(appUrl, consentJar, { id: 'consent-accept', method: 'POST', path: '/api/analytics/consent', json: { analytics: true, consentVersion }, expectStatus: 200 });
    if (accepted.body?.analytics !== true) fail('J7_PROBE_CONSENT_ACCEPT');
    if (!consentJar.has(cookieName.consent)) fail('J7_PROBE_CONSENT_COOKIE');
    http.push(adminRow(accepted));
    const consentOnlyAccount = await request(appUrl, consentJar, { id: 'account-consent-only', method: 'GET', path: '/api/admin/account', expectStatus: 401, expectError: 'unauthorized' });
    http.push(adminRow(consentOnlyAccount));
    const consentWithoutSession = { sessionStatus: consentOnlyAccount.status, sessionCookiePresent: consentJar.names().some((name) => /^(?:__Secure-)?authjs\.session-token$/.test(name)), consentCookiePresent: consentJar.has(cookieName.consent), error: consentOnlyAccount.error };
    const revoked = await request(appUrl, consentJar, { id: 'consent-withdraw', method: 'POST', path: '/api/analytics/consent', json: { analytics: false, consentVersion }, expectStatus: 200 });
    if (revoked.body?.analytics !== false) fail('J7_PROBE_CONSENT_WITHDRAW');
    http.push(adminRow(revoked));
    const rejectedEventId = crypto.randomUUID();
    const rejected = await request(appUrl, consentJar, {
      id: 'events-withdrawn',
      method: 'POST',
      path: '/api/analytics/events',
      json: { events: [{ eventId: rejectedEventId, occurredAt: new Date().toISOString(), locale: 'en', navigationId: crypto.randomUUID(), kind: 'page_view', path: '/en' }] },
      expectStatus: 403,
      expectError: 'analytics_consent_required',
    });
    http.push(adminRow(rejected));
    const eventsSessionOnly = await request(appUrl, adminJar, {
      id: 'events-session-only',
      method: 'POST',
      path: '/api/analytics/events',
      json: { events: [{ eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), locale: 'en', navigationId: crypto.randomUUID(), kind: 'page_view', path: '/en' }] },
      expectStatus: 403,
      expectError: 'analytics_consent_required',
    });
    http.push(adminRow(eventsSessionOnly));
    const reaccepted = await request(appUrl, consentJar, { id: 'consent-reaccept', method: 'POST', path: '/api/analytics/consent', json: { analytics: true, consentVersion }, expectStatus: 200 });
    http.push(adminRow(reaccepted));
    const acceptedEventId = crypto.randomUUID();
    const eventsAccepted = await request(appUrl, consentJar, {
      id: 'events-accepted',
      method: 'POST',
      path: '/api/analytics/events',
      json: { events: [{ eventId: acceptedEventId, occurredAt: new Date().toISOString(), locale: 'en', navigationId: crypto.randomUUID(), kind: 'page_view', path: '/en' }] },
      expectStatus: 200,
    });
    if (!Array.isArray(eventsAccepted.body?.acceptedIds) || !eventsAccepted.body.acceptedIds.includes(acceptedEventId)) fail('J7_PROBE_EVENT_ACCEPT');
    http.push(adminRow(eventsAccepted));

    // D. 聊天：真实会话 cookie + 首写 + 读 + 推进读位置。
    const chatJar = new Jar();
    const chatSession = await request(appUrl, chatJar, { id: 'chat-session', method: 'POST', path: '/api/chat/session', json: { locale: 'en' }, expectStatus: 200 });
    if (chatSession.body?.available !== true || !chatJar.has(cookieName.chat)) fail('J7_PROBE_CHAT_SESSION');
    http.push(adminRow(chatSession));
    const createConversation = await request(appUrl, chatJar, {
      id: 'chat-create',
      method: 'POST',
      path: '/api/chat/conversations',
      json: { clientConversationId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), locale: 'en', bodyText: 'J7 same-build probe message.', sourcePath: '/en' },
      expectStatus: 200,
    });
    const conversationId = createConversation.body?.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length < 1) fail('J7_PROBE_CHAT_CREATE');
    http.push(adminRow(createConversation));
    const readConversation = await request(appUrl, chatJar, { id: 'chat-read', method: 'GET', path: `/api/chat/conversations/${conversationId}`, expectStatus: 200 });
    http.push(adminRow(readConversation));
    const advanceRead = await request(appUrl, chatJar, { id: 'chat-read-advance', method: 'POST', path: `/api/chat/conversations/${conversationId}/read`, json: { lastReadSeq: 1 }, expectStatus: 200 });
    if (advanceRead.body?.lastReadSeq !== 1) fail('J7_PROBE_CHAT_READ');
    http.push(adminRow(advanceRead));

    // E. 模型：列表 200 与真实 GLB 200。
    const models = await request(appUrl, new Jar(), { id: 'models-list', method: 'GET', path: '/api/models', expectStatus: 200 });
    const items = Array.isArray(models.body?.items) ? models.body.items : null;
    if (!items || items.length < 1) fail('J7_PROBE_MODELS_EMPTY');
    const glbUrl = items.map((item) => item && item.glbUrl).find((value) => typeof value === 'string' && /^\/api\/models\/[a-z0-9]{20,40}\/glb(?:\?|$)/.test(value));
    if (!glbUrl) fail('J7_PROBE_MODELS_GLB_URL');
    const glb = await request(appUrl, new Jar(), { id: 'models-glb', method: 'GET', path: glbUrl, expectStatus: 200 });
    http.push(adminRow(models), adminRow(glb));

    // F. 作业：真实执行两个已注册作业。保留清理先经共享租约把 analytics-aggregate +1
    //    （只领那一行的租约、不改状态），暖态聚合再 +1 SUCCEEDED，冲突失败再 +1。
    const jobsBeforeRuns = jobMap(await prisma.$queryRawUnsafe(`SELECT key,"leaseOwner",generation,"lockedUntil","lastStartedAt","lastSucceededAt","lastFinishedAt","lastStatus","lastErrorCode","summary" FROM "JobState"`));
    const operationsUnknown = await request(appUrl, anonymous, { id: 'operations-invalid', method: 'POST', path: '/api/admin/cron/operations', headers: { authorization: `Bearer ${cronSecret}` }, json: { jobKey: 'j7-not-a-job' }, expectStatus: 400, expectError: 'invalid' });
    http.push(adminRow(operationsUnknown));
    const runRetention = await request(appUrl, new Jar(), { id: 'operations-retention', method: 'POST', path: '/api/admin/cron/operations', headers: { authorization: `Bearer ${cronSecret}` }, json: { jobKey: 'analytics-retention', dryRun: true }, expectStatus: 200 });
    http.push(adminRow(runRetention));
    const runKeys = new Set(['analytics-retention', 'analytics-aggregate']);
    for (const key of runKeys) if (!jobsBeforeRuns.has(key)) fail(`J7_PROBE_JOB_MISSING:${key}`);
    const retentionBefore = jobsBeforeRuns.get('analytics-retention');
    const sharedBefore = jobsBeforeRuns.get('analytics-aggregate');

    // F1. 中间快照：保留清理已释放共享租约、暖态聚合尚未开始；聚合的代次锚就是这个中间行。
    const jobsAfterRetention = jobMap(await prisma.$queryRawUnsafe(`SELECT key,"leaseOwner",generation,"lockedUntil","lastStartedAt","lastSucceededAt","lastFinishedAt","lastStatus","lastErrorCode","summary" FROM "JobState"`));
    const retentionMid = jobsAfterRetention.get('analytics-retention');
    if (!retentionMid || retentionMid.generation !== retentionBefore.generation + 1 || retentionMid.lastStatus !== 'SUCCEEDED') {
      fail(`J7_PROBE_JOB_STATUS:analytics-retention:${String(retentionMid && retentionMid.lastStatus)}`);
    }
    const sharedMid = jobsAfterRetention.get('analytics-aggregate');
    if (!sharedMid || sharedMid.generation !== sharedBefore.generation + 1) {
      fail(`J7_PROBE_SHARED_LEASE_GENERATION:${String(sharedBefore.generation)}:${String(sharedMid && sharedMid.generation)}`);
    }
    if (sharedMid.leaseOwner !== null || sharedMid.lockedUntil !== null) fail('J7_PROBE_SHARED_LEASE_HELD');
    // 共享租约只许改代次与租约：状态、错误码、起止/成功时刻、摘要必须与领取前逐字段相同。
    if (sharedMid.lastStatus !== sharedBefore.lastStatus || sharedMid.lastErrorCode !== sharedBefore.lastErrorCode ||
      sharedMid.lastStartedAt !== sharedBefore.lastStartedAt || sharedMid.lastSucceededAt !== sharedBefore.lastSucceededAt ||
      sharedMid.lastFinishedAt !== sharedBefore.lastFinishedAt ||
      JSON.stringify(sharedMid.summary) !== JSON.stringify(sharedBefore.summary)) {
      fail(`J7_PROBE_SHARED_LEASE_MUTATED:${String(sharedMid.lastStatus)}`);
    }

    const runAggregate = await request(appUrl, new Jar(), { id: 'operations-aggregate', method: 'POST', path: '/api/admin/cron/operations', headers: { authorization: `Bearer ${cronSecret}` }, json: { jobKey: 'analytics-aggregate' }, expectStatus: 200 });
    http.push(adminRow(runAggregate));
    const jobsAfterRuns = jobMap(await prisma.$queryRawUnsafe(`SELECT key,"leaseOwner",generation,"lockedUntil","lastStartedAt","lastSucceededAt","lastFinishedAt","lastStatus","lastErrorCode","summary" FROM "JobState"`));
    const retentionAfter = jobsAfterRuns.get('analytics-retention');
    if (!retentionAfter || JSON.stringify(retentionAfter) !== JSON.stringify(retentionMid)) fail('J7_PROBE_RETENTION_TOUCHED');
    const warmAggregate = jobsAfterRuns.get('analytics-aggregate');
    if (!warmAggregate || warmAggregate.generation !== sharedMid.generation + 1 ||
      warmAggregate.lastStatus !== 'SUCCEEDED' || !warmAggregate.lastSucceededAt) {
      fail(`J7_PROBE_JOB_STATUS:analytics-aggregate:${String(warmAggregate && warmAggregate.lastStatus)}`);
    }

    // G. 主实例持久化失败归属：同一 build / 同一实例 / 同一 PG 上，用真实 settings revision
    //    造一条"旧代次边界行"，让真实 analytics-aggregate 自己走到 FAILED/version_conflict。
    //    只写这条边界行，不写 JobState、不写代次、不写失败结果；cleanup 归本次。
    const settingsRows = await prisma.$queryRawUnsafe(`SELECT "value" FROM "SiteSetting" WHERE "key" = 'analytics.settings'`);
    const settingsValue = settingsRows[0] && typeof settingsRows[0].value === 'object' && settingsRows[0].value !== null ? settingsRows[0].value : null;
    const revisionActual = Number(settingsValue && settingsValue.timezoneRevision);
    const siteTimezone = settingsValue && typeof settingsValue.timezone === 'string' ? settingsValue.timezone : null;
    if (!Number.isInteger(revisionActual) || revisionActual < 0) fail('J7_PROBE_REVISION_READ');
    if (!siteTimezone) fail('J7_PROBE_TIMEZONE_READ');
    const warmRevision = Number(warmAggregate.summary && warmAggregate.summary.versions && warmAggregate.summary.versions.timezoneRevision);
    if (warmRevision !== revisionActual) fail(`J7_PROBE_REVISION_DRIFT:${warmRevision}:${revisionActual}`);
    const warmSourceThrough = warmAggregate.summary && warmAggregate.summary.times ? warmAggregate.summary.times.sourceThrough ?? null : null;

    const [{ now: pgNow }] = await prisma.$queryRawUnsafe(`SELECT clock_timestamp() AS now`);
    if (!(pgNow instanceof Date) || !Number.isFinite(pgNow.getTime())) fail('J7_PROBE_PG_CLOCK');
    const conflictDate = siteLocalDateSafe(pgNow, siteTimezone);
    const localMinutes = minutesFromLocalMidnight(pgNow, siteTimezone);
    if (localMinutes < 5 || localMinutes > 24 * 60 - 5) fail(`J7_PROBE_DAY_BOUNDARY:${localMinutes}`);
    // 两次独立读数必须落在同一站点日：按 UTC 日期或临时挑时区都会在这里被拒。
    if (siteLocalDateSafe(new Date(), siteTimezone) !== conflictDate) fail('J7_PROBE_DAY_DRIFT');
    const watermarkDate = warmSourceThrough ? siteLocalDateSafe(new Date(warmSourceThrough), siteTimezone) : null;
    if (watermarkDate !== null && conflictDate < watermarkDate) fail(`J7_PROBE_DAY_BEHIND:${conflictDate}:${watermarkDate}`);

    const fingerprintBaseline = await analyticsFingerprint(prisma);
    const previousRows = await prisma.$queryRawUnsafe(
      `SELECT "siteDate","timezoneRevision","completedAt","eventCount","sourceMaxReceivedAt" FROM "AnalyticsRollupDay" WHERE "siteDate" = $1`, conflictDate,
    );
    const previousRow = previousRows[0] ?? null;
    const previousRevision = previousRow ? Number(previousRow.timezoneRevision) : null;
    if (previousRevision !== null && previousRevision > revisionActual) fail(`J7_PROBE_FIXTURE_PREEXISTING:${previousRevision}`);
    const fixture = {
      kind: 'stale-timezone-revision-boundary-row',
      table: 'AnalyticsRollupDay',
      siteDate: conflictDate,
      timezone: siteTimezone,
      timezoneRevisionActual: revisionActual,
      timezoneRevisionWritten: revisionActual + 1,
      pgNow: pgNow.toISOString(),
      minutesFromLocalMidnight: localMinutes,
      existedBefore: previousRow !== null,
      previous: previousRow === null ? null : {
        timezoneRevision: previousRevision,
        eventCount: Number(previousRow.eventCount),
        completedAt: previousRow.completedAt ? new Date(previousRow.completedAt).toISOString() : null,
        sourceMaxReceivedAt: previousRow.sourceMaxReceivedAt ? new Date(previousRow.sourceMaxReceivedAt).toISOString() : null,
      },
    };
    if (previousRow !== null) {
      const bumped = await prisma.$executeRawUnsafe(`UPDATE "AnalyticsRollupDay" SET "timezoneRevision" = $2 WHERE "siteDate" = $1`, conflictDate, revisionActual + 1);
      if (bumped !== 1) fail(`J7_PROBE_FIXTURE_WRITE:${bumped}`);
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AnalyticsRollupDay" ("siteDate","timezoneRevision","completedAt","eventCount") VALUES ($1,$2,$3,0)`,
        conflictDate, revisionActual + 1, pgNow,
      );
    }
    const storedFixture = await prisma.$queryRawUnsafe(`SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = $1`, conflictDate);
    if (Number(storedFixture[0] && storedFixture[0].timezoneRevision) !== revisionActual + 1) fail('J7_PROBE_FIXTURE_NOT_STORED');
    const fingerprintAfterFixture = await analyticsFingerprint(prisma);
    if (fingerprintAfterFixture === fingerprintBaseline) fail('J7_PROBE_FIXTURE_INVISIBLE');

    const failureStartedMs = Date.now();
    const failedRun = await request(appUrl, new Jar(), {
      id: 'operations-aggregate-conflict', method: 'POST', path: '/api/admin/cron/operations',
      headers: { authorization: `Bearer ${cronSecret}` }, json: { jobKey: 'analytics-aggregate' }, expectStatus: 200,
    });
    const failureEndedMs = Date.now();
    http.push(adminRow(failedRun));
    if (failedRun.body && failedRun.body.status !== 'FAILED') fail(`J7_PROBE_FAILED_STATUS:${String(failedRun.body.status)}`);
    if (!failedRun.body || !failedRun.body.counts || failedRun.body.counts.candidateCount !== 0) fail('J7_PROBE_FAILED_COUNTS');
    if (failedRun.body.jobKey !== 'analytics-aggregate') fail('J7_PROBE_FAILED_JOBKEY');
    const jobsAfterFailure = jobMap(await prisma.$queryRawUnsafe(`SELECT key,"leaseOwner",generation,"lockedUntil","lastStartedAt","lastSucceededAt","lastFinishedAt","lastStatus","lastErrorCode","summary" FROM "JobState"`));
    const failedAggregate = jobsAfterFailure.get('analytics-aggregate');
    if (!failedAggregate) fail('J7_PROBE_FAILED_VANISHED');
    if (failedAggregate.generation !== warmAggregate.generation + 1) fail(`J7_PROBE_FAILED_GENERATION:${warmAggregate.generation}:${failedAggregate.generation}`);
    if (failedAggregate.lastStatus !== 'FAILED') fail(`J7_PROBE_FAILED_STATE:${String(failedAggregate.lastStatus)}`);
    if (failedAggregate.lastErrorCode !== 'version_conflict') fail(`J7_PROBE_FAILED_CODE:${String(failedAggregate.lastErrorCode)}`);
    if (failedAggregate.leaseOwner !== null || failedAggregate.lockedUntil !== null) fail('J7_PROBE_FAILED_LEASE');
    if (failedAggregate.lastSucceededAt !== warmAggregate.lastSucceededAt) fail(`J7_PROBE_FAILED_SUCCESS_CLOCK:${String(failedAggregate.lastSucceededAt)}:${String(warmAggregate.lastSucceededAt)}`);
    const finishedMs = Date.parse(failedAggregate.lastFinishedAt ?? '');
    if (!Number.isFinite(finishedMs) || finishedMs < failureStartedMs || finishedMs > failureEndedMs) fail(`J7_PROBE_FAILED_FINISH_CLOCK:${String(failedAggregate.lastFinishedAt)}`);
    const failedCounts = failedAggregate.summary && failedAggregate.summary.counts ? failedAggregate.summary.counts : null;
    if (!failedCounts || failedCounts.candidateCount !== 0) fail('J7_PROBE_FAILED_SUMMARY');
    const failedRevision = Number(failedAggregate.summary && failedAggregate.summary.versions && failedAggregate.summary.versions.timezoneRevision);
    if (failedRevision !== revisionActual) fail(`J7_PROBE_FAILED_REVISION:${failedRevision}:${revisionActual}`);

    // 其余每个 key：状态/代次/成功时刻逐一相等（两次运行都不许碰到它们）。
    // 保留清理是自己那次 SUCCEEDED 跑出来的，只要求"失败那次没再碰它"。
    const retentionAfterFailure = jobsAfterFailure.get('analytics-retention');
    if (!retentionAfterFailure || JSON.stringify(retentionAfterFailure) !== JSON.stringify(retentionAfter)) fail('J7_PROBE_FAILED_TOUCHED_RETENTION');
    const otherKeys = [];
    for (const [key, before] of jobsBeforeRuns) {
      if (key === 'analytics-aggregate' || key === 'analytics-retention') continue;
      const after = jobsAfterFailure.get(key);
      if (!after) fail(`J7_PROBE_JOB_VANISHED:${key}`);
      if (before.generation !== after.generation) fail(`J7_PROBE_JOB_GENERATION:${key}`);
      if (before.lastStatus !== after.lastStatus || before.lastErrorCode !== after.lastErrorCode) fail(`J7_PROBE_JOB_STATUS:${key}`);
      if (before.lastSucceededAt !== after.lastSucceededAt) fail(`J7_PROBE_JOB_SUCCESS_CLOCK:${key}`);
      if (before.leaseOwner !== after.leaseOwner || before.lockedUntil !== after.lockedUntil) fail(`J7_PROBE_JOB_LEASE:${key}`);
      otherKeys.push({
        key,
        generationBefore: before.generation,
        generationAfter: after.generation,
        statusBefore: before.lastStatus,
        statusAfter: after.lastStatus,
        lastSucceededAtBefore: before.lastSucceededAt,
        lastSucceededAtAfter: after.lastSucceededAt,
      });
    }
    if (otherKeys.length === 0) fail('J7_PROBE_OTHER_KEYS_EMPTY');

    const fingerprintAfterFailure = await analyticsFingerprint(prisma);
    if (fingerprintAfterFailure !== fingerprintAfterFixture) fail('J7_PROBE_FAILED_CHANGED_ANALYTICS');

    // cleanup：把边界行恢复原样，并核对整库指纹回到造 fixture 之前。
    if (previousRow !== null) {
      const restored = await prisma.$executeRawUnsafe(`UPDATE "AnalyticsRollupDay" SET "timezoneRevision" = $2 WHERE "siteDate" = $1`, conflictDate, previousRevision);
      if (restored !== 1) fail(`J7_PROBE_FIXTURE_RESTORE:${restored}`);
    } else {
      const removed = await prisma.$executeRawUnsafe(`DELETE FROM "AnalyticsRollupDay" WHERE "siteDate" = $1`, conflictDate);
      if (removed !== 1) fail(`J7_PROBE_FIXTURE_RESTORE:${removed}`);
    }
    const restoredRows = await prisma.$queryRawUnsafe(`SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = $1`, conflictDate);
    const restoredOk = previousRow !== null ? Number(restoredRows[0] && restoredRows[0].timezoneRevision) === previousRevision : restoredRows.length === 0;
    if (!restoredOk) fail('J7_PROBE_FIXTURE_RESTORE');
    const fingerprintAfterRestore = await analyticsFingerprint(prisma);
    if (fingerprintAfterRestore !== fingerprintBaseline) fail('J7_PROBE_FIXTURE_RESTORE_FINGERPRINT');
    const sha = (value) => digestLib.sha256Text(String(value)).toUpperCase();

    const failureAttribution = {
      mode: 'main-instance',
      jobKey: 'analytics-aggregate',
      errorCode: 'version_conflict',
      failedStatus: 'FAILED',
      httpStatus: failedRun.status,
      responseCounts: { candidateCount: failedRun.body.counts.candidateCount },
      appOrigin: appUrl.origin,
      buildId,
      source: { commit: sourceCommit.toLowerCase(), tree: sourceTree.toLowerCase() },
      pg: { versionNum: pgVersionNum, database: db.database, clusterSha256 },
      warm: {
        generation: warmAggregate.generation,
        lastSucceededAt: warmAggregate.lastSucceededAt,
        sourceThrough: warmSourceThrough,
        timezoneRevision: warmRevision,
        candidateCount: warmAggregate.summary && warmAggregate.summary.counts ? warmAggregate.summary.counts.candidateCount : null,
      },
      failed: {
        generation: failedAggregate.generation,
        lastStatus: failedAggregate.lastStatus,
        lastErrorCode: failedAggregate.lastErrorCode,
        lastSucceededAt: failedAggregate.lastSucceededAt,
        lastFinishedAt: failedAggregate.lastFinishedAt,
        candidateCount: failedCounts.candidateCount,
        timezoneRevision: failedRevision,
        leaseReleased: failedAggregate.leaseOwner === null && failedAggregate.lockedUntil === null,
      },
      otherKeys,
      watermark: { sourceThroughBefore: warmSourceThrough, sourceThroughAfter: warmSourceThrough, unchanged: true },
      metrics: {
        fingerprintAlgorithm: 'sha256(md5-table-agg)',
        before: sha(fingerprintBaseline),
        afterFixture: sha(fingerprintAfterFixture),
        afterFailure: sha(fingerprintAfterFailure),
        afterRestore: sha(fingerprintAfterRestore),
        unchangedByFailure: true,
        restoredToBaseline: true,
      },
      fixture: { ...fixture, restored: true },
      window: { startedAt: new Date(failureStartedMs).toISOString(), endedAt: new Date(failureEndedMs).toISOString() },
    };

    const jobRows = [];
    for (const [key, before] of jobsBeforeRuns) {
      const after = jobsAfterFailure.get(key);
      if (!after) fail(`J7_PROBE_JOB_VANISHED:${key}`);
      if (key === 'analytics-aggregate') {
        // 锚是领取共享租约之后的中间代次：暖态 +1、失败 +2 仍逐级严格。
        if (after.generation !== sharedMid.generation + 2) fail(`J7_PROBE_JOB_GENERATION:${key}`);
        if (after.lastStatus !== 'FAILED' || after.lastErrorCode !== 'version_conflict') fail(`J7_PROBE_JOB_STATUS:${key}`);
        jobRows.push({
          key, touched: true, generationBefore: sharedMid.generation, generationAfter: after.generation,
          statusAfter: after.lastStatus, errorCode: after.lastErrorCode,
          sharedLease: {
            claimant: 'analytics-retention',
            generationBeforeClaim: sharedBefore.generation,
            generationAfterClaim: sharedMid.generation,
            statusPreserved: sharedMid.lastStatus === sharedBefore.lastStatus && sharedMid.lastErrorCode === sharedBefore.lastErrorCode,
            successClockPreserved: sharedMid.lastSucceededAt === sharedBefore.lastSucceededAt,
            summaryPreserved: JSON.stringify(sharedMid.summary) === JSON.stringify(sharedBefore.summary),
            leaseReleased: sharedMid.leaseOwner === null && sharedMid.lockedUntil === null,
          },
          runs: [
            { status: 'SUCCEEDED', generation: warmAggregate.generation, finishedAt: warmAggregate.lastFinishedAt },
            { status: 'FAILED', generation: failedAggregate.generation, finishedAt: failedAggregate.lastFinishedAt },
          ],
        });
      } else if (key === 'analytics-retention') {
        if (after.generation !== before.generation + 1) fail(`J7_PROBE_JOB_GENERATION:${key}`);
        if (after.lastStatus !== 'SUCCEEDED') fail(`J7_PROBE_JOB_STATUS:${key}:${after.lastStatus}`);
        jobRows.push({ key, touched: true, generationBefore: before.generation, generationAfter: after.generation, statusAfter: after.lastStatus, errorCode: after.lastErrorCode });
      } else {
        if (JSON.stringify(before) !== JSON.stringify(after)) fail(`J7_PROBE_JOB_COLLATERAL:${key}`);
        jobRows.push({ key, touched: false, generationBefore: before.generation, generationAfter: after.generation, statusAfter: after.lastStatus, errorCode: after.lastErrorCode });
      }
    }

    const countersAfter = routeTotals(counterMap(await prisma.$queryRawUnsafe(`SELECT "localDate","timezoneRevision","routeId","requestCount","errorCount" FROM "ApiDailyCounter"`)));
    const analyticsEventsAfter = Number((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "AnalyticsEvent"`))[0]?.count ?? -1);
    const rejectedRows = Number((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "AnalyticsEvent" WHERE "eventId" = $1`, rejectedEventId))[0]?.count ?? -1);
    if (rejectedRows !== 0) fail(`J7_PROBE_REJECTED_EVENT_ROWS:${rejectedRows}`);
    if (analyticsEventsAfter - analyticsEventsBefore !== 1) fail(`J7_PROBE_EVENT_ROW_DELTA:${analyticsEventsAfter - analyticsEventsBefore}`);

    const expected = new Map([
      ['GET /api/admin/account', 3],
      ['GET /api/admin/settings/analytics', 1],
      ['POST /api/admin/account/session/activity', 1],
      ['POST /api/analytics/consent', 3],
      ['POST /api/analytics/events', 3],
      ['POST /api/chat/session', 1],
      ['POST /api/chat/conversations', 1],
      ['GET /api/chat/conversations/[id]', 1],
      ['POST /api/chat/conversations/[id]/read', 1],
    ]);
    const uncounted = new Map([
      ['GET /api/admin/settings/analytics:guard', 0],
      // 固定产品路由没有接 ApiDailyCounter（operations/route.ts 直接调 registry），
      // 五次请求在数据库里的差量必须是 0；次数与状态顺序另由本次探针自己的 HTTP 记录核。
      ['POST /api/admin/cron/operations', 0],
    ]);
    const deltas = [];
    for (const [routeId, count] of expected) {
      const before = countersBefore.get(routeId) ?? { requestCount: 0, errorCount: 0 };
      const after = countersAfter.get(routeId) ?? { requestCount: 0, errorCount: 0 };
      const delta = { requestCount: after.requestCount - before.requestCount, errorCount: after.errorCount - before.errorCount };
      if (delta.requestCount !== count) fail(`J7_PROBE_COUNTER_DELTA:${routeId}:${count}:${delta.requestCount}`);
      if (delta.errorCount !== 0) fail(`J7_PROBE_COUNTER_ERROR:${routeId}:${delta.errorCount}`);
      deltas.push({ routeId, requestCount: delta.requestCount, errorCount: delta.errorCount });
    }
    for (const [routeId, count] of uncounted) {
      if (routeId.endsWith(':guard')) continue;
      const before = countersBefore.get(routeId) ?? { requestCount: 0, errorCount: 0 };
      const after = countersAfter.get(routeId) ?? { requestCount: 0, errorCount: 0 };
      const delta = after.requestCount - before.requestCount;
      if (delta !== count) fail(`J7_PROBE_COUNTER_UNCOUNTED:${routeId}:${count}:${delta}`);
      if (after.errorCount !== before.errorCount) fail(`J7_PROBE_COUNTER_UNCOUNTED_ERROR:${routeId}`);
    }
    const operationsOrder = ['operations-anon', 'operations-invalid', 'operations-retention',
      'operations-aggregate', 'operations-aggregate-conflict'];
    const operationsHttp = http.filter((row) => row && row.method === 'POST' && row.path === '/api/admin/cron/operations');
    const operationsStatuses = operationsHttp.map((row) => row.status).join(',');
    if (operationsHttp.length !== 5 || operationsHttp.map((row) => row.id).join(',') !== operationsOrder.join(',') ||
      operationsStatuses !== '401,400,200,200,200') {
      fail(`J7_PROBE_COUNTER_UNCOUNTED_ORDER:${operationsHttp.length}:${operationsStatuses}`);
    }

    for (const [routeId, after] of countersAfter) {
      if (expected.has(routeId) || uncounted.has(routeId)) continue;
      const before = countersBefore.get(routeId) ?? { requestCount: 0, errorCount: 0 };
      if (after.requestCount !== before.requestCount || after.errorCount !== before.errorCount) fail(`J7_PROBE_COUNTER_OTHER:${routeId}`);
    }

    report = {
      schema: 'j7-probe/3',
      pass: true,
      mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      source: { commit: sourceCommit.toLowerCase(), tree: sourceTree.toLowerCase() },
      build: { buildId, standaloneTreeSha256: tree.sha256.toUpperCase(), files: tree.files },
      run: { workflow, id: runId, attempt: runAttempt },
      app: { origin: appUrl.origin, health: health.status },
      pg,
      http,
      counters: {
        rows: deltas,
        guardDenialsUncounted: [{ routeId: 'GET /api/admin/settings/analytics', guardDenials: 2, countedResponses: 1, delta: (countersAfter.get('GET /api/admin/settings/analytics') ?? { requestCount: 0 }).requestCount - (countersBefore.get('GET /api/admin/settings/analytics') ?? { requestCount: 0 }).requestCount }],
        otherRoutesUnchanged: true,
        errorCountDelta: 0,
        totalRequestDelta: deltas.reduce((sum, row) => sum + row.requestCount, 0),
      },
      separation: {
        authWithoutConsent,
        consentWithoutSession,
        consentRejectedNoEvents: {
          acceptStatus: accepted.status,
          withdrawStatus: revoked.status,
          eventsStatus: rejected.status,
          eventsError: rejected.error,
          eventRowsForMarker: rejectedRows,
          analyticsEventDelta: analyticsEventsAfter - analyticsEventsBefore,
        },
      },
      surfaces: {
        account: { observed: true, http: [['account-anon', 401], ['account-consent-only', 401], ['account-admin', 200], ['settings-editor', 403]].map(([id]) => http.find((row) => row.id === id)).filter(Boolean) },
        chat: { observed: true, http: http.filter((row) => row.id.startsWith('chat-')) },
        analytics: { observed: true, http: http.filter((row) => row.id.startsWith('consent-') || row.id.startsWith('events-')) },
        models: { observed: true, http: http.filter((row) => row.id.startsWith('models-')) },
        jobs: { observed: true, http: http.filter((row) => row.id.startsWith('operations-')) },
      },
      jobs: jobRows,
      failureAttribution,
      cookieNames: cookieName,
      cleanup: {
        appStoppedBy: 'runner',
        listeningAfter: null,
        fixtureRestored: true,
        fixtureTable: 'AnalyticsRollupDay',
        fixtureSiteDate: failureAttribution.fixture.siteDate,
        probeWrites: ['AnalyticsRollupDay'],
      },
    };
  } finally {
    await prisma.$disconnect();
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, reportPath);
  process.stdout.write('J7_PROBE_OK\n');
}

main().catch((error) => {
  const message = error && typeof error.message === 'string' && /^[A-Za-z0-9_:.,-]{1,160}$/.test(error.message) ? error.message : 'error';
  process.stderr.write(`J7_PROBE_FAILED:${message}\n`);
  process.exit(1);
});
