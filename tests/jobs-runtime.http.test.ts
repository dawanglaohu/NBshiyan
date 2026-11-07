// M5-T8 固定作业运行时与 cron 入口的真实 PostgreSQL 验收。
//
// 只在本文件被显式提供 M5T8_TEST_DATABASE_URL（或 DATABASE_URL 且
// M5T8_REQUIRE_DATABASE=true）时执行；CI 尚未接线前不冒充已跑。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { createOperationsHandler, JobDeadlineExceeded, JOB_DEADLINE_MS, JOB_MAX_BATCH, createAnalyticsAggregateJob } from '../src/lib/server/jobs/registry';
import { createJobServices } from '../src/lib/server/composition';
import { AGGREGATE_JOB_KEY } from '../src/lib/server/analytics/aggregate-repo';
import { runAggregateOnce } from '../src/lib/server/analytics/aggregate';
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

after(async () => {
  if (!db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('M5-T8 jobs runtime + cron operations route', { concurrency: false, skip, timeout: 120_000 }, () => {
  before(async () => {
    if (!db) return;
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

  test('cron 模板：五分钟一次 POST operations，仅 analytics-aggregate，55s 超时，不再有旧 rollup 行', () => {
    const cron = readFileSync('deploy/cron.nbshiyan', 'utf8');
    const lines = cron.split(/\r?\n/);
    const aggregate = lines.filter((line) => line.includes('/api/admin/cron/operations'));
    assert.equal(aggregate.length, 1, '必须恰有一条 operations 调度');
    assert.match(aggregate[0]!, /^\*\/5 \* \* \* \* /, '必须是每 5 分钟');
    assert.match(aggregate[0]!, /jobKey:'analytics-aggregate'/);
    assert.match(aggregate[0]!, /AbortSignal\.timeout\(55000\)/);
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
      settingsReader: () => {
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
