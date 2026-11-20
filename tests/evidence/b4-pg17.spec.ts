import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type APIRequestContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { initializeRunAuth, loadRunAuth } from '../../e2e/run-auth';
import { utcDatesCovered } from '../../src/lib/analytics/daily-aggregate';
import { siteDayUtcBounds, siteLocalDate } from '../../src/lib/analytics/day-boundaries';

const INTERVAL = 300_000;
const base = 'http://localhost:3111';
const settingsPath = '/api/admin/settings/analytics';
const key = 'analytics-aggregate';
const root = process.env.B4_ROOT!;
const target = 'Asia/Tokyo';
const path = (name: string) => join(root, name);
const nextBoundary = () => (Math.floor(Date.now() / INTERVAL) + 1) * INTERVAL;

type Tick = { at: number; end: number; http: number; result: string; finishedAt: number | null; crondPid: number };
type Settings = { version: number; timezone: string; timezoneRevision: number; recomputableFrom: string | null; rebuildScheduled?: boolean };
type Round = Awaited<ReturnType<typeof recordRound>>;

async function until<T>(read: () => Promise<T | undefined>, deadline: number, label: string, interval = 250): Promise<T> {
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await sleep(interval);
  }
  throw new Error(label);
}

async function ticks(): Promise<Tick[]> {
  const text = await readFile(path('cron.jsonl'), 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Tick);
}

async function startCrond(busybox: string) {
  const template = await readFile('deploy/cron.nbshiyan', 'utf8');
  const lines = template.split('\n').filter((line) => line.includes("jobKey:'analytics-aggregate'") && !line.startsWith('#'));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\*\/5 \* \* \* \* root /);
  assert.ok(lines[0]!.includes("method:'POST'") && lines[0]!.includes('/api/admin/cron/operations') && lines[0]!.includes('AbortSignal.timeout(55000)'));
  const spool = path('spool');
  assert.match(process.execPath, /^\/[A-Za-z0-9_./-]+$/);
  await writeFile(join(spool, 'root'), `*/5 * * * * exec /bin/bash ${path('tick.sh')} tick ${root} ${process.execPath}\n`, { mode: 0o600 });
  if (nextBoundary() - Date.now() < 5_000) await sleep(nextBoundary() - Date.now() + 1_000);
  return spawn(busybox, ['crond', '-f', '-c', spool, '-l', '8', '-L', path('crond.private.log')], {
    stdio: 'ignore', env: { PATH: process.env.PATH, TZ: 'UTC' },
  });
}

function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stop(child: ChildProcess | undefined) {
  if (!child || exited(child) || !child.pid) return;
  child.kill('SIGTERM');
  try {
    await until(async () => exited(child) ? true : undefined, Date.now() + 15_000, 'B4_CHILD_STOP_TIMEOUT');
  } catch (error) {
    child.kill('SIGKILL');
    await until(async () => exited(child) ? true : undefined, Date.now() + 5_000, 'B4_CHILD_KILL_TIMEOUT');
    throw error;
  }
}

