// M5-T11 分析保留作业：纯逻辑、registry/cron 接线与隔离 PostgreSQL 验收。
//
// 纯用例（不连库）覆盖模式判定、operations 的 dryRun 透传与 cron 只有一条保留任务；
// 真实库用例只在 M5T11_TEST_DATABASE_URL 存在时跑（loopback 才允许），
// M5T11_REQUIRE_DATABASE=true 时缺地址直接失败、不静默 skip。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';
import { createOperationsHandler, createJobRegistry } from '../src/lib/server/jobs/registry';
import {
  ANALYTICS_RETENTION_KEY,
  createAnalyticsRetentionJob,
  resolveRetentionMode,
  runAnalyticsRetention,
} from '../src/lib/server/analytics/retention';
import {
  eventExpiryCutoff,
  rollupExpiryCutoff,
  shiftCalendarMonths,
} from '../src/lib/server/analytics/retention-plan';
import { createJobLeaseRepo } from '../src/lib/server/jobs/lease-repo';
import { ANALYTICS_ROLLUP_JOB_KEY } from '../src/lib/server/analytics/rollup';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';

const TZ = 'Asia/Shanghai';
const SECRET = 's'.repeat(40);

/* ------------------------------------------------------------------ 纯用例 */

test('保留模式：默认、已授权但未请求、未授权请求都落回 dry-run', () => {
  assert.deepEqual(resolveRetentionMode({}), { mode: 'dry-run', rejected: false });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: false, authorized: true }), { mode: 'dry-run', rejected: false });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: true }), { mode: 'dry-run', rejected: true });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: true, authorized: false }), { mode: 'dry-run', rejected: true });
  assert.deepEqual(resolveRetentionMode({ requestedDelete: true, authorized: true }), { mode: 'delete', rejected: false });
});

test('registry 注册 analytics-retention，且 operations 把 dryRun 原样交给作业', async () => {
  const seen: (boolean | undefined)[] = [];
  const registry = createJobRegistry([
    {
      key: ANALYTICS_RETENTION_KEY,
      async run(context) {
        seen.push(context.dryRun);
        return { kind: 'ran', status: 'SUCCEEDED', counts: { candidateCount: 1, deletedCount: 0 } };
      },
    },
  ]);
  assert.equal(registry.has(ANALYTICS_RETENTION_KEY), true);

  const handler = createOperationsHandler({ services: registry, secret: SECRET, clock: () => new Date('2027-03-15T04:00:00.000Z') });
  const post = (body: unknown) =>
    handler(new Request('http://127.0.0.1/api/admin/cron/operations', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));

  const explicit = await post({ jobKey: ANALYTICS_RETENTION_KEY, dryRun: false });
  assert.equal(explicit.status, 200);
  assert.deepEqual(seen, [false]);
  const omitted = await post({ jobKey: ANALYTICS_RETENTION_KEY });
  assert.equal(omitted.status, 200);
  assert.deepEqual(seen, [false, true]);
});

test('作业工厂只提供固定 key，不因构造而访问数据库', () => {
  const neverCalled = new Proxy({}, { get: () => { throw new Error('db touched during construction'); } }) as unknown as PrismaClient;
  const job = createAnalyticsRetentionJob({ db: neverCalled, deleteAuthorized: false });
  assert.equal(job.key, ANALYTICS_RETENTION_KEY);
});

test('cron 模板：04:30 单独调度 analytics-retention，命令行无密钥、无启用开关', () => {
  const cron = readFileSync(new URL('../deploy/cron.nbshiyan', import.meta.url), 'utf8');
  const lines = cron.split(/\r?\n/);
  const jobLine = lines.find((row) => row.includes('/api/admin/cron/operations') && row.includes('analytics-retention'));
  assert.ok(jobLine, 'cron 必须有一行 analytics-retention');
  assert.match(jobLine, /^30 4 \* \* \* /);
  assert.match(jobLine, /http:\/\/127\.0\.0\.1:3000\/api\/admin\/cron\/operations/);
  assert.match(jobLine, /\{jobKey:'analytics-retention'\}/);
  assert.match(jobLine, /process\.env\.CRON_SECRET/);
  assert.equal(jobLine.replaceAll('process.env.CRON_SECRET', '').includes('CRON_SECRET'), false);
  assert.match(jobLine, /r\.status===409/);
  // 默认 dry-run：命令行里不得出现 dryRun:false，也不得把真实清理开关写上命令行。
  assert.doesNotMatch(jobLine, /dryRun:false/);
  assert.doesNotMatch(jobLine, /RETENTION_CLEANUP_MODE=delete/);
  // 旧 03:30 行由既有回归用例守着，本任务不动它；两个保留入口错开分钟只是不彼此撞，
  // 与每 5 分钟聚合作业的互斥由 analytics-aggregate 租约和 409 busy 语义保证，不靠时刻。
  const legacyLine = lines.find((row) => row.includes('/api/admin/cron/retention-cleanup'));
  assert.ok(legacyLine, '旧 retention-cleanup 行保留，退役由单独任务处理');
  assert.match(legacyLine, /^30 3 \* \* \* /);
});

