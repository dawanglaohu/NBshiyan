import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const aggregate = 'analytics-aggregate';
const retention = 'analytics-retention';
const chat = 'chat-notifications';
const mail = 'mail-queue';
const operations = '/api/admin/cron/operations';
const legacy = '/api/admin/cron/retention-cleanup';
const base = 'http://127.0.0.1:3114';
const cronSecret = randomBytes(32).toString('hex');
const owner = 'j4-fixture-owner';
const report = { version: 1, pass: false, stage: 'preflight', requests: [], cleanup: {} };
const [, , appDir, reportFile, extra] = process.argv;
let db;
let child;
let failure;
const counters = ['candidateCount', 'deletedCount', 'sent', 'failed', 'deferred', 'dropped', 'stale'];
function check(condition, code) {
  if (!condition) {
    failure = code;
    throw new Error(code);
  }
}
const same = (a, b, code) => check(isDeepStrictEqual(a, b), code);
const within = (value, start, end) => Number.isFinite(+value) && +value >= start && +value <= end;
const exited = () => child.exitCode !== null || child.signalCode !== null;
const listeners = () => execFileSync('ss', ['-Hltnp', 'sport = :3114'], {
  encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

function checkRegistration() {
  const text = readFileSync('deploy/cron.nbshiyan', 'utf8');
  const jobs = [
    { key: 'retention-cleanup', schedule: '30 3 * * *', time: '03:30', method: 'GET', path: legacy, timeout: 300000 },
    { key: retention, schedule: '30 4 * * *', time: '04:30', method: 'POST', path: operations, timeout: 55000 },
  ];
  check(/^#.*Times are server local time\.$/m.test(text) && !/^\s*(?:CRON_TZ|TZ)\s*=/m.test(text), 'REGISTRATION_ZONE');
  for (const job of jobs) {
    const matches = text.split(/\r?\n/).filter((line) => !line.startsWith('#') && line.includes(`'${job.key}',r.status`));
    check(matches.length === 1, 'REGISTRATION_COUNT');
    const start = `fetch('http://127.0.0.1:3000${job.path}',{`;
    const auth = "headers:{authorization:'Bearer '+process.env.CRON_SECRET";
    const options = job.method === 'GET' ? `${auth}}` :
      `method:'POST',${auth},'content-type':'application/json'},body:JSON.stringify({jobKey:'${job.key}'})`;
    check(matches[0].startsWith(`${job.schedule} root `) &&
      matches[0].includes(`${start}${options},signal:AbortSignal.timeout(${job.timeout})})`), 'REGISTRATION_REQUEST');
  }
  report.registrations = jobs.map(({ key, time, path, method }) => ({ key, time, path, method, timezone: 'server-local' }));
  report.dailyScheduleObserved = false;
}

async function startApp(databaseUrl) {
  check(listeners() === '', 'PORT_OCCUPIED');
  child = spawn(process.execPath, ['server.js'], {
    cwd: appDir, stdio: 'ignore', env: {
      PATH: process.env.PATH, TZ: 'UTC', APP_ENV: 'test', NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1', PORT: '3114', AUTH_URL: base, APP_ORIGIN: base, AUTH_TRUST_HOST: 'true',
      AUTH_SECRET: randomBytes(32).toString('hex'), ADMIN_TOTP_KEY: randomBytes(32).toString('base64'),
      PRIVACY_HASH_SECRET: randomBytes(32).toString('hex'), CRON_SECRET: cronSecret, DATABASE_URL: databaseUrl,
    },
  });
  let spawnError = false;
  child.on('error', () => { spawnError = true; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    check(!spawnError && child.pid && !exited(), 'APP_EARLY_EXIT');
    const health = await fetch(`${base}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(2000) }).catch(() => null);
    await health?.body?.cancel();
    if (health?.status === 200) {
      const rows = listeners().split('\n');
      check(rows.length === 1 && rows[0].split(/\s+/).includes('127.0.0.1:3114') && rows[0].includes(`pid=${child.pid},`), 'LISTENER_OWNER');
      report.listener = { port: 3114, pid: child.pid };
      return;
    }
    await sleep(150);
  }
  check(false, 'APP_NOT_READY');
}

async function stopApp() {
  if (!child?.pid) return;
  if (!exited()) child.kill('SIGTERM');
  for (let i = 0; i < 50 && !exited(); i++) await sleep(100);
  const neededKill = !exited();
  if (neededKill) child.kill('SIGKILL');
  for (let i = 0; i < 20 && !exited(); i++) await sleep(100);
  check(!neededKill && exited() && listeners() === '', 'APP_CLEANUP');
}

async function request(method, path, input, headers, timeout) {
  return fetch(base + path, {
    method, headers: { ...(input ? { 'content-type': 'application/json' } : {}), ...headers },
    body: input ? JSON.stringify(input) : undefined, redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
}

async function submitChat() {
  const headers = { origin: base };
  const session = await request('POST', '/api/chat/session', { locale: 'en' }, headers, 10_000);
  const set = session.headers.getSetCookie().find((value) => /HttpOnly/i.test(value));
  await session.body?.cancel();
  check(session.status === 200 && set, 'CHAT_SESSION');
  const saved = await request('POST', '/api/chat/conversations', {
    clientConversationId: randomUUID(), clientMessageId: randomUUID(), locale: 'en',
    bodyText: 'J4 isolated fixture', email: 'j4-visitor@example.test',
  }, { ...headers, cookie: set.split(';')[0] }, 10_000);
  const result = await saved.json();
  check(saved.status === 200 && result?.duplicate === false && typeof result.message?.id === 'string', 'CHAT_SAVE');
  return result.message.id;
}

async function call(label, { key, path = operations, bearer = true, http = 200, error, status = 'SUCCEEDED', timeout } = {}) {
  const method = path === legacy ? 'GET' : 'POST';
  const startedAt = Date.now();
  const row = { label, method, path, key: key ?? retention, startedAt: new Date(startedAt).toISOString(), http: null };
  report.requests.push(row);
  const response = await request(method, path, method === 'POST' ? { jobKey: key } : undefined,
    bearer ? { authorization: `Bearer ${cronSecret}` } : {}, timeout ?? (method === 'GET' ? 300_000 : 55_000));
  row.http = response.status;
  const endedAt = Date.now();
  row.endedAt = new Date(endedAt).toISOString();
  const body = await response.json();
  check(response.status === http && /\bno-store\b/i.test(response.headers.get('cache-control') ?? ''), 'HTTP_STATUS_OR_CACHE');
  if (error) {
    same(body, { error }, 'HTTP_ERROR');
    row.error = error;
  } else if (path === legacy) {
    check(body?.status === 'succeeded' && body.mode === 'dry-run' && body.batches === 0, 'LEGACY_RESULT');
    for (const field of ['candidateEvents', 'candidateRollupRows', 'deletedEvents', 'deletedRollupRows', 'keptExpiredEvents']) {
      check(Number.isSafeInteger(body[field]) && body[field] >= 0, 'LEGACY_COUNT');
      row[field] = body[field];
    }
    row.mode = 'dry-run';
    row.status = 'succeeded';
  } else {
    check(body?.jobKey === key && body.status === status && within(Date.parse(body.finishedAt), startedAt, endedAt), 'OPERATIONS_RESULT');
    check(body.counts && Object.keys(body.counts).length > 0 && Object.entries(body.counts).every(([name, value]) =>
      counters.includes(name) && Number.isSafeInteger(value) && value >= 0), 'OPERATIONS_COUNTS');
    row.status = status;
    row.counts = body.counts;
    row.finishedAt = new Date(body.finishedAt).toISOString();
  }
  return row;
}

async function snapshot() {
  return db.$transaction(async (tx) => ({
    jobs: Object.fromEntries((await tx.jobState.findMany({ orderBy: { key: 'asc' } })).map((row) => [row.key, row])),
    notifications: await tx.chatNotification.findMany({ orderBy: { id: 'asc' } }),
    messages: await tx.chatMessage.findMany({ orderBy: { id: 'asc' } }),
    mail: await tx.mailMessage.findMany({ orderBy: { id: 'asc' } }),
    audits: await tx.auditLog.count(),
    settings: await tx.siteSetting.findMany({ orderBy: { key: 'asc' } }),
    analytics: {
      events: await tx.analyticsEvent.findMany({ orderBy: { eventId: 'asc' } }),
      rollups: await tx.analyticsRollupDay.findMany({ orderBy: { siteDate: 'asc' } }),
      legacyDays: await tx.analyticsDailyRollup.findMany({ orderBy: [{ siteDate: 'asc' }, { kind: 'asc' }, { locale: 'asc' }, { productSlug: 'asc' }] }),
      days: await tx.analyticsDaily.findMany({ orderBy: [{ localDate: 'asc' }, { timezoneRevision: 'asc' }, { dimension: 'asc' }] }),
      states: await tx.analyticsAggregateDayState.findMany({ orderBy: [{ localDate: 'asc' }, { timezoneRevision: 'asc' }] }),
      markers: await tx.analyticsDayChange.findMany({ orderBy: { utcDate: 'asc' } }),
    },
  }), { isolationLevel: 'RepeatableRead' });
}

function jobsUnchanged(before, after, ...allowed) {
  const unaffected = (state) => Object.fromEntries(Object.entries(state.jobs).filter(([key]) => !allowed.includes(key)));
  same(unaffected(before), unaffected(after), 'UNRELATED_JOB_CHANGED');
}

function settled(before, after, key, request, status, counts, lastErrorCode = null) {
  const row = after.jobs[key];
  const start = Date.parse(request.startedAt);
  const end = Date.parse(request.endedAt);
  check(row && row.generation === (before.jobs[key]?.generation ?? 0) + 1 && row.lastStatus === status &&
    row.leaseOwner === null && row.lockedUntil === null && row.lastErrorCode === lastErrorCode &&
    row.lastFinishedAt && within(row.lastFinishedAt, start, end), 'JOB_TERMINAL');
  if (status === 'SUCCEEDED') same(row.lastSucceededAt, row.lastFinishedAt, 'JOB_SUCCESS_CLOCK');
  else same(row.lastSucceededAt, before.jobs[key]?.lastSucceededAt ?? null, 'FAILED_OVERSHOT_SUCCESS');
  same(row.summary?.counts, counts, 'JOB_DURABLE_COUNTS');
  request.job = { key, generationBefore: row.generation - 1, generation: row.generation, status, lastErrorCode,
    succeededAt: row.lastSucceededAt?.toISOString() ?? null, finishedAt: row.lastFinishedAt.toISOString(), leaseReleased: true };
}

async function seedAnalytics() {
  const [{ now }] = await db.$queryRaw`SELECT clock_timestamp() AS now`;
  const day = (offset) => new Date(+now + offset * 86_400_000).toISOString().slice(0, 10);
  const target = day(-1);
  const history = day(-600);
  const receivedAt = new Date(`${target}T12:01:00.000Z`);
  const old = new Date(`${history}T12:00:00.000Z`);
  await db.$transaction([
    db.siteSetting.create({ data: { key: 'analytics.settings', value: {
      version: 0, timezone: 'UTC', timezoneRevision: 1, changedAt: now.toISOString(), updatedBy: null,
    } } }),
    db.analyticsEvent.create({ data: { eventId: 'j4-fact', semanticKey: 'j4-fact', payloadHash: 'a'.repeat(64),
      browserHash: 'j4-fixture', kind: 'page_view', locale: 'en', path: '/en', occurredAt: new Date(`${target}T12:00:00.000Z`), receivedAt } }),
    db.analyticsDayChange.create({ data: { utcDate: target, version: 1n } }),
    db.analyticsEvent.create({ data: { eventId: 'j4-expired-unrolled', semanticKey: 'j4-expired-unrolled', payloadHash: 'b'.repeat(64),
      browserHash: 'j4-fixture', kind: 'page_view', locale: 'en', path: '/en', occurredAt: new Date(`${day(-60)}T12:00:00.000Z`),
      receivedAt: new Date(`${day(-60)}T12:01:00.000Z`) } }),
    db.analyticsRollupDay.create({ data: { siteDate: history, timezoneRevision: 1, completedAt: old, eventCount: 2, sourceMaxReceivedAt: old } }),
    db.analyticsDailyRollup.create({ data: { siteDate: history, kind: 'page_view', locale: 'en', count: 2, uniqueBrowsers: 1 } }),
    db.jobState.create({ data: { key: mail, generation: 7, lastStatus: 'SUCCEEDED', lastSucceededAt: old, lastFinishedAt: old } }),
  ]);
  return { target, receivedAt };
}

try {
  check(process.platform === 'linux' && process.getuid() > 0 && process.versions.node.startsWith('22.'), 'RUNTIME');
  check(appDir?.startsWith('/tmp/') && realpathSync(appDir) === appDir && reportFile?.startsWith('/') && !extra, 'ARGUMENTS');
  const { J4_DB_URL, J4_SOURCE_COMMIT, J4_SOURCE_TREE, J4_BUILD_ID, J4_BUILD_SHA256, J4_SCRIPT_SHA256, J4_HOST_NET_NS, J4_HOST_PID_NS } = process.env;
  check([J4_SOURCE_COMMIT, J4_SOURCE_TREE].every((x) => /^[a-f0-9]{40}$/.test(x)) &&
    [J4_BUILD_SHA256, J4_SCRIPT_SHA256].every((x) => /^[a-f0-9]{64}$/.test(x)), 'PROVENANCE_FORMAT');
  check(/^net:\[\d+\]$/.test(J4_HOST_NET_NS) && /^pid:\[\d+\]$/.test(J4_HOST_PID_NS) &&
    readlinkSync('/proc/self/ns/net') !== J4_HOST_NET_NS && readlinkSync('/proc/self/ns/pid') !== J4_HOST_PID_NS &&
    isDeepStrictEqual(readdirSync('/sys/class/net'), ['lo']), 'ISOLATION');
  const url = new URL(J4_DB_URL);
  check(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && /^\/e2e_j4_[a-f0-9]{12}$/.test(url.pathname) &&
    url.port && url.username && !url.search && !url.hash, 'DATABASE_TARGET');
  const buildId = readFileSync(join(appDir, '.next/BUILD_ID'), 'utf8').trim();
  const manifest = JSON.parse(readFileSync(join(appDir, '.next/required-server-files.json'), 'utf8'));
  check(/^[\w-]{1,128}$/.test(buildId) && buildId === J4_BUILD_ID && manifest.config.env.APP_ENV_AT_BUILD === 'test' &&
    createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') === J4_SCRIPT_SHA256, 'BUILD_OR_SCRIPT_ID');
  report.identity = { sourceCommit: J4_SOURCE_COMMIT, sourceTree: J4_SOURCE_TREE, buildId, buildSha256: J4_BUILD_SHA256,
    scriptSha256: J4_SCRIPT_SHA256, appEnv: 'test', instance: url.pathname.slice(-12), node: process.versions.node };
  report.config = { chatChannel: 'disabled', retentionDeleteAllowed: false, trigger: 'manual-http' };
  checkRegistration();
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ datasources: { db: { url: J4_DB_URL } } });
  const [pg] = await db.$queryRaw`SELECT current_database() AS database, current_schema() AS schema,
    current_setting('server_version_num')::int AS version, host(inet_server_addr()) AS address, inet_server_port() AS port`;
  check(pg?.database === url.pathname.slice(1) && pg.schema === 'public' && pg.address === '127.0.0.1' && pg.port === Number(url.port) &&
    pg.version >= 170000 && pg.version < 180000, 'PG17_IDENTITY');
  report.identity.pgVersionNum = pg.version;
  report.stage = 'fixture';
  const fresh = await snapshot();
  check(Object.keys(fresh.jobs).length === 0 && [...Object.values(fresh.analytics), fresh.notifications, fresh.messages, fresh.mail].every((rows) => rows.length === 0) &&
    fresh.settings.length === 0 && fresh.audits === 0, 'DATABASE_NOT_FRESH');
  const fixture = await seedAnalytics();
  await startApp(J4_DB_URL);
  const messageId = await submitChat();
  const queued = await snapshot();
  check(queued.notifications.length === 1 && queued.notifications[0].messageId === messageId &&
    queued.notifications[0].status === 'QUEUED' && queued.notifications[0].attempts === 0 &&
    queued.notifications[0].availableAt <= new Date() && queued.messages.length === 1, 'CHAT_QUEUED');

  report.stage = 'denials';
  await call('missing-bearer', { key: chat, bearer: false, http: 401, error: 'unauthorized' });
  same(await snapshot(), queued, 'UNAUTH_CHANGED_DB');
  await call('unknown-key', { key: 'ops-sample', http: 400, error: 'unknown_job' });
  same(await snapshot(), queued, 'UNKNOWN_KEY_CHANGED_DB');

  report.stage = 'chat';
  const routedChat = await call('chat', { key: chat });
  const afterChat = await snapshot();
  const expectedChat = { candidateCount: 0, sent: 0, failed: 0, deferred: 0, dropped: 1, stale: 0 };
  same(routedChat.counts, expectedChat, 'CHAT_COUNTS');
  settled(queued, afterChat, chat, routedChat, 'SUCCEEDED', expectedChat);
  jobsUnchanged(queued, afterChat, chat);
  same(afterChat.analytics, queued.analytics, 'CHAT_CHANGED_ANALYTICS');
  same(afterChat.messages, queued.messages, 'CHAT_CHANGED_MESSAGE');
  same(afterChat.mail, queued.mail, 'CHAT_CHANGED_MAIL');
  check(afterChat.notifications.length === 1, 'CHAT_OUTBOX_COUNT');
  const disabled = afterChat.notifications[0];
  same(disabled, { ...queued.notifications[0], status: 'DISABLED', updatedAt: disabled.updatedAt }, 'CHAT_DISABLED');
  check(within(disabled.updatedAt, Date.parse(routedChat.startedAt), Date.parse(routedChat.endedAt)), 'CHAT_DISABLE_CLOCK');
  routedChat.outbox = { before: 'QUEUED', after: 'DISABLED', attempts: disabled.attempts,
    count: 1, sameMessage: true, mailGeneration: afterChat.jobs[mail].generation };

  report.stage = 'aggregate';
  const routedAggregate = await call('aggregate', { key: aggregate });
  const afterAggregate = await snapshot();
  const { target, receivedAt } = fixture;
  check(routedAggregate.counts.candidateCount >= 1, 'AGGREGATE_COUNT');
  settled(afterChat, afterAggregate, aggregate, routedAggregate, 'SUCCEEDED', { candidateCount: routedAggregate.counts.candidateCount });
  jobsUnchanged(afterChat, afterAggregate, aggregate);
  same(afterAggregate.notifications, afterChat.notifications, 'AGGREGATE_CHANGED_CHAT');
  const published = afterAggregate.analytics.rollups.find((row) => row.siteDate === target);
  const siteDay = afterAggregate.analytics.days.find((row) => row.localDate === target && row.timezoneRevision === 1 && row.dimension === 'site');
  const dayState = afterAggregate.analytics.states.find((row) => row.localDate === target && row.timezoneRevision === 1);
  check(!afterChat.analytics.rollups.some((row) => row.siteDate === target) && published?.timezoneRevision === 1 &&
    published.eventCount === 1 && +published.sourceMaxReceivedAt === +receivedAt && siteDay?.pageViews === 1 &&
    +siteDay.sourceThrough === +receivedAt && dayState?.gapKind === null && dayState.deferUntil === null &&
    dayState.markerVersions?.[target] === '1' && afterAggregate.jobs[aggregate]?.summary?.versions?.timezoneRevision === 1 &&
    afterAggregate.jobs[aggregate]?.summary?.times?.sourceThrough === receivedAt.toISOString(), 'AGGREGATE_WATERMARK');
  routedAggregate.watermark = { day: target, timezoneRevision: 1, sourceThrough: receivedAt.toISOString(), pageViews: 1, markerVersion: 1 };

  report.stage = 'retention';
  let before = afterAggregate;
  for (const path of [operations, legacy]) {
    const isLegacy = path === legacy;
    const routed = await call(isLegacy ? 'legacy-default' : 'retention-default', { key: retention, path });
    const after = await snapshot();
    const expectedCounts = { candidateCount: isLegacy ? 2 : 3, deletedCount: 0 };
    if (isLegacy) same([routed.candidateEvents, routed.candidateRollupRows, routed.deletedEvents,
      routed.deletedRollupRows, routed.keptExpiredEvents], [0, 2, 0, 0, 1], 'LEGACY_CANDIDATES');
    else same(routed.counts, expectedCounts, 'RETENTION_CANDIDATES');
    settled(before, after, retention, routed, 'SUCCEEDED', expectedCounts);
    jobsUnchanged(before, after, aggregate, retention);
    const lease = before.jobs[aggregate];
    same(after.jobs[aggregate], { ...lease, generation: lease.generation + 1, updatedAt: after.jobs[aggregate]?.updatedAt }, 'RETENTION_CHANGED_AGGREGATE_RESULT');
    same(after.analytics, before.analytics, 'RETENTION_CHANGED_DATA');
    same(after.notifications, before.notifications, 'RETENTION_CHANGED_CHAT');
    same(after.messages, before.messages, 'RETENTION_CHANGED_MESSAGES');
    same(after.settings, before.settings, 'RETENTION_CHANGED_SETTINGS');
    same(after.mail, before.mail, 'RETENTION_CHANGED_MAIL');
    same(after.audits, before.audits + Number(isLegacy), 'RETENTION_AUDIT_COUNT');
    routed.sharedLease = { generationBefore: lease.generation, generation: lease.generation + 1,
      aggregateLastSucceededAt: lease.lastSucceededAt.toISOString(), watermarkUnchanged: true, removedRows: 0 };
    routed.mode = 'dry-run';
    routed.modeEvidence = isLegacy ? 'response' : 'default-request-and-disabled-delete';
    before = after;
  }

  report.stage = 'busy';
  // Commit the same active lease fixture used by the PG regressions, with no open blocking transaction.
  const lockedUntil = new Date(Date.now() + 90_000);
  const leaseKey = { key: aggregate, generation: before.jobs[aggregate].generation };
  const claimed = await db.jobState.updateMany({ where: { ...leaseKey, leaseOwner: null, lockedUntil: null },
    data: { leaseOwner: owner, lockedUntil } });
  same(claimed.count, 1, 'BUSY_FIXTURE');
  try {
    const held = await snapshot();
    for (const [label, key, path] of [['aggregate-busy', aggregate, operations], ['retention-busy', retention, operations], ['legacy-busy', retention, legacy]]) {
      const denied = await call(label, { key, path, http: 409, error: 'job_busy', timeout: 10_000 });
      check(Date.parse(denied.endedAt) < +lockedUntil, 'BUSY_FIXTURE_EXPIRED');
      same(await snapshot(), held, 'BUSY_CHANGED_DB');
      denied.sharedLease = { key: aggregate, generation: leaseKey.generation, lockedUntil: lockedUntil.toISOString(),
        ownerUnchanged: true, watermarkUnchanged: true };
    }
  } finally {
    try {
      const released = await db.jobState.updateMany({ where: { ...leaseKey, leaseOwner: owner, lockedUntil }, data: { leaseOwner: null, lockedUntil: null } });
      report.cleanup.fixtureLeaseReleased = released.count === 1;
    } catch {
      report.cleanup.fixtureLeaseReleased = false;
    }
    if (!report.cleanup.fixtureLeaseReleased) report.cleanup.leaseError = 'BUSY_FIXTURE_RELEASE';
  }
  check(report.cleanup.fixtureLeaseReleased, 'BUSY_FIXTURE_RELEASE');

  report.stage = 'persisted-failure';
  const [{ now: failureNow }] = await db.$queryRaw`SELECT clock_timestamp() AS now`;
  const conflictDate = failureNow.toISOString().slice(0, 10);
  check(conflictDate > target, 'CONFLICT_DAY');
  await db.analyticsRollupDay.upsert({ where: { siteDate: conflictDate }, update: { timezoneRevision: 9 },
    create: { siteDate: conflictDate, timezoneRevision: 9, completedAt: new Date(), eventCount: 7 } });
  const conflicting = await snapshot();
  const failed = await call('aggregate-conflict', { key: aggregate, status: 'FAILED' });
  const afterFailure = await snapshot();
  same(failed.counts, { candidateCount: 0 }, 'AGGREGATE_FAILED_COUNTS');
  settled(conflicting, afterFailure, aggregate, failed, 'FAILED', failed.counts, 'version_conflict');
  jobsUnchanged(conflicting, afterFailure, aggregate);
  same(afterFailure.analytics, conflicting.analytics, 'FAILED_CHANGED_WATERMARK');
  failed.watermarkUnchanged = true;
  report.stage = 'complete';
} catch {
  report.failure = failure ?? 'UNEXPECTED_STAGE_FAILURE';
} finally {
  try { await stopApp(); report.cleanup.appStopped = Boolean(child?.pid); }
  catch { report.cleanup.appStopped = false; report.cleanup.appError = 'APP_CLEANUP'; }
  try { if (db) await db.$disconnect(); report.cleanup.dbDisconnected = Boolean(db); }
  catch { report.cleanup.dbDisconnected = false; report.cleanup.dbError = 'DB_CLEANUP'; }
  report.pass = report.stage === 'complete' && !report.failure && report.cleanup.fixtureLeaseReleased &&
    report.cleanup.appStopped && report.cleanup.dbDisconnected;
  try {
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(report.pass ? 'J4_OPERATIONS_PASS' : 'J4_OPERATIONS_FAILED');
  } catch {
    report.pass = false;
    console.error('J4_REPORT_WRITE_FAILED');
  }
  if (!report.pass) process.exitCode = 1;
}
