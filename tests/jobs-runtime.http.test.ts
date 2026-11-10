// M5-T8 固定作业运行时与 cron 入口的真实 PostgreSQL 验收。
//
// 只在本文件被显式提供 M5T8_TEST_DATABASE_URL（或 DATABASE_URL 且
// M5T8_REQUIRE_DATABASE=true）时执行；CI 尚未接线前不冒充已跑。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';
import { createOperationsHandler, JobDeadlineExceeded, JOB_DEADLINE_MS, JOB_MAX_BATCH, createAnalyticsAggregateJob } from '../src/lib/server/jobs/registry';
import { createJobServices } from '../src/lib/server/composition';
import { AGGREGATE_JOB_KEY } from '../src/lib/server/analytics/aggregate-repo';
import { runAggregateOnce } from '../src/lib/server/analytics/aggregate';
import {
  createAnalyticsSettingsService,
  parseAnalyticsSettingsValue,
  parseRecomputeBacklogStrict,
} from '../src/lib/server/analytics/settings';
import { ANALYTICS_RECOMPUTE_KEY, readSettingsAndBacklog } from '../src/lib/server/analytics/settings-repo';
import { ANALYTICS_SETTINGS_KEY } from '../src/lib/server/jobs/types';
import { createEventsPost } from '../src/app/api/analytics/events/post';
import { createAnalyticsConsentService } from '../src/lib/server/analytics/consent';
import { CONSENT_VERSION } from '../src/lib/consent';
import { loadServerConfig } from '../src/lib/server/config';
import { MemoryStore, setRateLimitStore } from '../src/lib/server/ratelimit';
import { siteLocalDate } from '../src/lib/analytics/day-boundaries';

const base = process.env.M5T8_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SCHEMA = `m5t8_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}`
  : null;
if (process.env.M5T8_REQUIRE_DATABASE === 'true' && !url) {
  throw new Error('M5T8_TEST_DATABASE_URL must be a postgres URL when M5T8_REQUIRE_DATABASE=true');
}
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no M5T8_TEST_DATABASE_URL';
const SECRET = 'm5t8-local-cron-secret-32-characters';
const NOW = new Date('2026-03-01T10:00:00.000Z');
const TZ = 'Asia/Shanghai';

function requireDb(): PrismaClient {
  if (!db) assert.fail('M5-T8 PG 回归必须连真实 PostgreSQL：M5T8_TEST_DATABASE_URL 未设置');
  return db;
}