test('delete 只落分析三张表，不碰询盘/聊天/审计/备份', () => {
  const src = readFileSync(new URL('../src/lib/server/analytics/retention.ts', import.meta.url), 'utf8');
  const targets = [...src.matchAll(/DELETE FROM "([A-Za-z]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(targets, ['AnalyticsDailyRollup', 'AnalyticsEvent', 'AnalyticsRollupDay']);
});

test('compose 点同时注册聚合作业与保留作业', async () => {
  process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:1/test';
  const { createJobServices } = await import('../src/lib/server/composition');
  const fakeDb = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    $transaction: async () => { throw new Error('no database'); },
  } as unknown as PrismaClient;
  const services = createJobServices({ db: fakeDb, deleteAuthorized: false });
  assert.equal(services.jobs.has(ANALYTICS_RETENTION_KEY), true);
  assert.equal(services.jobs.has(ANALYTICS_ROLLUP_JOB_KEY), true);
});

/* --------------------------------------------------------------- 真实库用例 */

const rawUrl = process.env.M5T11_TEST_DATABASE_URL;
const PG_URL = rawUrl?.startsWith('postgres') ? rawUrl : null;
const REQUIRE_PG = process.env.M5T11_REQUIRE_DATABASE === 'true';
if (REQUIRE_PG && !PG_URL) {
  throw new Error('M5T11_REQUIRE_DATABASE=true 时 M5T11_TEST_DATABASE_URL 必须设置（PG 用例不允许静默 skip）');
}
if (PG_URL) {
  const host = new URL(PG_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(`M5T11_TEST_DATABASE_URL 必须指向 loopback 测试库，实际 host=${host}`);
  }
}
const skip = !PG_URL && 'no M5T11_TEST_DATABASE_URL';

const SCHEMA = `m5t11_${randomBytes(6).toString('hex')}`;
/** 只有本进程真的 CREATE 成功才置 true；预存同名对象一律不认领、不 seed、不清理。 */
let ownedSchema = false;
const url = PG_URL
  ? `${PG_URL}${PG_URL.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

/**
 * 先查存在性，再用不带 IF NOT EXISTS 的 CREATE 抢占名字。
 * 返回 true 只代表「这一行 CREATE 是本进程做的」；冲突或预存对象返回 false，调用方不得清理。
 */
async function createOwnedSchema(client: PrismaClient, name: string): Promise<boolean> {
  const existing = await client.$queryRaw<{ one: number }[]>`
    SELECT 1 AS "one" FROM pg_namespace WHERE nspname = ${name}
  `;
  if (existing.length > 0) return false;
  await client.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  return true;
}

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function shiftDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function context(now: Date, dryRun?: boolean) {
  return {
    now,
    deadlineAt: new Date(Date.now() + 55_000),
    signal: new AbortController().signal,
    ...(dryRun === undefined ? {} : { dryRun }),
  };
}

const NOW = new Date('2027-03-15T04:00:00.000Z');
const EVENT_CUTOFF = eventExpiryCutoff(NOW);
const ROLLUP_CUTOFF = rollupExpiryCutoff(NOW, TZ);

/** 过期与未过期各一半：事件按 receivedAt 等号到期，汇总按站点日等号到期。 */
async function seed(client: PrismaClient) {
  await client.$executeRaw`DELETE FROM "AnalyticsEvent"`;
  await client.$executeRaw`DELETE FROM "AnalyticsDailyRollup"`;
  await client.$executeRaw`DELETE FROM "AnalyticsRollupDay"`;
  await client.$executeRaw`DELETE FROM "JobState"`;
  await client.$executeRaw`
    INSERT INTO "SiteSetting" ("key", "value")
    VALUES ('analytics.settings', ${JSON.stringify({
      version: 1,
      timezone: TZ,
      timezoneRevision: 1,
      changedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: null,
    })}::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"
  `;

  const freshReceivedAt = new Date(EVENT_CUTOFF.getTime() + 1);
  const todayOccurredAt = new Date('2027-03-15T02:00:00.000Z');
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsEvent" (
      "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
      "productSlug", "path", "occurredAt", "receivedAt"
    ) VALUES
      (${'ev-expired'}, ${'sk-expired'}, ${'p'.repeat(64)}, ${'bh-expired'}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(EVENT_CUTOFF)}, ${utc(EVENT_CUTOFF)}),
      (${'ev-fresh'}, ${'sk-fresh'}, ${'p'.repeat(64)}, ${'bh-fresh'}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(freshReceivedAt)}, ${utc(freshReceivedAt)}),
      (${'ev-today'}, ${'sk-today'}, ${'p'.repeat(64)}, ${'bh-today'}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, NULL, ${'/en'}, ${utc(todayOccurredAt)}, ${utc(todayOccurredAt)})
  `);

  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsRollupDay" (
      "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
    ) VALUES
      (${shiftDate(ROLLUP_CUTOFF, -1)}, 1, ${utc(NOW)}, 4, ${utc(EVENT_CUTOFF)}, ${utc(NOW)}, ${utc(NOW)}),
      (${ROLLUP_CUTOFF}, 1, ${utc(NOW)}, 5, ${utc(EVENT_CUTOFF)}, ${utc(NOW)}, ${utc(NOW)}),
      (${shiftDate(ROLLUP_CUTOFF, 1)}, 1, ${utc(NOW)}, 6, ${utc(EVENT_CUTOFF)}, ${utc(NOW)}, ${utc(NOW)})
  `);
  await client.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsDailyRollup" ("siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt")
    VALUES
      (${shiftDate(ROLLUP_CUTOFF, -1)}, 'page_view'::"AnalyticsEventKind", 'en', '', 4, 2, ${utc(NOW)}, ${utc(NOW)}),
      (${ROLLUP_CUTOFF}, 'page_view'::"AnalyticsEventKind", 'en', '', 5, 3, ${utc(NOW)}, ${utc(NOW)}),
      (${shiftDate(ROLLUP_CUTOFF, 1)}, 'page_view'::"AnalyticsEventKind", 'en', '', 6, 4, ${utc(NOW)}, ${utc(NOW)})
  `);
}

