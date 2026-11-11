// M5-T3 一致快照聚合在隔离 schema 的真实 PostgreSQL 上验收。
//
// 本文件被 CI 的「Analytics, chat, and other PostgreSQL regressions」步骤纳入
// 按文件门禁（wanted / 命令行 / gate.files 三处）。因此：
//   - PG 回归步骤会设 M5T3_REQUIRE_DATABASE=true 且注入 DATABASE_URL；该步骤缺库时
//     顶层直接抛错，且按文件门禁要求 fail/skip/todo/cancelled 全为 0、pass>=1，
//     杜绝「没库却报绿」。
//   - build-and-audit 的 `pnpm test`（glob tests/*.test.ts）也会扫到本文件，但那个
//     job 没有数据库、也不设 M5T3_REQUIRE_DATABASE，此时按仓库既有 db 测试惯例整组
//     skip，不误伤单元测试 job。
//   - 每个 PG 用例都连真实库、真事务、真行锁，验证 generation 互斥与整组原子替换。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { LATE_ARRIVAL_MS, planSnapshot } from '../src/lib/analytics/aggregate-plan';
import { aggregateOneDayInSnapshot, runAggregateOnce, AggregateBatchExceeded, AggregateVersionConflict } from '../src/lib/server/analytics/aggregate';
import { loadEventsAtSnapshot, AGGREGATE_JOB_KEY, upsertWatermarkGuarded } from '../src/lib/server/analytics/aggregate-repo';
import { ANALYTICS_RECOMPUTE_KEY } from '../src/lib/server/analytics/settings-repo';