function post(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) headers.authorization = authorization;
  return new Request('http://127.0.0.1:3000/api/admin/cron/operations', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type JobStateRow = {
  generation: number;
  lastStatus: string;
  leaseOwner: string | null;
  lastErrorCode: string | null;
  lastSucceededAt: string | null;
  lastFinishedAt: string | null;
  lockedUntil: string | null;
};

/** 插入一条“上一轮成功、租约已释放”的 JobState，作为迟到写入的对照基线。 */
async function seedSucceededState(generation: number) {
  const conn = requireDb();
  const started = new Date(NOW.getTime() - 3_600_000).toISOString();
  const succeeded = new Date(NOW.getTime() - 1_800_000).toISOString();
  await conn.$executeRaw`
    INSERT INTO "JobState" (
      "key", "leaseOwner", "generation", "lockedUntil", "lastStartedAt", "lastFinishedAt",
      "lastSucceededAt", "lastStatus", "lastErrorCode", "summary", "createdAt", "updatedAt"
    ) VALUES (
      ${AGGREGATE_JOB_KEY}, NULL, ${generation}, NULL,
      ${started}::timestamptz AT TIME ZONE 'UTC', ${started}::timestamptz AT TIME ZONE 'UTC',
      ${succeeded}::timestamptz AT TIME ZONE 'UTC', ${'SUCCEEDED'}::"JobRunStatus", NULL, NULL,
      ${started}::timestamptz AT TIME ZONE 'UTC', ${started}::timestamptz AT TIME ZONE 'UTC'
    )
  `;
}

async function readJobState(): Promise<JobStateRow> {
  const rows = await requireDb().$queryRaw<JobStateRow[]>`
    SELECT "generation", "lastStatus"::text AS "lastStatus", "leaseOwner", "lastErrorCode",
           to_char("lastSucceededAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSucceededAt",
           to_char("lastFinishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastFinishedAt",
           to_char("lockedUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lockedUntil"
    FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
  `;
  assert.ok(rows.length === 1, 'JobState 行必须存在');
  return rows[0]!;
}

async function ensureSchema() {
  const conn = requireDb();
  await conn.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  const { execFileSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url! },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

after(async () => {
  if (!db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('M5-T8 jobs runtime + cron operations route', { concurrency: false, skip, timeout: 120_000 }, () => {
  before(async () => {
    if (!db) return;
    await ensureSchema();
  });

  async function reset() {
    const conn = requireDb();
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDailyRollup"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsRollupDay"`);
    await conn.$executeRawUnsafe(`DELETE FROM "JobState"`);
    await conn.$executeRawUnsafe(`DELETE FROM "SiteSetting"`);
  }

  function handler() {
    const clock = () => new Date(NOW);
    return createOperationsHandler({
      services: createJobServices({ db: requireDb(), clock }).jobs,
      clock,
      secret: SECRET,
    });
  }

  test('固定 key 与租约：未凭据/错凭据 401，未知 key 与非法体 400，GET 不存在', async () => {
    await reset();
    const handle = handler();
    assert.equal((await handle(post({ jobKey: 'analytics-aggregate' }, null))).status, 401);
    assert.equal((await handle(post({ jobKey: 'analytics-aggregate' }, 'Bearer wrong'))).status, 401);
    assert.equal((await handle(post({ jobKey: 'chat-notifications' }))).status, 400);
    assert.equal((await handle(post({ jobKey: 'arbitrary-script' }))).status, 400);
    assert.equal((await handle(post({ jobKey: 'analytics-aggregate', extra: 1 }))).status, 400);
    const route = await import('../src/app/api/admin/cron/operations/route');
    assert.equal(typeof (route as { GET?: unknown }).GET, 'undefined', '看板/GET 不能触发作业');
    assert.ok(JOB_MAX_BATCH === 500);
    assert.ok(JOB_DEADLINE_MS === 55_000);
  });

  test('成功轮：领取租约、写 JobState 与 watermark，summary 只在白名单内', async () => {
    await reset();
    const conn = requireDb();
    const day = siteLocalDate(NOW, TZ);
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${`ev-${process.pid}`}, ${`sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-1'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
        ${`${day}T01:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC',
        ${`${day}T02:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC'
      )
    `;
    const res = await handler()(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 200);
    const body = await res.json() as { jobKey: string; status: string; counts: { candidateCount?: number }; finishedAt: string };
    assert.equal(body.jobKey, 'analytics-aggregate');
    assert.equal(body.status, 'SUCCEEDED');
    assert.equal(typeof body.finishedAt, 'string');
    assert.ok((body.counts.candidateCount ?? 0) >= 1);

    const state = await conn.$queryRaw<{ generation: number; lastStatus: string; summary: unknown; lastSucceededAt: Date | null }[]>`
      SELECT "generation", "lastStatus"::text AS "lastStatus", "summary", "lastSucceededAt"
      FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
    `;
    assert.equal(state.length, 1);
    assert.equal(state[0]!.lastStatus, 'SUCCEEDED');
    assert.ok(state[0]!.lastSucceededAt !== null);
    assert.deepEqual(Object.keys(state[0]!.summary as Record<string, unknown>).sort(), ['counts', 'times', 'versions']);
    const watermark = await conn.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"
    `;
    assert.ok(Number(watermark[0]!.c) >= 1, '成功轮必须提交 watermark');
  });

  test('租约被占用：返回 409 job_busy，且不改 JobState/水位', async () => {
    await reset();
    const conn = requireDb();
    const until = new Date(NOW.getTime() + 60_000);
    await conn.$executeRaw`
      INSERT INTO "JobState" ("key", "leaseOwner", "generation", "lockedUntil", "lastStartedAt", "lastStatus", "createdAt", "updatedAt")
      VALUES (${AGGREGATE_JOB_KEY}, ${'other-worker'}, ${3}, ${until.toISOString()}::timestamptz AT TIME ZONE 'UTC',
              ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${'RUNNING'}::"JobRunStatus",
              ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    `;
    const res = await handler()(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 409);
    const state = await conn.$queryRaw<{ generation: number; owner: string }[]>`
      SELECT "generation", "leaseOwner" AS "owner" FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
    `;
    assert.equal(Number(state[0]!.generation), 3, '忙时不得推进代次');
    assert.equal(state[0]!.owner, 'other-worker', '忙时不得改租约 owner');
  });

  test('版本冲突：作业 FAILED，上一次成功 watermark 原样保留（不被覆盖）', async () => {
    await reset();
    const conn = requireDb();
    const day = siteLocalDate(NOW, TZ);
    // 已存的日聚合时区代次高于本轮（1），M5-T3 的版本校验必须让整组回滚。
    await conn.$executeRaw`
      INSERT INTO "AnalyticsRollupDay" ("siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt")
      VALUES (${day}, ${9}, ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${7}, NULL,
              ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${NOW.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    `;
    const before = await conn.$queryRaw<{ siteDate: string; timezoneRevision: number; eventCount: number }[]>`
      SELECT "siteDate", "timezoneRevision", "eventCount" FROM "AnalyticsRollupDay" ORDER BY "siteDate"
    `;
    const res = await handler()(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'FAILED');
    const afterRows = await conn.$queryRaw<{ siteDate: string; timezoneRevision: number; eventCount: number }[]>`
      SELECT "siteDate", "timezoneRevision", "eventCount" FROM "AnalyticsRollupDay" ORDER BY "siteDate"
    `;
    assert.deepEqual(afterRows, before, '失败轮不得覆盖上一次成功 watermark');
    const state = await conn.$queryRaw<{ lastStatus: string; lastErrorCode: string | null }[]>`
      SELECT "lastStatus"::text AS "lastStatus", "lastErrorCode" FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
    `;
    assert.equal(state[0]!.lastStatus, 'FAILED');
    assert.equal(state[0]!.lastErrorCode, 'version_conflict');
  });

  test('cron 模板：五分钟一次且仅一条 analytics-aggregate operations，55s 超时，不再有旧 rollup 行', () => {
    const cron = readFileSync('deploy/cron.nbshiyan', 'utf8');
    const lines = cron.split(/\r?\n/);
    const operations = lines.filter((line) => line.includes('/api/admin/cron/operations'));
    const aggregate = operations.filter((line) => line.includes("jobKey:'analytics-aggregate'"));
    assert.equal(aggregate.length, 1, '必须恰有一条 analytics-aggregate 的 operations 调度');
    assert.match(aggregate[0]!, /^\*\/5 \* \* \* \* /, '必须是每 5 分钟');
    assert.match(aggregate[0]!, /AbortSignal\.timeout\(55000\)/);
    // 窄负控：复制一行聚合调度后计数必须变成 2；防止把唯一性退成“至少一条”。
    assert.equal(
      [...operations, aggregate[0]!].filter((line) => line.includes("jobKey:'analytics-aggregate'")).length,
      2,
      '负控：重复的 analytics-aggregate operations 行必须被计数',
    );
    assert.equal(lines.some((line) => line.includes('/api/admin/cron/analytics-rollup')), false, '不能双写旧 rollup');
    assert.equal(
      lines.some((line) => line.includes('/api/admin/cron/retention-cleanup')),
      true,
      '原有清理调度保持',
    );
  });

  test('预算不足：handler 映射 503 job_timeout，不写 JobState', async () => {
    await reset();
    const fakeServices = {
      has: () => true,
      keys: () => ['analytics-aggregate'],
      run: async () => {
        throw new JobDeadlineExceeded();
      },
    };
    const res = await createOperationsHandler({
      services: fakeServices as never,
      clock: () => new Date(NOW),
      secret: SECRET,
    })(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: string }).error, 'job_timeout');
    const rows = await requireDb().$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "JobState"`;
    assert.equal(Number(rows[0]!.c), 0, '预算不足不得先写 JobState');
  });

  test('预算不足：作业在领取租约前拒绝，不写 JobState', async () => {
    await reset();
    const job = createAnalyticsAggregateJob({ db: requireDb(), clock: () => new Date(NOW) });
    await assert.rejects(
      () => job.run({
        now: new Date(NOW),
        deadlineAt: new Date(Date.now() - 1),
        signal: new AbortController().signal,
      }),
      /job_deadline_exceeded/,
    );
    const rows = await requireDb().$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "JobState"`;
    assert.equal(Number(rows[0]!.c), 0);
  });

  test('租约在提交事务内失效：整组回滚，不写 watermark，也不返回 SUCCEEDED', async () => {
    await reset();
    const conn = requireDb();
    const day = siteLocalDate(NOW, TZ);
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${`lease-${process.pid}`}, ${`lease-sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-lease'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
        ${`${day}T01:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC',
        ${`${day}T02:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC'
      )
    `;
    // 前两次取时（claim）用基准时刻，之后每次（complete）跳 120s，使租约在提交事务内已过期。
    let calls = 0;
    const base = NOW.getTime();
    const advancing = () => new Date(base + (calls++ >= 2 ? 120_000 : 0));
    const res = await createOperationsHandler({
      services: createJobServices({ db: conn, clock: advancing }).jobs,
      clock: () => new Date(NOW),
      secret: SECRET,
    })(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 500, 'FAILED 没有写进数据库时不能返回 200');
    assert.equal((await res.json() as { error: string }).error, 'job_failed');
    const watermark = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"`;
    assert.equal(Number(watermark[0]!.c), 0, '提交守卫失败必须整组回滚，不留下新 watermark');
    const daily = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup"`;
    assert.equal(Number(daily[0]!.c), 0, '汇总行也必须一起回滚');
    const state = await readJobState();
    assert.equal(state.lastStatus, 'RUNNING', '终态未落库：保持已领取的 RUNNING，等租约自然到期');
    assert.equal(state.leaseOwner, 'analytics-job-runtime', '不得假释放租约');
  });

  test('claim 成功后设置读取抛错：FAILED 在预算内落库，不写 watermark', async () => {
    await reset();
    const conn = requireDb();
    const job = createAnalyticsAggregateJob({
      db: conn,
      clock: () => new Date(NOW),
      reader: () => {
        throw new Error('settings_read_failed');
      },
    });
    const outcome = await job.run({
      now: new Date(NOW),
      deadlineAt: new Date(Date.now() + 30_000),
      signal: new AbortController().signal,
    });
    assert.deepEqual(outcome, { kind: 'ran', status: 'FAILED', counts: { candidateCount: 0 } });
    const state = await readJobState();
    assert.equal(state.lastStatus, 'FAILED', '读取失败必须落成 FAILED');
    assert.equal(state.lastErrorCode, 'service_unavailable');
    assert.equal(state.leaseOwner, null, 'FAILED 必须释放租约');
    const watermark = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"`;
    assert.equal(Number(watermark[0]!.c), 0, '设置读取失败不得写 watermark');
  });

  test('claim 行锁等待跨过截止：超时返回，截止后不补写 JobState', async () => {
    await reset();
    const conn = requireDb();
    await seedSucceededState(5);
    const before = await readJobState();
    // 并发事务持有该行 4.5s：claim 的 upsert 必须排队，不能用未设预算的语句一直等下去。
    const holder = conn.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "generation" FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY} FOR UPDATE`;
      await sleep(4_500);
    }, { maxWait: 5_000, timeout: 20_000 });
    await sleep(150);
    const job = createAnalyticsAggregateJob({ db: conn, clock: () => new Date() });
    const startedAt = Date.now();
    await assert.rejects(
      () => job.run({
        now: new Date(),
        deadlineAt: new Date(startedAt + 3_000),
        signal: new AbortController().signal,
      }),
      /job_deadline_exceeded/,
    );
    assert.ok(Date.now() - startedAt < 2_900, `必须在截止前返回，实际 ${Date.now() - startedAt}ms`);
    await holder.catch(() => {});
    await sleep(600);
    assert.deepEqual(await readJobState(), before, '截止后不得补写 claim/FAILED，原成功状态保持');
  });

  test('聚合被锁阻塞跨过截止：handler 503，截止后无迟到 JobState 写入', async () => {
    await reset();
    const conn = requireDb();
    await seedSucceededState(5);
    // 表级锁让聚合的第一次读取真阻塞，模拟提交/聚合跨过截止。
    const holder = conn.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "AnalyticsEvent" IN ACCESS EXCLUSIVE MODE');
      await sleep(3_000);
    }, { maxWait: 5_000, timeout: 20_000 });
    await sleep(150);
    const res = await createOperationsHandler({
      services: createJobServices({ db: conn, clock: () => new Date() }).jobs,
      clock: () => new Date(),
      secret: SECRET,
      deadlineMs: 1_200,
    })(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: string }).error, 'job_timeout');
    const atDeadline = await readJobState();
    assert.equal(atDeadline.lastStatus, 'RUNNING', '预算耗尽后停在已领取的 RUNNING，等租约到期');
    assert.equal(Number(atDeadline.generation), 6);
    await holder.catch(() => {});
    await sleep(800);
    assert.deepEqual(await readJobState(), atDeadline, '截止后不得晚写 FAILED，也不得晚释放租约');
    const watermark = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"`;
    assert.equal(Number(watermark[0]!.c), 0, '阻塞中的聚合不得提交 watermark');
  });

  test('终态未持久化：handler 返回 500 job_failed，不冒充 FAILED', async () => {
    await reset();
    const fakeServices = {
      has: () => true,
      keys: () => ['analytics-aggregate'],
      run: async () => ({ kind: 'finish_failed' as const }),
    };
    const res = await createOperationsHandler({
      services: fakeServices as never,
      clock: () => new Date(NOW),
      secret: SECRET,
    })(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 500);
    assert.equal((await res.json() as { error: string }).error, 'job_failed');
  });

  test('提交钩子失败：聚合整组回滚，不留下 watermark', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, 'UTC');
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${`hook-${process.pid}`}, ${`hook-sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-hook'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
        ${`${day}T01:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC',
        ${`${day}T02:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC'
      )
    `;
    await assert.rejects(() => runAggregateOnce({
      db: conn,
      now,
      siteTimezone: 'UTC',
      currentDate: day,
      timezoneRevision: 1,
      generation: 1,
      commit: async () => {
        throw new Error('commit_failed');
      },
    }));
    const daily = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup"`;
    const days = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"`;
    assert.equal(Number(daily[0]!.c), 0);
    assert.equal(Number(days[0]!.c), 0);
  });

  test('claim 期设置损坏：安全失败（500 job_failed），不写 watermark', async () => {
    await reset();
    const conn = requireDb();
    await conn.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value") VALUES (${'analytics.settings'}, ${'{"broken":true}'}::jsonb)
    `;
    const res = await handler()(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 500);
    assert.equal((await res.json() as { error: string }).error, 'job_failed');
    const watermark = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"`;
    assert.equal(Number(watermark[0]!.c), 0);
  });
});

// ---------------------------------------------------------------------------
// M5-T4：pending 分类（absent/corrupt/stale/future/planned）、同一 RR 事务内的
// 完整值 CAS 消费，以及读取后并发 PATCH 的版本回滚。全部真 Prisma + 真 JobState。
// ---------------------------------------------------------------------------

describe('M5-T4 pending 分类与完整值 CAS 消费', { concurrency: false, skip, timeout: 120_000 }, () => {
  const BASE = new Date('2026-03-01T10:00:00.000Z');
  const settingsJson = (over: Record<string, unknown> = {}) => JSON.stringify({
    version: 0, timezone: 'UTC', timezoneRevision: 1,
    changedAt: BASE.toISOString(), updatedBy: null, ...over,
  });
  const backlogJson = (over: Record<string, unknown> = {}) => JSON.stringify({
    timezoneRevision: 1, timezone: 'UTC', recomputableFrom: '2026-02-24T00:00:00.000Z',
    requestedAt: BASE.toISOString(), updatedBy: 'admin-a', status: 'pending', ...over,
  });

  async function reset() {
    const conn = requireDb();
    for (const table of ['AnalyticsEvent', 'AnalyticsDailyRollup', 'AnalyticsRollupDay', 'JobState', 'SiteSetting']) {
      await conn.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
    await conn.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = 'm5t4-admin'`);
  }

  async function seedSettings(value: string) {
    await requireDb().$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value") VALUES (${ANALYTICS_SETTINGS_KEY}, ${value}::jsonb)
    `;
  }

  async function seedBacklog(value: string) {
    await requireDb().$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value") VALUES (${ANALYTICS_RECOMPUTE_KEY}, ${value}::jsonb)
    `;
  }

  async function readBacklog(): Promise<string | null> {
    const rows = await requireDb().$queryRaw<{ value: string }[]>`
      SELECT "value"::text AS "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_RECOMPUTE_KEY}
    `;
    return rows[0]?.value ?? null;
  }

  async function jobState(): Promise<{ lastStatus: string; lastErrorCode: string | null }> {
    const rows = await requireDb().$queryRaw<{ lastStatus: string; lastErrorCode: string | null }[]>`
      SELECT "lastStatus"::text AS "lastStatus", "lastErrorCode" FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}
    `;
    assert.equal(rows.length, 1);
    return rows[0]!;
  }

  async function rollupCount(): Promise<number> {
    const rows = await requireDb().$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"`;
    return Number(rows[0]!.c);
  }

  function runJob(extra: Partial<Parameters<typeof createAnalyticsAggregateJob>[0]> = {}) {
    const job = createAnalyticsAggregateJob({ db: requireDb(), clock: () => new Date(BASE), ...extra });
    return job.run({ now: new Date(BASE), deadlineAt: new Date(Date.now() + 30_000), signal: new AbortController().signal });
  }

  async function captureLogs<T>(run: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    try {
      return { value: await run(), logs };
    } finally {
      console.error = original;
    }
  }

  after(async () => {
    if (!db) return;
    await reset();
  });

  test('R1 planned：backlog 在同一事务内按完整值删除，JobState SUCCEEDED，重复跑不再消费', async () => {
    await reset();
    await seedSettings(settingsJson());
    await seedBacklog(backlogJson());
    const outcome = await runJob();
    assert.equal(outcome.kind, 'ran');
    if (outcome.kind !== 'ran') assert.fail('job did not run');
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.equal(await readBacklog(), null, 'CAS 命中后待办消失');
    assert.equal((await jobState()).lastStatus, 'SUCCEEDED');
    const again = await runJob();
    assert.equal(again.kind, 'ran');
    if (again.kind !== 'ran') assert.fail('job did not rerun');
    assert.equal(again.status, 'SUCCEEDED');
    assert.equal(await readBacklog(), null);
  });

  test('R4 读后外部改写同 revision 字段：CAS 0 行只记 consume_miss，待办不删，聚合仍 SUCCEEDED', async () => {
    await reset();
    await seedSettings(settingsJson());
    await seedBacklog(backlogJson());
    const conn = requireDb();
    const reader = async (tx: Prisma.TransactionClient) => {
      const raw = await readSettingsAndBacklog(tx);
      const settings = parseAnalyticsSettingsValue(raw.settings);
      const backlog = parseRecomputeBacklogStrict(raw.backlog);
      await conn.$executeRaw`
        UPDATE "SiteSetting" SET "value" = jsonb_set("value", '{note}', '"external"')
        WHERE "key" = ${ANALYTICS_RECOMPUTE_KEY}
      `;
      return { settings, backlog };
    };
    const { value: outcome, logs } = await captureLogs(() => runJob({ reader }));
    assert.equal(outcome.kind, 'ran');
    if (outcome.kind !== 'ran') assert.fail('job did not run');
    assert.equal(outcome.status, 'SUCCEEDED');
    const stored = JSON.parse((await readBacklog())!) as { note?: string; status?: string };
    assert.equal(stored.note, 'external', '外部改写后的待办不得被删除');
    assert.equal(stored.status, 'pending');
    assert.ok(logs.some((line) => line.includes('analytics.recompute_consume_miss')), JSON.stringify(logs));
  });

  test('R5 坏 JSON/缺字段：不消费、待办保留、正常 SUCCEEDED 并记录 corrupt', async () => {
    await reset();
    await seedBacklog(JSON.stringify({ timezoneRevision: 1, timezone: 'UTC' }));
    const { value: outcome, logs } = await captureLogs(() => runJob());
    assert.equal(outcome.kind, 'ran');
    if (outcome.kind !== 'ran') assert.fail('job did not run');
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.ok(await readBacklog(), '坏待办不得被删除');
    assert.ok(logs.some((line) => line.includes('analytics.recompute_backlog_unusable') && line.includes('corrupt')), JSON.stringify(logs));
  });

  test('R6 stale revision：不消费、待办保留并记录 stale', async () => {
    await reset();
    await seedBacklog(backlogJson({ timezoneRevision: 2 }));
    const { value: outcome, logs } = await captureLogs(() => runJob());
    assert.equal(outcome.kind, 'ran');
    if (outcome.kind !== 'ran') assert.fail('job did not run');
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.ok(await readBacklog());
    assert.ok(logs.some((line) => line.includes('analytics.recompute_backlog_unusable') && line.includes('stale')), JSON.stringify(logs));
  });

  test('R7 future floor：不消费、不属于本轮计划，待办保留并记录 floor_future', async () => {
    await reset();
    await seedBacklog(backlogJson({ recomputableFrom: '2026-03-02T00:00:00.000Z' }));
    const { value: outcome, logs } = await captureLogs(() => runJob());
    assert.equal(outcome.kind, 'ran');
    if (outcome.kind !== 'ran') assert.fail('job did not run');
    assert.equal(outcome.status, 'SUCCEEDED');
    assert.deepEqual(JSON.parse((await readBacklog())!), {
      timezoneRevision: 1, timezone: 'UTC', recomputableFrom: '2026-03-02T00:00:00.000Z',
      requestedAt: BASE.toISOString(), updatedBy: 'admin-a', status: 'pending',
    }, '未来 floor 不得被消费');
    assert.ok(logs.some((line) => line.includes('analytics.recompute_floor_future')), JSON.stringify(logs));
  });

  test('R3 读取后并发 PATCH：complete 版本守卫失败，聚合整组回滚，新待办保留', async () => {
    await reset();
    const conn = requireDb();
    await conn.user.create({
      data: { id: 'm5t4-admin', email: 'm5t4-admin@example.com', name: 'M5', passwordHash: 'x', role: 'ADMIN' },
    });
    await seedSettings(settingsJson());
    await seedBacklog(backlogJson());
    const reader = async (tx: Prisma.TransactionClient) => {
      const raw = await readSettingsAndBacklog(tx);
      const settings = parseAnalyticsSettingsValue(raw.settings);
      const backlog = parseRecomputeBacklogStrict(raw.backlog);
      // 读取后、提交前，另一个真实 PATCH 把 revision+1 并写入新待办。
      await createAnalyticsSettingsService({ db: conn, clock: () => new Date(BASE) })
        .update({ userId: 'm5t4-admin' }, { timezone: 'Asia/Tokyo', expectedVersion: 0 });
      return { settings, backlog };
    };
    const outcome = await runJob({ reader });
    assert.notEqual(outcome.kind === 'ran' ? outcome.status : 'RUNNING', 'SUCCEEDED');
    assert.equal(await rollupCount(), 0, '版本冲突不得留下聚合行');
    const stored = JSON.parse((await readBacklog())!) as { timezoneRevision: number; timezone: string };
    assert.equal(stored.timezoneRevision, 2);
    assert.equal(stored.timezone, 'Asia/Tokyo');
    assert.notEqual((await jobState()).lastStatus, 'SUCCEEDED');
  });

  test('R2 聚合与待办 CAS 之后提交失败：DELETE 已执行但整组回滚，待办完整保留、无水位、JobState 不 SUCCEEDED', async () => {
    await reset();
    const conn = requireDb();
    const day = '2026-02-24';
    await seedSettings(settingsJson());
    await seedBacklog(backlogJson());
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${`r2-${process.pid}`}, ${`r2-sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-r2'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
        ${`${day}T01:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC',
        ${`${day}T02:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC'
      )
    `;
    const originalBacklog = (await readBacklog())!;

    // 记录事务内 CAS DELETE 实际执行与命中行数；不改 Prisma 行为，只在测试注入的客户端上旁路观测。
    const casDeletes: number[] = [];
    const observedDb = new Proxy(conn, {
      get(target, prop) {
        if (prop === '$transaction') {
          return (fn: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) =>
            target.$transaction((tx) => {
              const wrapped = new Proxy(tx, {
                get(txTarget, txProp) {
                  const value = Reflect.get(txTarget, txProp, txTarget) as unknown;
                  if (typeof value !== 'function') return value;
                  if (txProp === '$executeRaw') {
                    return async (strings: TemplateStringsArray, ...values: unknown[]) => {
                      const removed = await (value as (...args: unknown[]) => Promise<number>).call(txTarget, strings, ...values);
                      if (strings.join('?').includes('DELETE FROM "SiteSetting"')) casDeletes.push(Number(removed));
                      return removed;
                    };
                  }
                  return (value as (...args: unknown[]) => unknown).bind(txTarget);
                },
              });
              return fn(wrapped as Prisma.TransactionClient);
            }, options);
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as PrismaClient;

    // 前两次取时（claim）用基准时刻，之后（CAS 后的 complete）跳 120s，使租约在提交事务内过期。
    let calls = 0;
    const base = BASE.getTime();
    const advancing = () => new Date(base + (calls++ >= 2 ? 120_000 : 0));
    const outcome = await createAnalyticsAggregateJob({ db: observedDb, clock: advancing }).run({
      now: new Date(BASE),
      deadlineAt: new Date(Date.now() + 30_000),
      signal: new AbortController().signal,
    });
    assert.notEqual(outcome.kind === 'ran' ? outcome.status : 'RUNNING', 'SUCCEEDED');
    assert.deepEqual(casDeletes, [1], 'CAS DELETE 必须在提交失败前执行并命中完整待办');
    assert.equal(await readBacklog(), originalBacklog, '失败回滚后完整六字段待办必须原样保留');
    assert.equal(await rollupCount(), 0, '聚合水位不得留下');
    const daily = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup"`;
    assert.equal(Number(daily[0]!.c), 0, '日聚合行不得留下');
    assert.equal((await jobState()).lastStatus, 'RUNNING', '终态未持久化：保持已领取的 RUNNING，不冒 SUCCEEDED');
  });

  test('R8 planned 待办 + 有界锁阻塞：真实入口 503 job_timeout，收束后无部分聚合、待办完整、无迟到成功', async () => {
    await reset();
    const conn = requireDb();
    const day = '2026-02-24';
    await seedSettings(settingsJson());
    await seedBacklog(backlogJson());
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${`r8-${process.pid}`}, ${`r8-sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-r8'},
        ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
        ${`${day}T01:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC',
        ${`${day}T02:00:00.000Z`}::timestamptz AT TIME ZONE 'UTC'
      )
    `;
    const originalBacklog = (await readBacklog())!;

    // 表级锁让聚合的第一次读取真阻塞跨过截止；作业入口、预算与实现都走真实代码。
    // 预算留足 claim 的时间，确保超时发生在聚合阶段而不是领取阶段。
    const holder = conn.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "AnalyticsEvent" IN ACCESS EXCLUSIVE MODE');
      await sleep(6_000);
    }, { maxWait: 5_000, timeout: 20_000 });
    await sleep(200);
    const res = await createOperationsHandler({
      services: createJobServices({ db: conn, clock: () => new Date(BASE) }).jobs,
      clock: () => new Date(BASE),
      secret: SECRET,
      deadlineMs: 4_000,
    })(post({ jobKey: 'analytics-aggregate' }));
    assert.equal(res.status, 503);
    assert.equal((await res.json() as { error: string }).error, 'job_timeout');

    const atDeadline = await jobState();
    assert.equal(atDeadline.lastStatus, 'RUNNING', '预算耗尽后停在已领取的 RUNNING，等租约到期');
    assert.equal(await rollupCount(), 0, '阻塞中的聚合不得提交水位');
    assert.equal(await readBacklog(), originalBacklog, '超时未执行 CAS，完整待办必须保留');

    await holder.catch(() => {});
    await sleep(1_500);
    assert.deepEqual(await jobState(), atDeadline, '截止后不得晚写终态，也不得晚释放租约');
    assert.equal(await rollupCount(), 0);
    const daily = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup"`;
    assert.equal(Number(daily[0]!.c), 0);
    assert.equal(await readBacklog(), originalBacklog);
  });
});


const CONSENT_SECRET = Buffer.from('b'.repeat(32));
const EDGE_AUTH = 'e'.repeat(32);
const B5_NOW = '2026-06-15T12:00:00.000Z';
const B5_CONFIG = loadServerConfig({ APP_ENV: 'test' });
const B5_ENV = { APP_ENV: 'test', EDGE_AUTH_SECRET: EDGE_AUTH };

type IngestResult = { status: number; text: string; body: unknown };

describe('M5-T8 B5 事件入口 → 聚合作业（E-44 去重 / E-60 时间边界）', { concurrency: false, skip, timeout: 120_000 }, () => {
  let server: http.Server | undefined;
  let port = 0;
  let ingestNow = new Date(B5_NOW);
  let consentCookie = '';

  function grantCookie(): string {
    const outcome = createAnalyticsConsentService({ secret: CONSENT_SECRET, clock: () => ingestNow })
      .apply({ analytics: true, consentVersion: CONSENT_VERSION, secure: false });
    if (!outcome.ok) throw new Error(`consent:${outcome.code}`);
    return outcome.setCookie.split(';', 1)[0]!;
  }

  function eventPost(json: unknown): Promise<IngestResult> {
    const payload = Buffer.from(JSON.stringify(json));
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/analytics/events',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          'x-edge-auth': EDGE_AUTH,
          origin: `http://127.0.0.1:${port}`,
          cookie: consentCookie,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = text; }
          resolve({ status: res.statusCode ?? 0, text, body });
        });
      });
      req.setTimeout(15_000, () => req.destroy(new Error('events http timeout')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  function pageView(occurredAt: Date, eventId: string = randomUUID(), navigationId: string = randomUUID()) {
    return { kind: 'page_view', eventId, navigationId, occurredAt: occurredAt.toISOString(), locale: 'en', path: '/en' };
  }

  async function runJob(at: Date) {
    const job = createAnalyticsAggregateJob({ db: requireDb(), clock: () => at });
    return job.run({ now: at, deadlineAt: new Date(Date.now() + 30_000), signal: new AbortController().signal });
  }

  function expectSucceeded(outcome: Awaited<ReturnType<typeof runJob>>) {
    assert.equal(outcome.kind, 'ran', '作业必须实际执行');
    if (outcome.kind !== 'ran') assert.fail('job did not run');
    assert.equal(outcome.status, 'SUCCEEDED');
  }

  async function pageViewRollup(siteDate: string) {
    const rows = await requireDb().$queryRaw<{ count: number; uniqueBrowsers: number }[]>`
      SELECT "count", "uniqueBrowsers" FROM "AnalyticsDailyRollup"
      WHERE "siteDate" = ${siteDate}
        AND "kind" = ${'page_view'}::"AnalyticsEventKind"
        AND "locale" = ${'en'}
        AND "productSlug" = ${''}
    `;
    return rows[0] ?? null;
  }

  before(async () => {
    if (!db) return;
    await ensureSchema();
    const handler = createEventsPost({
      db: requireDb(),
      config: B5_CONFIG,
      clock: () => ingestNow,
      env: B5_ENV,
      secret: CONSENT_SECRET,
    });
    server = http.createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else headers.set(key, value);
        }
        const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
          method: req.method,
          headers,
          body: body.length > 0 ? body : undefined,
        });
        const response = await handler(request);
        res.statusCode = response.status;
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') res.setHeader(key, value);
        });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!res.headersSent) res.statusCode = 500;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', () => resolve()); });
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    setRateLimitStore(undefined);
    await new Promise<void>((resolve) => {
      if (!server) { resolve(); return; }
      server.close(() => resolve());
    });
  });

  beforeEach(async () => {
    if (!db) return;
    const conn = requireDb();
    for (const table of ['AnalyticsEvent', 'AnalyticsDailyRollup', 'AnalyticsRollupDay', 'JobState', 'SiteSetting']) {
      await conn.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
    setRateLimitStore(new MemoryStore());
    ingestNow = new Date(B5_NOW);
    consentCookie = grantCookie();
  });

  test('E-60：四时间边界经真实入口准入，未到 occurredAt 的未来事件不提前计入', async () => {
    const conn = requireDb();
    const now = new Date(B5_NOW);
    const tooOld = new Date(now.getTime() - 48 * 60 * 60 * 1000 - 1);
    const oldest = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 5 * 60 * 1000);
    const tooFuture = new Date(future.getTime() + 1);
    const ids: string[] = [];
    for (const entry of [
      { at: tooOld, status: 400 },
      { at: oldest, status: 200 },
      { at: future, status: 200 },
      { at: tooFuture, status: 400 },
    ]) {
      const eventId = randomUUID();
      ids.push(eventId);
      const res = await eventPost({ events: [pageView(entry.at, eventId)] });
      assert.equal(res.status, entry.status, res.text);
      if (entry.status === 400) assert.equal((res.body as { error: string }).error, 'event_time_out_of_range');
    }
    const stored = await conn.$queryRaw<{ eventId: string }[]>`SELECT "eventId" FROM "AnalyticsEvent" ORDER BY "eventId"`;
    assert.deepEqual(stored.map((row) => row.eventId).sort(), [ids[1]!, ids[2]!].sort(), '超界两项不得留下记录');

    // 作业时钟仍在 now：48h 边界事件计入所属日；+5min 的未来事件不得提前计入。
    expectSucceeded(await runJob(now));
    assert.deepEqual(await pageViewRollup('2026-06-13'), { count: 1, uniqueBrowsers: 1 });
    assert.equal(await pageViewRollup('2026-06-15'), null, '未到 occurredAt 的未来事件不得计入');

    // 48h 内迟到事件：只重算其所属日，其他日保持原值。
    assert.equal((await eventPost({ events: [pageView(new Date(now.getTime() - 47 * 60 * 60 * 1000))] })).status, 200);
    expectSucceeded(await runJob(new Date(now.getTime() + 2 * 60 * 1000)));
    assert.deepEqual(await pageViewRollup('2026-06-13'), { count: 2, uniqueBrowsers: 1 }, '迟到事件只影响所属日');
    assert.equal(await pageViewRollup('2026-06-15'), null);

    // 作业时钟到 +5min：未来事件到点后才计入。
    expectSucceeded(await runJob(new Date(future.getTime())));
    assert.deepEqual(await pageViewRollup('2026-06-15'), { count: 1, uniqueBrowsers: 1 });

    // 不造未来日：所有日聚合的 siteDate 都不晚于当前站点日。
    const futureDays = await conn.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" > ${'2026-06-15'}
    `;
    assert.equal(Number(futureDays[0]!.c), 0, '不得写未来日');
  });

  test('E-44：同浏览器两次新访问 PV 增加、UV 仍 1，同 eventId 重试不增加', async () => {
    const conn = requireDb();
    const now = new Date(B5_NOW);
    const firstId = randomUUID();
    const firstEvent = pageView(now, firstId);
    assert.equal((await eventPost({ events: [firstEvent] })).status, 200);
    assert.equal((await eventPost({ events: [pageView(now)] })).status, 200);
    expectSucceeded(await runJob(now));
    assert.deepEqual(await pageViewRollup('2026-06-15'), { count: 2, uniqueBrowsers: 1 });

    // 刷新/重试同一 eventId：浏览器重发的是同一份载荷，入口接受但不新增原始行。
    assert.equal((await eventPost({ events: [firstEvent] })).status, 200);
    const stored = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsEvent"`;
    assert.equal(Number(stored[0]!.c), 2, '同一 eventId 重试不得新增原始行');
    expectSucceeded(await runJob(new Date(now.getTime() + 2 * 60 * 1000)));
    assert.deepEqual(await pageViewRollup('2026-06-15'), { count: 2, uniqueBrowsers: 1 }, '重复事件不增加 PV/UV');

    // 真实的新访问才增加 PV；UV 仍是同一浏览器。
    assert.equal((await eventPost({ events: [pageView(new Date(now.getTime() + 3 * 60 * 1000))] })).status, 200);
    expectSucceeded(await runJob(new Date(now.getTime() + 4 * 60 * 1000)));
    assert.deepEqual(await pageViewRollup('2026-06-15'), { count: 3, uniqueBrowsers: 1 });
  });
});
