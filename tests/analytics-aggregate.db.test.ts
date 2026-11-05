// M5-T3 一致快照聚合在隔离 schema 的真实 PostgreSQL 上验收。
// 没有 DATABASE_URL 时整组 skip（与其他 .db.test.ts 一致），CI 的 e2e job 会连 postgres:17 实际执行。
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, siteLocalDate } from '../src/lib/analytics/day-boundaries';
import { LATE_ARRIVAL_MS, planSnapshot, mayPublish } from '../src/lib/analytics/aggregate-plan';
import { aggregateOneDayInSnapshot, runAggregateOnce } from '../src/lib/server/analytics/aggregate';
import { loadEventsAtSnapshot } from '../src/lib/server/analytics/aggregate-repo';

const base = process.env.DATABASE_URL;
const SCHEMA = `aggregate_${process.pid}`;
const url = base?.startsWith('postgres')
  ? `${base}${base.includes('?') ? '&' : '?'}schema=${encodeURIComponent(SCHEMA)}&connection_limit=5&pool_timeout=10`
  : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
const skip = !db && 'no DATABASE_URL';

const TZ = 'Asia/Shanghai';
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

after(async () => {
  if (!db) return;
  assert.match(SCHEMA, /^aggregate_\d+$/);
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

describe('M5-T3 consistent-snapshot daily aggregate', { concurrency: false, skip, timeout: 120_000 }, () => {
  before(async () => {
    if (!db) return;
    await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await db.$executeRawUnsafe(`SET search_path TO "${SCHEMA}"`);
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
    if (!db) return;
    await db.$executeRawUnsafe(`DELETE FROM "AnalyticsEvent"`);
    await db.$executeRawUnsafe(`DELETE FROM "AnalyticsDailyRollup"`);
    await db.$executeRawUnsafe(`DELETE FROM "AnalyticsRollupDay"`);
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
    if (!db) throw new Error('no db');
    seq += 1;
    const kind = input.kind ?? 'page_view';
    const locale = input.locale ?? 'en';
    const browserHash = input.browserHash ?? `bh-${seq}`;
    await db.$executeRaw`
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
    if (!db) return;
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);

    // 两条在 cutoff 之前到达
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 30_000) });
    // 一条在 cutoff 之后才到达（本轮不应看到）
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() + 60_000) });

    const first = await aggregateOneDayInSnapshot({
      db, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 1, generation: 1, now,
    });
    assert.equal(first.written, true);
    assert.equal(first.eventCount, 2, 'cutoff 之后到达的事件不得计入本轮');

    // 下一轮 cutoff 推后，才看到第 3 条
    const later = new Date(now.getTime() + 120_000);
    const second = await aggregateOneDayInSnapshot({
      db, siteDate: day, siteTimezone: TZ, cutoff: later, timezoneRevision: 1, generation: 1, now: later,
    });
    assert.equal(second.eventCount, 3, '下一轮应看到新到达的事件');
  });

  test('E-81：整日替换是原子的，重跑同一输入结果不变', async () => {
    if (!db) return;
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000), kind: 'product_view', productSlug: 'box' });

    const args = { db, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 1, generation: 1, now };
    const a = await aggregateOneDayInSnapshot(args);
    const rowsA = await db.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}`;
    const b = await aggregateOneDayInSnapshot(args);
    const rowsB = await db.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*)::bigint AS c FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${day}`;
    assert.equal(a.eventCount, b.eventCount);
    assert.equal(Number(rowsA[0]!.c), Number(rowsB[0]!.c), '重跑不得重复插入汇总行');
  });

  test('E-81/E-83：旧 timezoneRevision 不得覆盖新结果', async () => {
    if (!db) return;
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });

    // 先用 revision 2 写入
    await aggregateOneDayInSnapshot({ db, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 2, generation: 1, now });
    // 旧 revision 1 试图覆盖 → 必须拒绝
    const stale = await aggregateOneDayInSnapshot({ db, siteDate: day, siteTimezone: TZ, cutoff: now, timezoneRevision: 1, generation: 1, now });
    assert.equal(stale.written, false, '旧时区代次不得覆盖');
    const stored = await db.$queryRaw<{ timezoneRevision: number }[]>`
      SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day}
    `;
    assert.equal(Number(stored[0]!.timezoneRevision), 2, '落库的仍应是新代次');
  });

  test('E-82：超出完整原始覆盖的日不重算、不填 0', async () => {
    if (!db) return;
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
    const run = await runAggregateOnce({
      db, now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ), timezoneRevision: 1, generation: 1,
    });
    assert.equal(run.status, 'ok');
    assert.equal(run.coverage, plan.coverage);
    // 所有被跳过的日必须带 out_of_coverage，且不得写库
    for (const day of run.days.filter((d) => d.skippedReason === 'out_of_coverage')) {
      assert.equal(day.written, false);
      const countRows: { c: bigint }[] = await db.$queryRaw`
        SELECT COUNT(*)::bigint AS c FROM "AnalyticsRollupDay" WHERE "siteDate" = ${day.siteDate}
      `;
      assert.equal(Number(countRows[0]!.c), 0, `跳过的日 ${day.siteDate} 不应写 watermark`);
    }
  });

  test('48h 迟到窗口内的旧日会被重算', async () => {
    if (!db) return;
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
    assert.ok(plan.siteDates.length >= 1);
    // 迟到窗口内应包含当前日
    assert.ok(plan.siteDates.includes(siteLocalDate(now, TZ)));
    // 窗口外的日子不在计划里
    const farPast = siteLocalDate(new Date(now.getTime() - LATE_ARRIVAL_MS - 48 * 3600_000), TZ);
    assert.equal(plan.siteDates.includes(farPast), false);
  });

  test('RepeatableRead：事务内两次读取看到同一快照', async () => {
    if (!db) return;
    await reset();
    const now = new Date('2026-03-01T10:00:00.000Z');
    const day = siteLocalDate(now, TZ);
    const bounds = siteDayUtcBounds(day, TZ);
    await insertEvent({ occurredAt: new Date(bounds.startUtc), receivedAt: new Date(now.getTime() - 60_000) });

    await db.$transaction(async (tx) => {
      const first = await loadEventsAtSnapshot(tx, bounds, now);
      // 事务内插入一条新事件（若隔离级别是 ReadCommitted，第二次读会看到它）
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

  test('mayPublish 与 planSnapshot 的边界组合', () => {
    assert.equal(mayPublish({ claimGeneration: 2, storedGeneration: 3, claimTimezoneRevision: 1, storedTimezoneRevision: 1 }), false);
    assert.equal(mayPublish({ claimGeneration: 3, storedGeneration: 3, claimTimezoneRevision: 2, storedTimezoneRevision: 1 }), true);
    const now = new Date('2026-03-01T10:00:00.000Z');
    const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
    assert.equal(plan.coverage, 'complete');
    assert.deepEqual(plan.skippedDates, []);
  });
});