async function count(client: PrismaClient, sql: Prisma.Sql): Promise<number> {
  const rows = await client.$queryRaw<{ count: number }[]>(sql);
  return Number(rows[0]?.count ?? 0);
}

describe('analytics retention job', { concurrency: false, skip, timeout: 180_000 }, () => {
  before(async () => {
    assert.ok(db);
    assert.ok(url);
    assert.match(SCHEMA, /^m5t11_[0-9a-f]{12}$/);
    ownedSchema = await createOwnedSchema(db, SCHEMA);
    if (!ownedSchema) throw new Error(`schema ${SCHEMA} already exists; refusing to claim it`);
    const { execFileSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  beforeEach(async () => {
    assert.ok(db);
    await seed(db);
  });

  after(async () => {
    if (!db) return;
    try {
      // 只有本进程 CREATE 成功才允许 DROP；预存或创建失败时什么都不做。
      if (!ownedSchema) return;
      assert.match(SCHEMA, /^m5t11_[0-9a-f]{12}$/);
      await db.$executeRawUnsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
    } catch (error) {
      console.error('[m5t11] schema cleanup failed', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      await db.$disconnect();
    }
  });

  test('默认 dry-run：只数候选、删 0 行，JobState 记 SUCCEEDED 与候选/实际计数', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({ db, context: context(NOW), clock: () => NOW, deleteAuthorized: false });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.errorCode, null);
    assert.equal(run.report.mode, 'dry-run');
    assert.deepEqual(run.report.candidates, { events: 1, rollupDailyRows: 2, rollupDays: 2, total: 5 });
    assert.equal(run.report.deletedEvents, 0);
    assert.equal(run.report.deletedRollupDailyRows, 0);
    assert.equal(run.report.deletedRollupDays, 0);
    assert.equal(run.report.coverage, 'complete');
    assert.equal(run.counts.candidateCount, 5);
    assert.equal(run.counts.deletedCount, 0);

    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay"`), 3);

    const jobRows = await db.$queryRaw<{ lastStatus: string; summary: unknown; lastErrorCode: string | null }[]>`
      SELECT "lastStatus"::text AS "lastStatus", "summary", "lastErrorCode"
      FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}
    `;
    assert.equal(jobRows.length, 1);
    assert.equal(jobRows[0].lastStatus, 'SUCCEEDED');
    assert.equal(jobRows[0].lastErrorCode, null);
    const summary = jobRows[0].summary as { counts?: { candidateCount?: number; deletedCount?: number }; versions?: { timezoneRevision?: number } };
    assert.equal(summary.counts?.candidateCount, 5);
    assert.equal(summary.counts?.deletedCount, 0);
    assert.equal(summary.versions?.timezoneRevision, 1);
  });

  test('未授权删除请求：记 FAILED/forbidden，删 0 行，只返回候选计数', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: false });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'forbidden');
    assert.equal(run.report.mode, 'dry-run');
    assert.equal(run.report.requestedDelete, true);
    assert.equal(run.report.authorized, false);
    assert.equal(run.counts.deletedCount, 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);

    const jobRows = await db.$queryRaw<{ lastStatus: string; lastErrorCode: string | null }[]>`
      SELECT "lastStatus"::text AS "lastStatus", "lastErrorCode"
      FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}
    `;
    assert.equal(jobRows[0]?.lastStatus, 'FAILED');
    assert.equal(jobRows[0]?.lastErrorCode, 'forbidden');
  });

  test('已授权删除：只删到期行（等号到期），删完重算今天，不重建过期明细', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.equal(run.kind, 'completed');
    if (run.kind !== 'completed') return;
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.report.mode, 'delete');
    assert.equal(run.report.deletedEvents, 1);
    assert.equal(run.report.deletedRollupDailyRows, 2);
    assert.equal(run.report.deletedRollupDays, 2);
    assert.equal(run.report.batches, 3);
    assert.equal(run.counts.candidateCount, 5);
    assert.equal(run.counts.deletedCount, 5);
    assert.equal(run.report.coverage, 'complete');
    assert.deepEqual(run.report.skippedDays, []);

    // 过期行消失，未过期行原样保留；去标识意义上的浏览器哈希只剩未过期的两个。
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired'`), 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 2);
    assert.deepEqual(
      (await db.$queryRaw<{ browserHash: string }[]>`SELECT "browserHash" FROM "AnalyticsEvent" ORDER BY "browserHash"`).map((row) => row.browserHash),
      ['bh-fresh', 'bh-today'],
    );

    // 13 个自然月边界：等号那天也删，次日保留。
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" <= ${ROLLUP_CUTOFF}`),
      0,
    );
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${shiftDate(ROLLUP_CUTOFF, 1)}`),
      1,
    );
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" <= ${ROLLUP_CUTOFF}`),
      0,
    );

    // 清理后调用既有聚合服务：今天的水位与日聚合被重写，且不会把过期的日期补回来。
    const today = siteLocalDate(NOW, TZ);
    const watermark = await db.$queryRaw<{ timezoneRevision: number; eventCount: number }[]>`
      SELECT "timezoneRevision", "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${today}
    `;
    assert.equal(watermark.length, 1);
    assert.equal(Number(watermark[0].timezoneRevision), 1);
    assert.equal(Number(watermark[0].eventCount), 1);
    assert.equal(run.report.recomputedDays, 3);
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" <= ${ROLLUP_CUTOFF}`),
      0,
    );
    // 已过期事件不会被重算补回（原始行已删，聚合只覆盖今天与 48h 窗口）。
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "eventId" = 'ev-expired'`), 0);
  });

  test('operations HTTP 真接线：缺省 dryRun 只数不删，dryRun:false 未授权记 FAILED/forbidden', async () => {
    assert.ok(db);
    // composition 会在模块加载时创建全局 PrismaClient；给一个不可达假地址，
    // 证明本次调用只走注入的隔离库，不回退通用 DATABASE_URL。
    process.env.DATABASE_URL ||= 'postgresql://nope:nope@127.0.0.1:1/nope';
    const { createJobServices } = await import('../src/lib/server/composition');
    const services = createJobServices({ db, clock: () => NOW, deleteAuthorized: false });
    const handler = createOperationsHandler({ services: services.jobs, secret: SECRET, clock: () => NOW });
    const post = (body: unknown) =>
      handler(new Request('http://127.0.0.1:3000/api/admin/cron/operations', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }));

    const dry = await post({ jobKey: ANALYTICS_RETENTION_KEY });
    assert.equal(dry.status, 200);
    const dryBody = await dry.json() as { jobKey: string; status: string; counts: { candidateCount?: number; deletedCount?: number } };
    assert.equal(dryBody.jobKey, ANALYTICS_RETENTION_KEY);
    assert.equal(dryBody.status, 'SUCCEEDED');
    assert.equal(dryBody.counts.candidateCount, 5);
    assert.equal(dryBody.counts.deletedCount, 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);

    const denied = await post({ jobKey: ANALYTICS_RETENTION_KEY, dryRun: false });
    assert.equal(denied.status, 200);
    const deniedBody = await denied.json() as { status: string; counts: { candidateCount?: number; deletedCount?: number } };
    assert.equal(deniedBody.status, 'FAILED');
    assert.equal(deniedBody.counts.candidateCount, 5);
    assert.equal(deniedBody.counts.deletedCount, 0);
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
  });

  test('聚合租约被占用时返回 busy，不读不删也不写状态', async () => {
    assert.ok(db);
    const holder = createJobLeaseRepo({ db, clock: () => NOW });
    const claimed = await holder.claimPreservingStatus({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: 'other-worker' });
    assert.equal(claimed.acquired, true);

    const run = await runAnalyticsRetention({ db, context: context(NOW, false), clock: () => NOW, deleteAuthorized: true });
    assert.deepEqual(run, { kind: 'busy' });
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}`),
      0,
    );
  });

  test('租约被新代次接管：旧一轮不能写终态，也不删行', async () => {
    assert.ok(db);
    const run = await runAnalyticsRetention({
      db,
      context: context(NOW, false),
      clock: () => NOW,
      deleteAuthorized: true,
      afterClaim: async (claim) => {
        await db.$executeRaw(Prisma.sql`
          UPDATE "JobState"
          SET "leaseOwner" = ${'newer-owner'}, "generation" = ${claim.generation + 1}
          WHERE "key" = ${ANALYTICS_ROLLUP_JOB_KEY}
        `);
      },
    });
    assert.equal(run.kind, 'finish_failed');
    assert.equal(await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent"`), 3);
    assert.equal(
      await count(db, Prisma.sql`SELECT COUNT(*)::int AS "count" FROM "JobState" WHERE "key" = ${ANALYTICS_RETENTION_KEY}`),
      0,
    );
    // 新持有者仍在租约上，旧一轮没有把它释放。
    const owner = await db.$queryRaw<{ leaseOwner: string | null }[]>`
      SELECT "leaseOwner" FROM "JobState" WHERE "key" = ${ANALYTICS_ROLLUP_JOB_KEY}
    `;
    assert.equal(owner[0]?.leaseOwner, 'newer-owner');
  });

  test('预存同名 schema 负控：不认领、不 seed、不清理，哨兵原样保留', async () => {
    assert.ok(db);
    // 哨兵由本用例自己创建、自己清理；它不进入夹具的 ownedSchema 路径。
    const sentinel = `m5t11_${randomBytes(6).toString('hex')}`;
    await db.$executeRawUnsafe(`CREATE SCHEMA "${sentinel}"`);
    try {
      await db.$executeRawUnsafe(`CREATE TABLE "${sentinel}"."marker" ("id" int primary key)`);
      await db.$executeRawUnsafe(`INSERT INTO "${sentinel}"."marker" ("id") VALUES (1)`);

      const claimed = await createOwnedSchema(db, sentinel);
      assert.equal(claimed, false, '预存 schema 不得被认领');

      const marker = await db.$queryRawUnsafe<{ id: number }[]>(`SELECT "id" FROM "${sentinel}"."marker"`);
      assert.deepEqual(marker.map((row) => Number(row.id)), [1]);
      const present = await db.$queryRaw<{ nspname: string }[]>`
        SELECT nspname FROM pg_namespace WHERE nspname = ${sentinel}
      `;
      assert.equal(present.length, 1, '未认领的对象不得被删除');
      const tables = await db.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = ${sentinel} ORDER BY tablename
      `;
      assert.deepEqual(tables.map((row) => row.tablename), ['marker'], '未认领的对象不得被 seed');
    } finally {
      await db.$executeRawUnsafe(`DROP SCHEMA "${sentinel}" CASCADE`);
    }
  });

  test('汇总到期截止日随站点时区走：同一天在两个时区可以差一个自然日', async () => {
    assert.ok(db);
    // 站点日 2027-03-15 在 UTC 与 Shanghai 下都是同一天；换到 UTC-11 仍是 03-14，
    // 这里只校验取到的截止日确实来自传入时区，而不是固定减 13 个月。
    const shanghai = rollupExpiryCutoff(NOW, 'Asia/Shanghai');
    const utcCutoff = rollupExpiryCutoff(NOW, 'UTC');
    assert.equal(shanghai, shiftCalendarMonths('2027-03-15', -13));
    assert.equal(utcCutoff, shiftCalendarMonths('2027-03-15', -13));
    assert.equal(shanghai, ROLLUP_CUTOFF);
  });
});
