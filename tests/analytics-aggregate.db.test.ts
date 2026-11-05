// M5-T3 一致快照聚合在隔离 schema 的真实 PostgreSQL 上验收。
//
// 本文件被 CI 的「Analytics, chat, and other PostgreSQL regressions」步骤纳入
// 按文件门禁（wanted / 命令行 / gate.files 三处）。因此：
//   - 缺 DATABASE_URL 时每个用例具名 assert.fail，不整组 skip；
//     门禁看到 fail>0 或 skip>0 即判失败，杜绝「没库却报绿」。
//   - 每个用例都连真实库、真事务、真行锁，验证 generation 互斥与整组原子替换。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { LATE_ARRIVAL_MS, planSnapshot } from '../src/lib/analytics/aggregate-plan';
import { aggregateOneDayInSnapshot, runAggregateOnce, AggregateVersionConflict } from '../src/lib/server/analytics/aggregate';
import { loadEventsAtSnapshot, AGGREGATE_JOB_KEY, upsertWatermarkGuarded } from '../src/lib/server/analytics/aggregate-repo';

const base = process.env.DATABASE_URL;
const SCHEMA = `aggregate_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

const TZ = 'Asia/Shanghai';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/** 缺库时具名失败：CI 按文件门禁会把 fail>0 判红，不吞掉。 */
function requireDb(): PrismaClient {
  if (!db) assert.fail('M5-T3 PG 回归必须连真实 PostgreSQL：DATABASE_URL 未设置或缺库');
  return db;
}

after(async () => {
  if (!db) return;
  assert.match(SCHEMA, /^aggregate_\d+$/);
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('M5-T3 consistent-snapshot daily aggregate', { concurrency: false, timeout: 120_000 }, () => {
  before(async () => {
    // 不在这里抛错：before 抛错会把 8 个子测试全部 cancelled，CI 日志看不到具名的
    // 失败行。让每个用例自己的 reset()/requireDb() 去 assert.fail，逐条具名失败。
    if (!db) return;
    const conn = requireDb();
    await conn.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await conn.$executeRawUnsafe(`SET search_path TO "${SCHEMA}"`);
    // 用 prisma db push 建表，避免手写 DDL 与 schema.prisma 漂移。
    const pushed = await Promise.resolve()
      .then(async () => {
        const { execFileSync } = await import('node:child_process');
        const { createRequire } = await import('node:module');
        const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
        execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: url! },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return true;
      })
      .catch(() => false);
    assert.equal(pushed, true, 'prisma db push failed');
  });

  async function reset() {
    const conn = requireDb();
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsDailyRollup"`);
    await conn.$executeRawUnsafe(`DELETE FROM "AnalyticsRollupDay"`);
    await conn.$executeRawUnsafe(`DELETE FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}`);
  }

  /** 造一个真实的 analytics-aggregate 租约行，让 readLockedGeneration 能真读到代次。 */
  async function seedLease(generation: number) {
    const conn = requireDb();
    const now = new Date();
    const until = new Date(now.getTime() + 60_000);
    await conn.$executeRaw`
      INSERT INTO "JobState" (
        "key", "leaseOwner", "generation", "lockedUntil", "lastStartedAt",
        "lastStatus", "lastErrorCode", "summary", "createdAt", "updatedAt"
      ) VALUES (
        ${AGGREGATE_JOB_KEY}, ${'worker-a'}, ${generation}, ${utc(until)}, ${utc(now)},
        ${'RUNNING'}::"JobRunStatus", NULL, NULL, ${utc(now)}, ${utc(now)}
      )
      ON CONFLICT ("key") DO UPDATE SET "generation" = EXCLUDED."generation"
    `;
  }

  let seq = 0;
  async function insertEvent(input: {
    occurredAt: Date;
    receivedAt: Date;
    kind?: 'page_view' | 'product_view';
    locale?: string;
    productSlug?: string | null;
    browserHash?: string;
    path?: string | null;
  }) {
    const conn = requireDb();
    seq += 1;
    const kind = input.kind ?? 'page_view';
    const locale = input.locale ?? 'en';
    const browserHash = input.browserHash ?? `bh-${seq}`;
    await conn.$executeRaw`
      INSERT INTO "AnalyticsEvent" (
        "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
        "productSlug", "path", "occurredAt", "receivedAt", "createdAt"
      ) VALUES (
        ${`ev-${process.pid}-${seq}`}::uuid,
        ${`sk-${process.pid}-${seq}`},
        ${'p'.repeat(64)},
        ${browserHash},
        ${kind}::"AnalyticsEventKind",
        ${locale},
        ${input.productSlug ?? null},
        ${input.path ?? '/en'},
        ${utc(input.occurredAt)},
        ${utc(input.receivedAt)},
        ${utc(input.receivedAt)}
      )
    `;
  }

  test('E-80：receivedAt 晚于 cutoff 的事件留在下一轮，本轮结果不变', async () => {
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);

    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 30_000) });
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() + 60_000) });

    const first = await aggregateOneDayInSnapshot({
      db: requireDb(), siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 1, generation: 1, now,
    });
    assert.equal(first.written, true);
    assert.equal(first.eventCount, 2, 'cutoff 之后到达的事件不得计入本轮');

    const later = new Date(now.getTime() + 120_000);
    const second = await aggregateOneDayInSnapshot({
      db: requireDb(), siteDate: day, siteTimezone: TZ, cutoff: later, timezoneRevision: 1, generation: 2, now: later,
    });
    assert.equal(second.eventCount, 3, '下一轮应看到新到达的事件');
  });

  test('E-81：整组目标日 + watermark 一次事务替换，重跑同一输入结果不变', async () => {
    await reset();
    await seedLease(1);
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000), kind: 'product_view', productSlug: 'box' });

    const conn = requireDb();
    const args = { db: conn, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 1, generation: 1, now };
    const a = await aggregateOneDayInSnapshot(args);
    const rowsA = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}`;
    const wmA = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}`;
    assert.equal(Number(wmA[0]!.c), 1, '整组替换必须同时提交恰好一行 watermark');

    const b = await aggregateOneDayInSnapshot(args);
    const rowsB = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}`;
    assert.equal(a.eventCount, b.eventCount);
    assert.equal(Number(rowsA[0]!.c), Number(rowsB[0]!.c), '重跑不得重复插入汇总行');
  });

  test('E-81/E-83：旧 timezoneRevision 被数据库 WHERE 守卫拒绝，且整笔回滚不写半成品', async () => {
    await reset();
    await seedLease(1);
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });

    // 先以 revision 2 正常写入
    await aggregateOneDayInSnapshot({ db: conn, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 2, generation: 1, now });
    const before = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}`;
    assert.equal(Number(before[0]!.c), 1);

    // 旧 revision 1 试图覆盖 → 抛 AggregateVersionConflict，整个事务回滚
    await assert.rejects(
      () => aggregateOneDayInSnapshot({ db: conn, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 1, generation: 1, now }),
      (err: unknown) => err instanceof AggregateVersionConflict,
    );
    const stored = await conn.$queryRaw<{ timezoneRevision: number; c: bigint }[]>`
      SELECT "timezoneRevision", (SELECT COUNT(*)::bigint FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}) AS c
      FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
    `;
    assert.equal(Number(stored[0]!.timezoneRevision), 2, '落库仍应是新代次');
    assert.equal(Number(stored[0]!.c), 1, '失败事务的 DELETE 必须回滚，汇总行不能变空');
  });

  test('E-81：generation 真行锁——库里代次较新时旧任务被拒且不写库', async () => {
    await reset();
    await seedLease(7); // 真库代次 7
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });

    // 旧任务拿 generation=3 提交 → 行锁真读 7 > 3，必须拒绝（不是纯函数放行）
    await assert.rejects(
      () => aggregateOneDayInSnapshot({ db: conn, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 1, generation: 3, now }),
      (err: unknown) => err instanceof AggregateVersionConflict,
    );
    const rows = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}`;
    assert.equal(Number(rows[0]!.c), 0, '旧代次被拒后不得留下任何汇总行');
  });

  test('E-80/E-81：watermark 单调——旧 watermark 被 WHERE 守卫拒绝（affected=0）', async () => {
    await reset();
    const conn = requireDb();
    const day = '2026-03-01';
    const t = (h: number) => new Date(`2026-03-01T${String(h).padStart(2, '0')}:00:00.000Z`);
    // 先写新 watermark
    const first = await conn.$transaction((tx) => upsertWatermarkGuarded(tx, {
      siteDate: day, timezoneRevision: 1, completedAt: t(10), eventCount: 5, sourceMaxReceivedAt: t(10), now: t(10),
    }));
    assert.equal(first, 1, '新 watermark 应写入');
    // 旧 watermark 试图覆盖 → 守卫受影响 0 行
    const stale = await conn.$transaction((tx) => upsertWatermarkGuarded(tx, {
      siteDate: day, timezoneRevision: 1, completedAt: t(9), eventCount: 3, sourceMaxReceivedAt: t(9), now: t(9),
    }));
    assert.equal(stale, 0, '旧 watermark 必须被数据库 WHERE 守卫拒绝');
    const stored = await conn.$queryRaw<{ eventCount: number }[]>`
      SELECT "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
    `;
    assert.equal(Number(stored[0]!.eventCount), 5, '旧值不得改小');
  });

  test('E-82：超出完整原始覆盖的日不重算、不填 0', async () => {
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
    const run = await runAggregateOnce({
      db: requireDb(), now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ), timezoneRevision: 1, generation: 1,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.coverage, plan.coverage);
    const conn = requireDb();
    for (const day of run.days.filter((d) => d.skippedReason === 'out_of_coverage')) {
      assert.equal(day.written, false);
      const countRows: { c: bigint }[] = await conn.$queryRaw`
        SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day.siteDate}
      `;
      assert.equal(Number(countRows[0]!.c), 0, `跳过的日 ${day.siteDate} 不应写 watermark`);
    }
  });

  test('48h 迟到窗口内的旧日会被重算', async () => {
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
    assert.ok(plan.siteDates.length >= 1);
    assert.ok(plan.siteDates.includes(siteLocalDate(now, TZ)));
    const farPast = siteLocalDate(new Date(now.getTime() - LATE_ARRIVAL_MS - 48 * 3600_000), TZ);
    assert.equal(plan.siteDates.includes(farPast), false);
  });

  test('RepeatableRead：事务内两次读取看到同一快照', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });

    await conn.$transaction(async (tx) => {
      const first = await loadEventsAtSnapshot(tx, bounds, now);
      await tx.$executeRaw`
        INSERT INTO "AnalyticsEvent" (
          "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
          "productSlug", "path", "occurredAt", "receivedAt", "createdAt"
        ) VALUES (
          ${`rr-${process.pid}`}::uuid, ${`rr-sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-rr'},
          ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
          ${utc(new Date(bounds.startUtc))}, ${utc(new Date(now.getTime() - 30_000))}, ${utc(now)}
        )
      `;
      const second = await loadEventsAtSnapshot(tx, bounds, now);
      assert.equal(second.length, first.length, 'RepeatableRead 下第二次读取不应看到事务内新插入的行');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  });
});
