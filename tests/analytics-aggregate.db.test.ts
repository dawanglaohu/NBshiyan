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
import { aggregateOneDayInSnapshot, runAggregateOnce, AggregateVersionConflict } from '../src/lib/server/analytics/aggregate';
import { loadEventsAtSnapshot, AGGREGATE_JOB_KEY, upsertWatermarkGuarded } from '../src/lib/server/analytics/aggregate-repo';

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
      INSERT INTO "AnalyticsDailyRollup" ("siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers")
      VALUES
        (${oldDay}, ${'page_view'}::"AnalyticsEventKind", ${'en'}, ${''}, ${41}, ${17}),
        (${oldDay}, ${'product_view'}::"AnalyticsEventKind", ${'en'}, ${'box'}, ${9}, ${4})
    `;
    await conn.$executeRaw`
      INSERT INTO "AnalyticsRollupDay" ("siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt")
      VALUES (${oldDay}, ${3}, ${utc(new Date('2026-01-16T00:00:00.000Z'))}, ${50}, ${utc(new Date('2026-01-15T23:00:00.000Z'))})
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
});