const base = process.env.DATABASE_URL;
const SCHEMA = `aggregate_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
// 必执行步骤（PG 回归）缺地址直接失败，不回退；其余 job 按既有惯例逐用例 skip。
if (process.env.M5T3_REQUIRE_DATABASE === 'true' && !url) {
  throw new Error('DATABASE_URL must be a postgres URL when M5T3_REQUIRE_DATABASE=true');
}
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';

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

describe('M5-T3 consistent-snapshot daily aggregate', { concurrency: false, skip, timeout: 120_000 }, () => {
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
    // 参数绑定，不能把 JS 模板插值拼进 SQL（会拼成 = analytics-aggregate，PG 报 42703）。
    await conn.$executeRaw`DELETE FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY}`;
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
        "productSlug", "path", "occurredAt", "receivedAt"
      ) VALUES (
        ${`ev-${process.pid}-${seq}`},
        ${`sk-${process.pid}-${seq}`},
        ${'p'.repeat(64)},
        ${browserHash},
        ${kind}::"AnalyticsEventKind",
        ${locale},
        ${input.productSlug ?? null},
        ${input.path ?? '/en'},
        ${utc(input.occurredAt)},
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

  test('RepeatableRead：并发连接已提交的写入在本事务快照内不可见，提交后可见', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });

    // 第二个独立连接，先于主事务写入并 commit，制造并发提交。
    const other = new PrismaClient({ datasources: { db: { url: url! } } });
    try {
      await conn.$transaction(async (tx) => {
        const first = await loadEventsAtSnapshot(tx, bounds, now);
        assert.equal(first.length, 1, '事务开始前应有 1 条');
        await other.$executeRaw`
          INSERT INTO "AnalyticsEvent" (
            "eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale",
            "productSlug", "path", "occurredAt", "receivedAt"
          ) VALUES (
            ${`rr-${process.pid}`}, ${`rr-sk-${process.pid}`}, ${'p'.repeat(64)}, ${'bh-rr'},
            ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${null}, ${'/en'},
            ${utc(new Date(bounds.startUtc))}, ${utc(new Date(now.getTime() - 30_000))}
          )
        `;
        const second = await loadEventsAtSnapshot(tx, bounds, now);
        assert.equal(second.length, first.length, 'RepeatableRead 快照不应看到另一连接已提交的新行');
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      // 事务提交后，新事务应能看到 2 条。
      const after = await loadEventsAtSnapshot(conn, bounds, now);
      assert.equal(after.length, 2, '新事务应看到并发提交后的 2 条');
    } finally {
      await other.$disconnect();
    }
  });

  test('E-81：整组目标日一次事务替换，第 2 天失败时整组回滚、第 1 天保持上一轮结果', async () => {
    await reset();
    await seedLease(1);
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day1 = '2026-02-28'; // 48h 迟到窗口内的旧日
    const day2 = siteLocalDate(now, TZ);
    const b1 = siteDayUtcBounds(day1, TZ);
    const b2 = siteDayUtcBounds(day2, TZ);
    // 两天各 1 条事件
    await insertEvent({ occurredAt: new Date(b1.startUtc), receivedAt: new Date(now.getTime() - 60_000) });
    await insertEvent({ occurredAt: new Date(b2.startUtc), receivedAt: new Date(now.getTime() - 60_000) });

    // 先跑一轮基线：两天都写入
    const baseline = await runAggregateOnce({
      db: conn, now, siteTimezone: TZ, currentDate: day2, timezoneRevision: 1, generation: 1,
    });
    assert.ok(baseline.days.some((d) => d.siteDate === day1 && d.written));
    assert.ok(baseline.days.some((d) => d.siteDate === day2 && d.written));
    const row1Before = await conn.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day1}
    `;
    const wm1Before = await conn.$queryRaw<{ eventCount: number }[]>`
      SELECT "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day1}
    `;

    // 制造第 2 天冲突：把它的 timezoneRevision 提更高，使整组中该日 revision 校验失败。
    await conn.$executeRaw`
      UPDATE "AnalyticsRollupDay" SET "timezoneRevision" = 9 WHERE "siteDate" = ${day2}
    `;
    // 整轮：事务开头行锁代次 1 通过；day1 会重写，day2 在 writeOneDayInTx 里因 storedRevision 9 > 1 抛错。
    await assert.rejects(
      () => runAggregateOnce({ db: conn, now, siteTimezone: TZ, currentDate: day2, timezoneRevision: 1, generation: 1 }),
      (err: unknown) => err instanceof AggregateVersionConflict,
    );
    // 整组回滚：day1 的汇总行与 watermark 必须与基线逐字节一致（未被覆盖成新值、也未清空）。
    const row1After = await conn.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day1}
    `;
    const wm1After = await conn.$queryRaw<{ eventCount: number }[]>`
      SELECT "eventCount" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day1}
    `;
    assert.equal(Number(row1After[0]!.c), Number(row1Before[0]!.c), '失败整组回滚后 day1 汇总行数不变');
    assert.equal(Number(wm1After[0]!.eventCount), Number(wm1Before[0]!.eventCount), '失败整组回滚后 day1 watermark 不变');
  });

  test('R7-T14077261：超范围日走 partial 服务路径，预置聚合与 watermark 逐字段不变', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const oldDay = '2026-01-15';
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: oldDay });
    assert.ok(plan.skippedDates.includes(oldDay), '测试前提：该日必须超出完整原始覆盖');
    assert.ok(plan.siteDates.length > 0, '测试前提：同一轮仍有可重算日，才能触发 partial 而不是 unavailable');
    assert.equal(plan.coverage, 'partial', '测试前提：本轮覆盖度应为 partial');

    // 预置超范围日的完整聚合（两组）与 watermark。revision 取 3、高于本轮 1：
    // 若产品误把这天当目标日重算，版本校验会直接抛错，测试立刻失败，不会静默绕过。
    await conn.$executeRaw`
      INSERT INTO "AnalyticsDailyRollup" ("siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "updatedAt")
      VALUES
        (${oldDay}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${''}, ${41}, ${17}, ${utc(new Date('2026-01-16T00:00:00.000Z'))}),
        (${oldDay}, ${'product_view'}::"AnalyticsEventKind", ${'en'}, ${'box'}, ${9}, ${4}, ${utc(new Date('2026-01-16T00:00:00.000Z'))})
    `;
    await conn.$executeRaw`
      INSERT INTO "AnalyticsRollupDay" ("siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "updatedAt")
      VALUES (${oldDay}, ${3}, ${utc(new Date('2026-01-16T00:00:00.000Z'))}, ${50}, ${utc(new Date('2026-01-15T23:00:00.000Z'))}, ${utc(new Date('2026-01-16T00:00:00.000Z'))})
    `;

    const readRollups = () => conn.$queryRaw<Record<string, unknown>[]>`
      SELECT "siteDate", "kind"::text AS "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt"
      FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${oldDay}
      ORDER BY "kind"::text, "locale", "productSlug"
    `;
    const readWatermark = () => conn.$queryRaw<Record<string, unknown>[]>`
      SELECT "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
      FROM "AnalyticsRollupDay" WHERE "siteDate" = ${oldDay}
    `;
    const rowsBefore = await readRollups();
    const watermarkBefore = await readWatermark();
    assert.equal(rowsBefore.length, 2, '预置的两组聚合行应可读到');

    const run = await runAggregateOnce({
      db: conn, now, siteTimezone: TZ, currentDate: oldDay, timezoneRevision: 1, generation: 1,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.coverage, 'partial', '本轮实际走 partial（不是 unavailable，也不冒称 complete）');
    assert.equal(
      run.days.length,
      plan.siteDates.length + plan.skippedDates.length,
      '结果必须同时覆盖可重算日与被跳过日',
    );
    assert.deepEqual(
      run.days.filter((d) => d.skippedReason === 'out_of_coverage').map((d) => d.siteDate),
      plan.skippedDates,
      'skippedDates 循环必须逐日产出结果，不能是零次执行',
    );
    const skipped = run.days.find((d) => d.siteDate === oldDay);
    assert.ok(skipped, '超范围日必须出现在本轮结果中');
    assert.equal(skipped!.written, false);
    assert.equal(skipped!.eventCount, 0);
    assert.equal(skipped!.sourceMaxReceivedAt, null);
    assert.ok(run.days.some((d) => d.written && d.siteDate !== oldDay), '同一轮里可重算日必须正常写入');

    assert.deepEqual(await readRollups(), rowsBefore, '超范围日的汇总行必须逐字段不变（不被覆盖、不被清空）');
    assert.deepEqual(await readWatermark(), watermarkBefore, '超范围日的 watermark 必须逐字段不变');
  });

  test('R7-T31416198：非 UTC 会话与 UTC 会话的午夜边界、cutoff 与 watermark 结果必须完全一致', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    const startMs = Date.parse(bounds.startUtc);
    const endMs = Date.parse(bounds.endUtc);

    // 播种覆盖四种语义位置：站点日界起点（最敏感）、日界前 1ms、日末内 1ms、cutoff 之后到达。
    // insertEvent 用 ::timestamptz AT TIME ZONE 'UTC' 落库，存储值是确定的 UTC 墙钟，
    // 与会话时区无关；会话差异只会来自产品查询的参数绑定与比较语义。
    await insertEvent({ occurredAt: new Date(startMs), receivedAt: new Date(now.getTime() - 60_000), browserHash: 'tz-at-start' });
    await insertEvent({ occurredAt: new Date(startMs - 1), receivedAt: new Date(now.getTime() - 60_000), browserHash: 'tz-before-start' });
    await insertEvent({ occurredAt: new Date(endMs - 1), receivedAt: new Date(now.getTime() - 60_000), browserHash: 'tz-at-end' });
    await insertEvent({ occurredAt: new Date(startMs + 60_000), receivedAt: new Date(now.getTime() + 60_000), browserHash: 'tz-late' });

    // 同一连接/事务内完成：SET LOCAL TIME ZONE → SHOW TimeZone 确认生效 → 被测聚合读取。
    // Prisma 交互式事务整段持有单一连接；SET LOCAL 在事务结束时自动还原，不污染连接池，
    // 也不是「对连接池 SET 一次就宣称覆盖」。产品查询保持原样，不预先 pin UTC。
    const readInSession = async (zone: 'UTC' | 'Asia/Shanghai') =>
      conn.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
        const shown = await tx.$queryRaw<{ [key: string]: string }[]>`SHOW TimeZone`;
        const zoneShown = String(Object.values(shown[0]!)[0]);
        const events = await loadEventsAtSnapshot(tx, bounds, now);
        return { zoneShown, events };
      });

    const utcRun = await readInSession('UTC');
    const cstRun = await readInSession('Asia/Shanghai');
    assert.equal(utcRun.zoneShown, 'UTC', 'UTC 事务必须确认会话时区生效');
    assert.equal(cstRun.zoneShown, 'Asia/Shanghai', '非 UTC 事务必须确认会话时区生效');

    // UTC 会话是基准：日界内恰好 2 条（起点含、日末含），日界前与 cutoff 之后各 1 条不入本轮。
    assert.deepEqual(
      utcRun.events.map((e) => e.browserHash).sort(),
      ['tz-at-end', 'tz-at-start'],
      'UTC 基准必须命中午夜边界与 cutoff 语义',
    );
    // 非 UTC 会话的读取结果必须与 UTC 完全一致；出现任何偏移即为产品缺陷，本用例必须失败，
    // 不得以「记录偏移」当作验收通过。
    assert.deepEqual(cstRun.events, utcRun.events, '非 UTC 会话的午夜边界与 cutoff 结果与 UTC 不一致');

    // watermark 写入同样对照：相同输入分别落在 UTC / 非 UTC 会话写入两天，
    // 在 UTC 会话读回逐字段比对（含 completedAt / sourceMaxReceivedAt / 时间戳列）。
    const wmArgs = (siteDate: string) => ({
      siteDate,
      timezoneRevision: 1,
      completedAt: new Date('2026-03-01T09:30:00.000Z'),
      eventCount: 7,
      sourceMaxReceivedAt: new Date('2026-03-01T09:00:00.000Z'),
      now: new Date('2026-03-01T10:00:00.000Z'),
    });
    await conn.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
      assert.equal(await upsertWatermarkGuarded(tx, wmArgs('2026-02-20')), 1);
    });
    await conn.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Asia/Shanghai'`);
      assert.equal(await upsertWatermarkGuarded(tx, wmArgs('2026-02-21')), 1);
    });
    const stored = await conn.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
      return tx.$queryRaw<{
        siteDate: string; rev: number; completedAt: string; eventCount: number;
        sourceMax: string; created: string; updated: string;
      }[]>`
        SELECT "siteDate",
               "timezoneRevision" AS "rev",
               to_char("completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "completedAt",
               "eventCount",
               to_char("sourceMaxReceivedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "sourceMax",
               to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "created",
               to_char("updatedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "updated"
        FROM "AnalyticsRollupDay"
        WHERE "siteDate" IN ('2026-02-20', '2026-02-21')
        ORDER BY "siteDate"
      `;
    });
    assert.equal(stored.length, 2, '两天 watermark 都应写入');
    const wmUtc = stored.find((r) => r.siteDate === '2026-02-20')!;
    const wmCst = stored.find((r) => r.siteDate === '2026-02-21')!;
    assert.equal(wmUtc.rev, 1);
    assert.equal(wmCst.rev, 1);
    assert.equal(wmUtc.eventCount, 7);
    assert.equal(wmCst.eventCount, 7);
    assert.equal(wmUtc.completedAt, '2026-03-01T09:30:00.000');
    assert.equal(wmCst.completedAt, '2026-03-01T09:30:00.000', '非 UTC 会话写入的 completedAt 必须与 UTC 完全一致');
    assert.equal(wmUtc.sourceMax, '2026-03-01T09:00:00.000');
    assert.equal(wmCst.sourceMax, '2026-03-01T09:00:00.000', '非 UTC 会话写入的 sourceMaxReceivedAt 必须与 UTC 完全一致');
    assert.equal(wmUtc.created, '2026-03-01T10:00:00.000');
    assert.equal(wmCst.created, '2026-03-01T10:00:00.000');
    assert.equal(wmUtc.updated, '2026-03-01T10:00:00.000');
    assert.equal(wmCst.updated, '2026-03-01T10:00:00.000');
  });
  // R7-T21418022：唯一新增的非 UTC 写入覆盖。只加测试层，不改产品导出面、不加产品钩子、
  // 不复制聚合逻辑；适配器只包住产品自己打开的 $transaction，并在同一个真实 tx 内完成时区/连接证明。
  type SessionTxOptions = { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number };
  type SessionTxProof = { calls: number; options: Array<SessionTxOptions | undefined> };

  /**
   * 测试层透传适配器：产品调用 db.$transaction(fn, options) 时，本适配器用真实 client 打开同一个事务，
   * 在真实 tx 内先 SET LOCAL 时区并确认、记录 PID，再把同一个 tx 交给产品原回调；回调结束后再核 PID 与时区。
   * 不模拟 SQL、不拷贝聚合逻辑、不改隔离级别/maxWait/timeout。
   */
  function sessionTxAdapter(client: PrismaClient, zone: 'UTC' | 'Asia/Shanghai', proof: SessionTxProof) {
    const adapter = {
      $queryRaw: client.$queryRaw.bind(client),
      $executeRaw: client.$executeRaw.bind(client),
      $transaction: async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: SessionTxOptions,
      ) => {
        proof.calls += 1;
        proof.options.push(options);
        return client.$transaction(async (tx) => {
          // 真实事务内的第一件事：设置并确认会话时区，记录连接 PID。
          await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
          const beforeZone = await tx.$queryRaw<Record<string, string>[]>`SHOW TimeZone`;
          assert.equal(String(Object.values(beforeZone[0]!)[0]), zone, '产品事务内必须先确认会话时区');
          const pidBefore = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          // 同一个真实 tx 交回产品原回调；产品内部的行锁、DELETE、INSERT、watermark upsert 都跑在这里。
          const result = await fn(tx);
          const pidAfter = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          const afterZone = await tx.$queryRaw<Record<string, string>[]>`SHOW TimeZone`;
          assert.equal(pidBefore[0]!.pid, pidAfter[0]!.pid, '产品回调前后必须是同一个数据库连接');
          assert.equal(String(Object.values(afterZone[0]!)[0]), zone, '产品回调结束后会话时区不得漂移');
          return result;
        }, options);
      },
    };
    return adapter as unknown as Parameters<typeof runAggregateOnce>[0]['db'];
  }

  test('R7-T21418022：参数侧 UTC 转换后，UTC 与非 UTC 会话的真实聚合事务写入逐字段一致', async () => {
    const conn = requireDb();
    // 固定带毫秒的 now：汇总 createdAt/updatedAt 与 watermark completedAt 都应是 10:00:00.123。
    const now = new Date('2026-03-01T10:00:00.123Z');
    const currentDate = siteLocalDate(now, TZ);
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate });
    const writingDay = currentDate;
    const emptyDay = plan.siteDates.find((day) => day !== writingDay);
    assert.ok(plan.siteDates.includes(writingDay), '测试前提：当前日必须在本轮目标日');
    assert.ok(emptyDay, '测试前提：本轮必须有一个无事件日来验 watermark NULL');

    // 相同业务输入：清库 → 租约 → 一条事件；两次 run 之间重复相同业务输入。
    // seedLease 的时钟与 insertEvent 的自增 ID 会变化，但它们不参与本测试比较。
    const seed = async () => {
      await reset();
      await seedLease(1);
      await insertEvent({
        occurredAt: new Date('2026-03-01T02:00:00.123Z'),
        receivedAt: new Date('2026-03-01T09:00:00.123Z'),
        browserHash: 'nonutc-write',
      });
    };

    const runAggregate = async (zone: 'UTC' | 'Asia/Shanghai') => {
      const proof: SessionTxProof = { calls: 0, options: [] };
      const result = await runAggregateOnce({
        db: sessionTxAdapter(conn, zone, proof),
        now, siteTimezone: TZ, currentDate, timezoneRevision: 1, generation: 1,
      });
      assert.equal(proof.calls, 1, '产品必须恰好打开一次真实事务');
      assert.deepEqual(proof.options[0], {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 15_000,
      }, '隔离级别、maxWait、timeout 必须原样透传');
      return result;
    };

    const MS = 'YYYY-MM-DD"T"HH24:MI:SS.MS';
    type RollupRow = {
      siteDate: string; kind: string; locale: string; productSlug: string;
      count: number; uniqueBrowsers: number; createdAt: string; updatedAt: string;
    };
    type WatermarkRow = {
      siteDate: string; timezoneRevision: number; completedAt: string; eventCount: number;
      sourceMaxReceivedAt: string | null; createdAt: string; updatedAt: string;
    };
    // 读回顺序固定：每次 run 提交后再开一个显式 UTC 事务读，确认读回会话是 UTC 才取数。
    const readUtc = async () => conn.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
      const shown = await tx.$queryRaw<Record<string, string>[]>`SHOW TimeZone`;
      assert.equal(String(Object.values(shown[0]!)[0]), 'UTC', '读回必须在 UTC 会话内');
      const rollups = await tx.$queryRaw<RollupRow[]>`
        SELECT "siteDate", "kind"::text AS "kind", "locale", "productSlug", "count", "uniqueBrowsers",
               to_char("createdAt", ${MS}) AS "createdAt", to_char("updatedAt", ${MS}) AS "updatedAt"
        FROM "AnalyticsDailyRollup"
        WHERE "siteDate" = ${writingDay}
        ORDER BY "kind"::text, "locale", "productSlug"
      `;
      const watermarks = await tx.$queryRaw<WatermarkRow[]>`
        SELECT "siteDate", "timezoneRevision",
               to_char("completedAt", ${MS}) AS "completedAt", "eventCount",
               CASE WHEN "sourceMaxReceivedAt" IS NULL THEN NULL
                    ELSE to_char("sourceMaxReceivedAt", ${MS}) END AS "sourceMaxReceivedAt",
               to_char("createdAt", ${MS}) AS "createdAt", to_char("updatedAt", ${MS}) AS "updatedAt"
        FROM "AnalyticsRollupDay"
        WHERE "siteDate" IN (${Prisma.join(plan.siteDates)})
        ORDER BY "siteDate"
      `;
      return { rollups, watermarks };
    });

    // 第一轮：UTC 会话真实事务；读回后保存快照。
    await seed();
    const utcResult = await runAggregate('UTC');
    const utcStored = await readUtc();

    // 第二轮：清库并重播相同业务输入，在 Asia/Shanghai 会话的真实事务里跑同一产品入口。
    await seed();
    const cstResult = await runAggregate('Asia/Shanghai');
    const cstStored = await readUtc();

    // 主验收：两会话的聚合结果与落库值必须逐字段完全一致（不拿固定期望值替代两会话比较）。
    assert.deepEqual(cstResult, utcResult, '同一输入在两个会话中的聚合结果必须一致');
    assert.deepEqual(cstStored, utcStored, '汇总行与 watermark 的落库值必须逐字段一致（含毫秒）');

    // 辅助锚点：固定毫秒、非空汇总行、空事件日 NULL 与有事件日非 NULL。
    const expected = '2026-03-01T10:00:00.123';
    assert.ok(utcStored.rollups.length > 0, '当前日必须有非空汇总行');
    for (const row of utcStored.rollups) {
      assert.equal(row.createdAt, expected, '汇总 createdAt 毫秒不得丢失');
      assert.equal(row.updatedAt, expected, '汇总 updatedAt 毫秒不得丢失');
    }
    const empty = utcStored.watermarks.find((row) => row.siteDate === emptyDay);
    assert.ok(empty, '无事件日也必须写 watermark');
    assert.equal(empty.sourceMaxReceivedAt, null, '无事件日 sourceMaxReceivedAt 必须保留 NULL');
    assert.equal(empty.completedAt, expected);
    assert.equal(empty.createdAt, expected);
    assert.equal(empty.updatedAt, expected);
    assert.equal(empty.eventCount, 0);
    const writing = utcStored.watermarks.find((row) => row.siteDate === writingDay);
    assert.ok(writing, '有事件日必须有 watermark');
    assert.equal(writing.sourceMaxReceivedAt, '2026-03-01T09:00:00.123');
  });

  // ---- D2：revision-aware watermark 守卫 ----
  // D2b=A：守卫拒绝（affected=0）必须让整轮回滚，不吞掉。
  // D2c=C：只有较新 revision 才允许在既有完整覆盖与同一快照内重定基准（NULL 或更小水位）。
  type D2WatermarkRow = {
    timezoneRevision: number;
    eventCount: number;
    sourceMax: Date | null;
    completedAt: Date;
  };

  const d2At = (iso: string) => new Date(iso);

  const d2WatermarkRow = async (siteDate: string) => {
    const rows = await requireDb().$queryRaw<D2WatermarkRow[]>`
      SELECT "timezoneRevision", "eventCount", "sourceMaxReceivedAt" AS "sourceMax", "completedAt"
      FROM "AnalyticsRollupDay" WHERE "siteDate" = ${siteDate}
    `;
    return rows[0] ?? null;
  };

  const d2RollupRows = (siteDate: string) => requireDb().$queryRaw<Record<string, unknown>[]>`
    SELECT "siteDate", "kind"::text AS "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt"
    FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${siteDate}
    ORDER BY "kind"::text, "locale", "productSlug"
  `;

  const d2Args = (
    siteDate: string,
    timezoneRevision: number,
    sourceMaxReceivedAt: Date | null,
    eventCount = 7,
  ) => ({
    siteDate,
    timezoneRevision,
    completedAt: d2At('2026-03-01T10:00:00.000Z'),
    eventCount,
    sourceMaxReceivedAt,
    now: d2At('2026-03-01T10:00:00.000Z'),
  });

  const d2Guard = (args: ReturnType<typeof d2Args>) =>
    requireDb().$transaction((tx) => upsertWatermarkGuarded(tx, args));

  test('D2：同 revision 下旧 NULL 可写，新 NULL 与更小水位被拒，相等/更大允许', async () => {
    await reset();
    const earlier = d2At('2026-03-01T08:00:00.000Z');
    const later = d2At('2026-03-01T09:00:00.000Z');

    // 无旧行：初次插入，NULL 也允许
    assert.equal(await d2Guard(d2Args('2026-02-01', 1, null)), 1, '初次插入 NULL watermark 必须成功');
    assert.equal((await d2WatermarkRow('2026-02-01'))!.sourceMax, null);

    // 同 revision：旧 NULL 的水位行，写 NULL 或非 NULL 都允许
    assert.equal(await d2Guard(d2Args('2026-02-02', 1, null)), 1);
    assert.equal(await d2Guard(d2Args('2026-02-02', 1, null)), 1, '旧 NULL → 新 NULL 允许');
    assert.equal(await d2Guard(d2Args('2026-02-02', 1, later)), 1, '旧 NULL → 非 NULL 允许');

    // 同 revision：非 NULL → NULL 必须拒绝（空日不能把真实水位改写成 NULL）
    assert.equal(
      await d2Guard(d2Args('2026-02-02', 1, null)),
      0,
      '同 revision 非 NULL → NULL 必须被数据库守卫拒绝',
    );
    assert.equal(
      (await d2WatermarkRow('2026-02-02'))!.sourceMax!.getTime(),
      later.getTime(),
      '被拒后旧水位必须保持不变',
    );

    // 同 revision：更小拒绝，相等/更大允许
    assert.equal(await d2Guard(d2Args('2026-02-03', 1, later)), 1);
    assert.equal(await d2Guard(d2Args('2026-02-03', 1, earlier)), 0, '同 revision 更小水位必须被拒');
    assert.equal((await d2WatermarkRow('2026-02-03'))!.sourceMax!.getTime(), later.getTime());
    assert.equal(await d2Guard(d2Args('2026-02-03', 1, later)), 1, '同 revision 相等水位允许');
    assert.equal(
      await d2Guard(d2Args('2026-02-03', 1, d2At('2026-03-01T09:30:00.000Z'))),
      1,
      '同 revision 更大水位允许',
    );
  });

  test('D2：更低 revision 即使水位更大也被拒绝，行保持原 revision 与水位', async () => {
    await reset();
    const kept = d2At('2026-03-01T09:00:00.000Z');
    assert.equal(await d2Guard(d2Args('2026-02-10', 2, kept)), 1);
    assert.equal(
      await d2Guard(d2Args('2026-02-10', 1, d2At('2026-03-01T09:30:00.000Z'))),
      0,
      '低 revision 覆盖必须被数据库拒绝，哪怕水位更大',
    );
    const row = (await d2WatermarkRow('2026-02-10'))!;
    assert.equal(row.timezoneRevision, 2);
    assert.equal(row.sourceMax!.getTime(), kept.getTime());
  });

  test('D2：较新 revision 允许 NULL / 更小 / 相等 / 更大水位重定基准（D2c=C）', async () => {
    await reset();
    const kept = d2At('2026-03-01T09:00:00.000Z');
    const cases: Array<{ siteDate: string; next: Date | null; label: string }> = [
      { siteDate: '2026-02-20', next: null, label: '较新 revision 空日（NULL）' },
      { siteDate: '2026-02-21', next: d2At('2026-03-01T08:00:00.000Z'), label: '较新 revision 更小水位' },
      { siteDate: '2026-02-22', next: kept, label: '较新 revision 相等水位' },
      { siteDate: '2026-02-23', next: d2At('2026-03-01T09:30:00.000Z'), label: '较新 revision 更大水位' },
    ];
    for (const item of cases) {
      assert.equal(await d2Guard(d2Args(item.siteDate, 1, kept)), 1, `${item.siteDate} 基线写入`);
      assert.equal(await d2Guard(d2Args(item.siteDate, 2, item.next)), 1, `${item.label} 必须允许重定基准`);
      const row = (await d2WatermarkRow(item.siteDate))!;
      assert.equal(row.timezoneRevision, 2, `${item.label} 必须把 revision 一起更新`);
      assert.equal(
        row.sourceMax === null ? null : row.sourceMax.getTime(),
        item.next === null ? null : item.next.getTime(),
        `${item.label} 水位必须按本次结果重定`,
      );
    }
  });

  test('D2b=A：同 revision 出现 NULL 冲突时整轮回滚，两天的日聚合与水位都保持上一轮', async () => {
    await reset();
    await seedLease(1);
    const conn = requireDb();
    const now = d2At('2026-03-01T10:00:00.000Z');
    const day2 = siteLocalDate(now, TZ);
    const day1 = '2026-02-28';
    const b1 = siteDayUtcBounds(day1, TZ);
    const b2 = siteDayUtcBounds(day2, TZ);
    await insertEvent({
      occurredAt: new Date(b1.startUtc),
      receivedAt: new Date(now.getTime() - 60_000),
      browserHash: 'd2b-keep-day1',
    });
    await insertEvent({
      occurredAt: new Date(b2.startUtc),
      receivedAt: new Date(now.getTime() - 60_000),
      browserHash: 'd2b-empty-day2',
    });

    const baseline = await runAggregateOnce({
      db: conn, now, siteTimezone: TZ, currentDate: day2, timezoneRevision: 1, generation: 1,
    });
    assert.ok(baseline.days.some((day) => day.siteDate === day1 && day.written), '前提：day1 在基线轮已写入');
    assert.ok(baseline.days.some((day) => day.siteDate === day2 && day.written), '前提：day2 在基线轮已写入');
    assert.notEqual((await d2WatermarkRow(day2))!.sourceMax, null, '前提：day2 基线水位非 NULL');

    // 让 day2 变成空日（删掉它的事件），revision 不变：新 NULL 想覆盖旧非 NULL，守卫必须拒绝。
    await conn.$executeRaw`DELETE FROM "AnalyticsEvent" WHERE "browserHash" = ${'d2b-empty-day2'}`;

    const snapshot = async () => ({
      day1Rows: await d2RollupRows(day1),
      day2Rows: await d2RollupRows(day2),
      day1Watermark: await d2WatermarkRow(day1),
      day2Watermark: await d2WatermarkRow(day2),
    });
    const before = await snapshot();

    await assert.rejects(
      () => runAggregateOnce({
        db: conn, now, siteTimezone: TZ, currentDate: day2, timezoneRevision: 1, generation: 1,
      }),
      (err: unknown) => err instanceof AggregateVersionConflict,
      '同 revision 非 NULL → NULL 必须让整轮失败，不能吞掉 affected=0',
    );
    assert.deepEqual(await snapshot(), before, '整轮回滚后两天的日聚合与水位必须逐字段保持基线值');
  });

  test('D2c=C：较新 revision 在同一轮里允许更小水位与空日重定基准，事务正常提交', async () => {
    await reset();
    await seedLease(1);
    const conn = requireDb();
    const now = d2At('2026-03-01T10:00:00.000Z');
    const day2 = siteLocalDate(now, TZ);
    const day1 = '2026-02-28';
    const b1 = siteDayUtcBounds(day1, TZ);
    const b2 = siteDayUtcBounds(day2, TZ);
    const received = new Date(now.getTime() - 30 * 60_000);
    await insertEvent({
      occurredAt: new Date(b1.startUtc),
      receivedAt: new Date(now.getTime() - 60_000),
      browserHash: 'd2c-day1',
    });
    await insertEvent({ occurredAt: new Date(b2.startUtc), receivedAt: received, browserHash: 'd2c-day2' });

    await runAggregateOnce({
      db: conn, now, siteTimezone: TZ, currentDate: day2, timezoneRevision: 1, generation: 1,
    });
    assert.equal(
      (await d2WatermarkRow(day2))!.sourceMax!.getTime(),
      received.getTime(),
      '前提：day2 基线水位来自该事件',
    );

    // 模拟「库里水位比本次快照更新」：时区变更后同一日的水位可能落在更晚时刻。
    const later = new Date(received.getTime() + 20 * 60_000);
    await conn.$executeRaw`
      UPDATE "AnalyticsRollupDay" SET "sourceMaxReceivedAt" = ${utc(later)} WHERE "siteDate" = ${day2}
    `;

    // 较新 revision：更小水位必须允许重定基准（旧守卫会返回 0 并让整轮失败）。
    const rebased = await runAggregateOnce({
      db: conn, now, siteTimezone: TZ, currentDate: day2, timezoneRevision: 2, generation: 1,
    });
    assert.equal(rebased.status, 'ok');
    const afterRebase = (await d2WatermarkRow(day2))!;
    assert.equal(afterRebase.timezoneRevision, 2, '重定基准必须把 revision 一起更新');
    assert.equal(afterRebase.sourceMax!.getTime(), received.getTime(), '较新 revision 必须允许把水位重定为更小值');
    assert.equal((await d2WatermarkRow(day1))!.timezoneRevision, 2, '同一轮其它日也必须更新到新 revision');

    // 再由「有事件」变成「空日」：仍是较新 revision，NULL 必须允许。
    await conn.$executeRaw`DELETE FROM "AnalyticsEvent" WHERE "browserHash" = ${'d2c-day2'}`;
    const emptied = await runAggregateOnce({
      db: conn, now, siteTimezone: TZ, currentDate: day2, timezoneRevision: 3, generation: 1,
    });
    assert.equal(emptied.status, 'ok');
    const afterEmpty = (await d2WatermarkRow(day2))!;
    assert.equal(afterEmpty.timezoneRevision, 3);
    assert.equal(afterEmpty.eventCount, 0);
    assert.equal(afterEmpty.sourceMax, null, '较新 revision 下空日必须允许把水位重定为 NULL');
    assert.equal((await d2RollupRows(day2)).length, 0, '空日的日聚合必须与水位在同一轮里被清空');
  });

  test('M5-T4 R9 超限负控：rebuildFrom 窗口超过 maxBatchDays 时整组拒绝、无行、待办不动', async () => {
    await reset();
    const conn = requireDb();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    await insertEvent({
      occurredAt: new Date(`${day}T01:00:00.000Z`),
      receivedAt: new Date(`${day}T02:00:00.000Z`),
      browserHash: 'm5t4-batch',
    });
    const backlog = {
      timezoneRevision: 1,
      timezone: TZ,
      recomputableFrom: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
      requestedAt: now.toISOString(),
      updatedBy: 'admin-a',
      status: 'pending',
    };
    await conn.$executeRaw`
      INSERT INTO "SiteSetting" ("key", "value") VALUES (${ANALYTICS_RECOMPUTE_KEY}, ${JSON.stringify(backlog)}::jsonb)
    `;
    await assert.rejects(
      () => runAggregateOnce({
        db: conn,
        now,
        siteTimezone: TZ,
        currentDate: day,
        timezoneRevision: 1,
        generation: 1,
        maxBatchDays: 2,
        rebuildFrom: backlog.recomputableFrom,
      }),
      AggregateBatchExceeded,
    );
    const rollups = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup"`;
    const watermarks = await conn.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay"`;
    assert.equal(Number(rollups[0]!.c), 0, '超限不得写入聚合行');
    assert.equal(Number(watermarks[0]!.c), 0, '超限不得写入水位');
    const stored = await conn.$queryRaw<{ value: string }[]>`
      SELECT "value"::text AS "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_RECOMPUTE_KEY}
    `;
    assert.deepEqual(JSON.parse(stored[0]!.value), backlog, '超限不得消费/改写待办');
    await conn.$executeRaw`DELETE FROM "SiteSetting" WHERE "key" = ${ANALYTICS_RECOMPUTE_KEY}`;
  });
});