async function healthy(child: ChildProcess) {
  await until(async () => {
    assert.ok(child.pid && !exited(child), 'B4_APP_EXITED');
    try {
      const response = await fetch(`${base}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      return response.status === 200 ? true : undefined;
    } catch { return undefined; }
  }, Date.now() + 120_000, 'B4_APP_NOT_READY');
  const listeners = execFileSync(process.env.B4_SETPRIV!, [...appIdentity, 'ss', '-Hltnp', 'sport = :3111'], {
    encoding: 'utf8', timeout: 2_000,
  }).trim().split('\n');
  assert.equal(listeners.length, 1);
  assert.ok(listeners[0]?.trim().split(/\s+/).includes('127.0.0.1:3111'));
  assert.ok(listeners[0]?.includes(`pid=${child.pid},`), 'B4_APP_LISTENER_OWNER');
}

const appIdentity = ['--reuid', 'nobody', '--regid', String(process.env.B4_APP_GID), '--init-groups', '--no-new-privs', '--'];

function startApp(setpriv: string) {
  return spawn(setpriv, [...appIdentity, process.execPath, 'server.js'], {
    cwd: path('app'), stdio: 'ignore', env: {
      PATH: process.env.PATH, TZ: 'UTC', NODE_ENV: 'production', APP_ENV: 'test', PORT: '3111', HOSTNAME: '127.0.0.1',
      AUTH_URL: base, APP_ORIGIN: base, AUTH_TRUST_HOST: 'true', RETENTION_CLEANUP_MODE: 'dry-run',
      CRON_SECRET: process.env.CRON_SECRET, AUTH_SECRET: process.env.AUTH_SECRET, ADMIN_TOTP_KEY: process.env.ADMIN_TOTP_KEY,
      PRIVACY_HASH_SECRET: process.env.PRIVACY_HASH_SECRET, DATABASE_URL: process.env.B4_APP_DB,
    },
  });
}

async function readSettings(api: APIRequestContext): Promise<Settings> {
  const res = await api.get(settingsPath, { timeout: 8_000, maxRedirects: 0 });
  assert.equal(res.status(), 200);
  return await res.json() as Settings;
}

async function patchSettings(api: APIRequestContext, db: PrismaClient, initial: Settings, timezone: string) {
  const res = await api.patch(settingsPath, {
    headers: { Origin: base }, data: { timezone, expectedVersion: initial.version }, timeout: 8_000, maxRedirects: 0,
  });
  assert.equal(res.status(), 200);
  const next = await res.json() as Settings;
  assert.equal(next.timezone, timezone);
  assert.equal(next.version, initial.version + 1);
  assert.equal(next.timezoneRevision, initial.timezoneRevision + 1);
  assert.equal(next.rebuildScheduled, true);
  assert.ok(next.recomputableFrom && Number.isFinite(Date.parse(next.recomputableFrom)));
  const stored = await db.siteSetting.findUniqueOrThrow({ where: { key: 'analytics.settings' } });
  const persisted = stored.value as unknown as Settings;
  assert.deepEqual([persisted.timezone, persisted.timezoneRevision, persisted.version], [timezone, next.timezoneRevision, next.version]);
  const pending = await db.siteSetting.findUniqueOrThrow({ where: { key: 'analytics.recompute' } });
  const value = pending.value as unknown as Settings & { status: string };
  assert.deepEqual([value.timezone, value.timezoneRevision, value.recomputableFrom, value.status], [timezone, next.timezoneRevision, next.recomputableFrom, 'pending']);
  return {
    version: next.version, timezone: next.timezone, timezoneRevision: next.timezoneRevision,
    recomputableFrom: new Date(next.recomputableFrom).toISOString(), rebuildScheduled: true, httpStatus: res.status(),
  };
}

async function seedFact(db: PrismaClient, id: string, occurredAt: Date) {
  const receivedAt = new Date();
  const utcDate = siteLocalDate(occurredAt, 'UTC');
  await db.$transaction(async (tx) => {
    await tx.analyticsEvent.create({ data: {
      eventId: id, semanticKey: id, payloadHash: 'a'.repeat(64), browserHash: 'b4-fixture', kind: 'page_view', locale: 'en', path: '/en', occurredAt, receivedAt,
    } });
    await tx.analyticsDayChange.upsert({
      where: { utcDate }, create: { utcDate, version: 1n }, update: { version: { increment: 1n } },
    });
  });
  return receivedAt;
}

function readJob(db: PrismaClient) {
  return db.jobState.findUnique({ where: { key } });
}

async function readDay(db: PrismaClient, localDate: string, timezoneRevision: number) {
  return db.$transaction(async (tx) => {
    const rollup = await tx.analyticsRollupDay.findUnique({ where: { siteDate: localDate } });
    const daily = await tx.analyticsDaily.findUnique({ where: { localDate_timezoneRevision_dimension: { localDate, timezoneRevision, dimension: 'site' } } });
    const state = await tx.analyticsAggregateDayState.findUnique({ where: { localDate_timezoneRevision: { localDate, timezoneRevision } } });
    return { rollup, daily, state };
  }, { isolationLevel: 'RepeatableRead' });
}

async function nextTick(index: number, boundary: number, crond: ChildProcess) {
  const tick = await until(async () => {
    assert.ok(!exited(crond), 'B4_CROND_EXITED');
    assert.equal(await readFile(path('cron-preflight.txt'), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    }), null, 'B4_CRON_PREFLIGHT');
    const observed = await ticks();
    assert.ok(observed.length <= index + 1, 'B4_EXTRA_TICK');
    return observed[index];
  }, boundary + 70_000, 'B4_TICK_MISSING');
  assert.equal(tick.crondPid, crond.pid);
  assert.ok(tick.at >= boundary && tick.at <= boundary + 5_000, 'B4_WRONG_BOUNDARY');
  assert.ok(tick.end >= tick.at && tick.end - tick.at <= 57_000, 'B4_TICK_BUDGET');
  return tick;
}

async function recordRound(args: {
  name: string; db: PrismaClient; index: number; boundary: number; crond: ChildProcess; after: number;
  previous: { generation: number; succeeded: number } | null;
  timezone: string; revision: number; occurredAt: Date; receivedAt: Date; count: number;
}) {
  const { name, db, index, boundary, crond, after, previous, timezone, revision, occurredAt, receivedAt, count } = args;
  const tick = await nextTick(index, boundary, crond);
  assert.deepEqual([tick.http, tick.result], [200, 'SUCCEEDED']);
  const observation = await db.$transaction(async (tx) => {
    const job = await tx.jobState.findUniqueOrThrow({ where: { key } });
    const date = siteLocalDate(occurredAt, timezone);
    const rollup = await tx.analyticsRollupDay.findUniqueOrThrow({ where: { siteDate: date } });
    const daily = await tx.analyticsDaily.findUniqueOrThrow({ where: { localDate_timezoneRevision_dimension: { localDate: date, timezoneRevision: revision, dimension: 'site' } } });
    const state = await tx.analyticsAggregateDayState.findUniqueOrThrow({ where: { localDate_timezoneRevision: { localDate: date, timezoneRevision: revision } } });
    const days = utcDatesCovered(siteDayUtcBounds(date, timezone));
    const live = await tx.analyticsDayChange.findMany({ where: { utcDate: { in: days } } });
    const currentMarkers = Object.fromEntries(days.map((day) => [day, String(live.find((entry) => entry.utcDate === day)?.version ?? 0n)]));
    return { job, date, rollup, daily, state, currentMarkers };
  }, { isolationLevel: 'RepeatableRead' });
  const { job, date, rollup, daily, state, currentMarkers } = observation;
  assert.equal(job.generation, (previous?.generation ?? 0) + 1);
  assert.deepEqual([job.lastStatus, job.lastErrorCode, job.leaseOwner, job.lockedUntil], ['SUCCEEDED', null, null, null]);
  const started = job.lastStartedAt?.getTime() ?? 0;
  const succeeded = job.lastSucceededAt?.getTime() ?? 0;
  assert.ok(started >= Math.max(after, tick.at, receivedAt.getTime()));
  assert.ok(succeeded >= started && succeeded > (previous?.succeeded ?? 0));
  assert.equal(job.lastFinishedAt?.getTime(), succeeded);
  assert.ok(tick.finishedAt !== null && tick.finishedAt >= succeeded && tick.finishedAt <= tick.end);
  const summary = job.summary as unknown as { versions?: { timezoneRevision?: number }; times?: { aggregatedAt?: string; sourceThrough?: string } };
  const aggregatedAt = Date.parse(summary.times?.aggregatedAt ?? '');
  assert.ok(aggregatedAt >= tick.at && aggregatedAt <= started);
  assert.equal(summary.versions?.timezoneRevision, revision);
  assert.equal(summary.times?.sourceThrough, receivedAt.toISOString());
  assert.equal(rollup.timezoneRevision, revision);
  assert.equal(rollup.completedAt.getTime(), aggregatedAt);
  assert.equal(rollup.sourceMaxReceivedAt?.getTime(), receivedAt.getTime());
  assert.equal(rollup.eventCount, count);
  assert.deepEqual([daily.timezone, daily.dimension, daily.pageViews, daily.visitors], [timezone, 'site', count, 1]);
  assert.equal(daily.sourceThrough?.getTime(), receivedAt.getTime());
  assert.equal(daily.aggregatedAt.getTime(), aggregatedAt);
  assert.deepEqual([state.timezone, state.gapKind, state.gapSince, state.deferUntil, state.markerVersions], [timezone, null, null, null, currentMarkers]);
  return {
    name, tick, generation: job.generation, started, succeeded, aggregatedAt, revision, timezone, date, count,
    sourceThrough: receivedAt.toISOString(), dailyAggregatedAt: daily.aggregatedAt.toISOString(), markerVersions: currentMarkers,
  };
}

async function atGuardBarrier<T>(db: PrismaClient, boundary: number, before: Round, action: () => Promise<T>) {
  assert.ok(boundary - Date.now() > 10_000, 'B4_GUARD_ARM_WINDOW');
  await sleep(boundary - Date.now() - 2_000);
  // Both runs hold the same relation lock. It blocks the old transaction's legacy DELETE, not ADMIN PATCH.
  const wait = await db.$transaction(async (barrier) => {
    await barrier.$executeRaw`LOCK TABLE "AnalyticsDailyRollup" IN SHARE MODE`;
    const [holder] = await barrier.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    assert.ok(holder);
    const blocked = await until(async () => {
      const candidates = await db.$queryRaw<{ pid: number }[]>`
        SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
        WHERE a.datname = current_database() AND a.usename = 'b4_app' AND a.wait_event_type = 'Lock' AND a.wait_event = 'relation'
          AND l.locktype = 'relation' AND l.relation = '"AnalyticsDailyRollup"'::regclass AND l.mode = 'RowExclusiveLock' AND NOT l.granted
          AND ${holder.pid}::int = ANY(pg_blocking_pids(a.pid)) AND ltrim(a.query) LIKE 'DELETE FROM "AnalyticsDailyRollup"%'
      `;
      assert.ok(candidates.length <= 1);
      return candidates[0];
    }, boundary + 12_000, 'B4_OLD_DELETE_NOT_BLOCKED', 100);
    const blockedAt = Date.now();
    const inFlight = await readJob(db);
    assert.ok(inFlight);
    assert.equal(inFlight.generation, before.generation + 1);
    assert.equal(inFlight.lastStatus, 'RUNNING');
    assert.equal(inFlight.lastSucceededAt?.getTime(), before.succeeded);
    assert.notEqual(blocked.pid, holder.pid);
    const result = await action();
    // Use a fixed release target in both runs, after verifying the request/readback has completed.
    assert.ok(Date.now() < boundary + 23_000, 'B4_GUARD_RELEASE_LATE');
    await sleep(boundary + 23_000 - Date.now());
    const releaseRequestedAt = Date.now();
    assert.ok(releaseRequestedAt < boundary + 25_000, 'B4_GUARD_RELEASE_LATE');
    return { blockedPid: blocked.pid, barrierPid: holder.pid, blockedAt, releaseRequestedAt, result };
  }, { maxWait: 2_000, timeout: 30_000 });
  return { ...wait, releasedAt: Date.now(), relation: 'AnalyticsDailyRollup', lockMode: 'ShareLock' };
}

async function guardConflict(args: {
  db: PrismaClient; api: APIRequestContext; crond: ChildProcess; before: Round; settings: Settings; boundary: number; receivedAt: Date;
}) {
  const { db, api, crond, before, settings, boundary, receivedAt } = args;
  const prior = await readDay(db, before.date, before.revision);
  const [logging] = await db.$queryRaw<{ path: string | null }[]>`SELECT pg_current_logfile('jsonlog') AS path`;
  assert.ok(logging?.path && logging.path.startsWith(`${path('pg-log')}/`));
  const log = await realpath(logging.path);
  assert.equal(log, logging.path);
  assert.match(log.slice(path('pg-log').length + 1), /^[A-Za-z0-9_.-]+\.json$/);
  const { result, ...barrier } = await atGuardBarrier(db, boundary, before, async () => {
    const patch = await patchSettings(api, db, settings, 'America/New_York');
    return { patch, patchedAt: Date.now() };
  });
  const { patch, patchedAt } = result;
  const tick = await nextTick(4, boundary, crond);
  assert.deepEqual([tick.http, tick.result], [500, 'job_failed']);
  assert.ok(receivedAt.getTime() < tick.at && patchedAt >= barrier.blockedAt && patchedAt < barrier.releasedAt);
  assert.ok(barrier.releasedAt < tick.end);
  const evidence = await until(async () => {
    const text = await readFile(log, 'utf8');
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as { pid?: number; timestamp?: string; state_code?: string; statement?: string };
      if (row.pid !== barrier.blockedPid || row.state_code !== '40001') continue;
      const timestamp = Date.parse(row.timestamp ?? '');
      if (!Number.isFinite(timestamp) || timestamp < barrier.releaseRequestedAt || timestamp > tick.end) continue;
      const statement = row.statement?.replace(/\s+/g, ' ').trim() ?? '';
      if (/^SELECT "value" FROM "SiteSetting" WHERE "key" = \$\d+ FOR UPDATE$/.test(statement)) {
        return { pid: row.pid, sqlstate: row.state_code, phase: 'daily_write_guard_site_setting_for_update', timestamp };
      }
    }
    return undefined;
  }, tick.end + 15_000, 'B4_RR_WRITE_GUARD_SQLSTATE_UNPROVEN');
  const job = await readJob(db);
  assert.ok(job);
  assert.equal(job.generation, before.generation + 1);
  assert.equal(job.lastStatus, 'RUNNING');
  assert.equal(job.lastSucceededAt?.getTime(), before.succeeded);
  assert.deepEqual(await readDay(db, before.date, before.revision), prior);
  const pending = await db.siteSetting.findUniqueOrThrow({ where: { key: 'analytics.recompute' } });
  const stored = pending.value as unknown as Settings & { status: string };
  assert.deepEqual([stored.timezoneRevision, stored.timezone, stored.status], [patch.timezoneRevision, patch.timezone, 'pending']);
  return {
    status: 'rr_write_guard_40001', tick, barrier, patch, patchedAt, evidence,
    generation: job.generation, lastSucceeded: before.succeeded, previousCount: before.count,
    sourceThrough: before.sourceThrough, seededThrough: receivedAt.toISOString(),
  };
}

test('B4 PG17 real schedule and ADMIN revision', async ({ playwright }) => {
  const { B4_MODE: mode, B4_SOURCE_COMMIT: sourceCommit, B4_SOURCE_TREE: sourceTree, B4_BUILD_ID: buildId, B4_BUILD_SHA256: buildSha256 } = process.env;
  const { B4_BUSYBOX: busybox, B4_SETPRIV: setpriv, B4_APPROVED_SHA256: approvedSha256, CRON_SECRET: secret } = process.env;
  const { B4_TOOL_ID: toolId, B4_PG_SHA256: postgres, B4_CROND_SHA256: crondSha, B4_NODE_SHA256: node } = process.env;
  assert.ok((mode === 'schedule' || mode === 'with-guard' || mode === 'guard-control') && sourceCommit && sourceTree && buildId && buildSha256 && busybox && setpriv);
  assert.ok(secret && /^[a-f0-9]{64}$/.test(secret) && [approvedSha256, toolId, postgres, crondSha, node].every((hash) => hash && /^[a-f0-9]{64}$/.test(hash)));
  const tools = { toolId, postgres, crond: crondSha, node };
  assert.equal(process.getuid?.(), 0);
  const launcher = (await readFile('/proc/1/cmdline', 'utf8')).split('\0');
  assert.deepEqual(launcher.slice(0, 3), ['/bin/bash', '/build/source/tests/evidence/b4-pg17.sh', 'run']);
  assert.equal(process.env.DATABASE_URL, 'postgresql://b4_pg@127.0.0.1:55417/b4_e2e');
  assert.equal(process.env.B4_APP_DB, 'postgresql://b4_app@127.0.0.1:55417/b4_e2e');
  const db = new PrismaClient();
  let app: ChildProcess | undefined;
  let crond: ChildProcess | undefined;
  let closeAuth: (() => void) | undefined;
  let api: APIRequestContext | undefined;
  let stage = 'owned_database';
  try {
    const pg = await db.$queryRaw<{ server: number; db: string; port: number; data: string; shm: string }[]>`
      SELECT current_setting('server_version_num')::int AS server, current_database() AS db,
             inet_server_port() AS port, current_setting('data_directory') AS data, current_setting('dynamic_shared_memory_type') AS shm
    `;
    assert.ok(pg[0] && pg[0].server >= 170000 && pg[0].server < 180000 && pg[0].db === 'b4_e2e' && pg[0].port === 55417 && pg[0].data === path('pg') && pg[0].shm === 'mmap');
    assert.equal(await readJob(db), null);
    assert.equal(await db.analyticsEvent.count(), 0);
    await access(path('app/server.js'));
    await writeFile(path('cron.jsonl'), '', { flag: 'wx', mode: 0o600 });
    await writeFile(path('cron.secret'), secret, { flag: 'wx', mode: 0o600 });
    await writeFile(path('crond.exe'), await realpath(busybox), { flag: 'wx', mode: 0o600 });
    await writeFile(path('node.exe'), process.execPath, { flag: 'wx', mode: 0o600 });
    stage = 'standalone_and_auth';
    app = startApp(setpriv);
    await healthy(app);
    const appPid = app.pid;
    const authEnv = { ...process.env, GITHUB_SHA: sourceCommit };
    closeAuth = await initializeRunAuth(base, playwright.request, authEnv);
    const state = await loadRunAuth('content-admin', base, playwright.request, authEnv);
    api = await playwright.request.newContext({ baseURL: base, storageState: state });
    const initial = await readSettings(api);
    assert.deepEqual([initial.version, initial.timezone, initial.timezoneRevision], [0, 'UTC', 1]);
    const occurredAt = new Date(Date.now() - 30 * 60 * 60_000);
    const historyDate = siteLocalDate(new Date(Date.now() - 45 * 86_400_000), 'UTC');
    const retained = await db.analyticsDaily.create({ data: {
      localDate: historyDate, timezoneRevision: 1, timezone: 'UTC', dimension: 'site', visitors: 7, pageViews: 11,
      productViews: 0, modelStarts: 0, modelSuccesses: 0, modelFailures: 0, chatStarts: 0, durationMsSum: 0n,
      loadDurationSamples: 0, aggregatedAt: new Date(`${historyDate}T12:00:00Z`), expiresAt: new Date(Date.now() + 320 * 86_400_000),
    } });
    const firstReceived = await seedFact(db, 'b4-first', occurredAt);
    const rounds: Round[] = [];
    stage = 'initial_true_tick';
    crond = await startCrond(busybox);
    assert.ok(crond.pid);
    await writeFile(path('crond.pid'), String(crond.pid), { mode: 0o600 });
    const firstBoundary = nextBoundary();
    const first = await recordRound({ name: 'initial', db, index: 0, boundary: firstBoundary, crond, after: firstReceived.getTime(), previous: null, timezone: initial.timezone, revision: 1, occurredAt, receivedAt: firstReceived, count: 1 });
    rounds.push(first);
    const oldDaily = (await readDay(db, first.date, 1)).daily;
    assert.ok(oldDaily);
    stage = 'admin_patch_and_tick';
    const patch = await patchSettings(api, db, initial, target);
    const patchedAt = Date.now();
    const patched = await recordRound({ name: 'patched', db, index: 1, boundary: firstBoundary + INTERVAL, crond, after: patchedAt, previous: first, timezone: target, revision: patch.timezoneRevision, occurredAt, receivedAt: firstReceived, count: 1 });
    rounds.push(patched);
    assert.equal(await db.siteSetting.findUnique({ where: { key: 'analytics.recompute' } }), null);
    stage = 'restart_and_new_watermark';
    await stop(app);
    assert.ok(exited(app));
    app = startApp(setpriv);
    await healthy(app);
    assert.notEqual(app.pid, appPid);
    const restartAt = Date.now();
    const reread = await readSettings(api);
    assert.deepEqual([reread.version, reread.timezone, reread.timezoneRevision], [patch.version, patch.timezone, patch.timezoneRevision]);
    const secondReceived = await seedFact(db, 'b4-after-restart', occurredAt);
    const restarted = await recordRound({ name: 'restarted', db, index: 2, boundary: firstBoundary + 2 * INTERVAL, crond, after: restartAt, previous: patched, timezone: target, revision: patch.timezoneRevision, occurredAt, receivedAt: secondReceived, count: 2 });
    rounds.push(restarted);
    assert.ok(restarted.sourceThrough > patched.sourceThrough);
    assert.ok(restarted.dailyAggregatedAt > patched.dailyAggregatedAt);
    assert.deepEqual((await readDay(db, first.date, 1)).daily, oldDaily);
    assert.deepEqual(await db.analyticsDaily.findUnique({ where: { localDate_timezoneRevision_dimension: { localDate: historyDate, timezoneRevision: 1, dimension: 'site' } } }), retained);
    stage = 'stopped_window';
    await stop(crond);
    assert.ok(exited(crond));
    const stopped = { at: Date.now(), boundary: firstBoundary + 3 * INTERVAL, tickCount: (await ticks()).length };
    const stoppedJob = await readJob(db);
    const stoppedDay = await readDay(db, restarted.date, restarted.revision);
    assert.equal(stopped.tickCount, 3);
    assert.ok(stopped.at < stopped.boundary);
    await sleep(stopped.boundary + 75_000 - Date.now());
    assert.equal((await ticks()).length, stopped.tickCount);
    assert.deepEqual(await readJob(db), stoppedJob);
    assert.deepEqual(await readDay(db, restarted.date, restarted.revision), stoppedDay);
    stage = 'resumed_true_tick';
    crond = await startCrond(busybox);
    assert.ok(crond.pid);
    await writeFile(path('crond.pid'), String(crond.pid), { mode: 0o600 });
    const resumed = await recordRound({ name: 'resumed', db, index: 3, boundary: stopped.boundary + INTERVAL, crond, after: stopped.boundary + 75_000, previous: restarted, timezone: target, revision: patch.timezoneRevision, occurredAt, receivedAt: secondReceived, count: 2 });
    rounds.push(resumed);
    assert.ok(resumed.dailyAggregatedAt >= restarted.dailyAggregatedAt);
    let guard: Awaited<ReturnType<typeof guardConflict>> | { status: 'not_requested' } | {
      status: 'same_barrier_succeeded'; tick: Tick; round: Round; barrier: Omit<Awaited<ReturnType<typeof atGuardBarrier>>, 'result'>;
    } = { status: 'not_requested' };
    if (mode !== 'schedule') {
      stage = mode === 'with-guard' ? 'rr_write_guard' : 'rr_barrier_control';
      const boundary = stopped.boundary + 2 * INTERVAL;
      const receivedAt = await seedFact(db, 'b4-guard-probe', occurredAt);
      if (mode === 'with-guard') {
        guard = await guardConflict({ db, api, crond, before: resumed, settings: patch, boundary, receivedAt });
      } else {
        const { result: unchanged, ...barrier } = await atGuardBarrier(db, boundary, resumed, () => readSettings(api!));
        assert.deepEqual([unchanged.version, unchanged.timezoneRevision, unchanged.timezone], [patch.version, patch.timezoneRevision, patch.timezone]);
        const round = await recordRound({ name: 'guard-control', db, index: 4, boundary, crond, after: receivedAt.getTime(), previous: resumed, timezone: target, revision: patch.timezoneRevision, occurredAt, receivedAt, count: 3 });
        assert.ok(round.succeeded >= barrier.releasedAt - 1_000 && round.sourceThrough > resumed.sourceThrough && round.dailyAggregatedAt > resumed.dailyAggregatedAt);
        assert.equal(await db.siteSetting.findUnique({ where: { key: 'analytics.recompute' } }), null);
        guard = { status: 'same_barrier_succeeded', tick: round.tick, round, barrier };
      }
    }
    stage = 'report';
    await writeFile(path('result.json'), JSON.stringify({
      pass: true, mode, sourceCommit, sourceTree, buildId, buildSha256, buildMode: 'test', approvedSha256, tools, pgVersionNum: pg[0].server, sharedMemory: pg[0].shm,
      appPids: [appPid, app.pid], patch, retained: { date: historyDate, timezone: retained.timezone, revision: retained.timezoneRevision },
      rounds, stopped, guard,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await writeFile(path('failed-stage.txt'), `${stage}\n`, { mode: 0o600 });
    if (error instanceof Error && ['B4_GUARD_ARM_WINDOW', 'B4_OLD_DELETE_NOT_BLOCKED', 'B4_GUARD_RELEASE_LATE', 'B4_RR_WRITE_GUARD_SQLSTATE_UNPROVEN'].includes(error.message)) {
      await writeFile(path('failed-reason.txt'), `${error.message}\n`, { mode: 0o600 });
    }
    throw new Error(`B4_FAILED_${stage}`);
  } finally {
    const cleaned = await Promise.allSettled([
      stop(crond), stop(app), api?.dispose(), db.$disconnect(), Promise.resolve().then(() => closeAuth?.()),
    ]);
    assert.ok(cleaned.every((result) => result.status === 'fulfilled'), 'B4_CLEANUP_FAILED');
  }
});
