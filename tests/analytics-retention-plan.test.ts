import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  RETENTION_CLEANUP_MAX_PER_RUN,
  classifyRetentionDays,
  createRetentionCandidateRepo,
  deletionBatchSizes,
  eventDeletionFloorLocalDate,
  eventExpiresAt,
  eventExpiryCutoff,
  isEventExpired,
  isRollupExpired,
  partitionRecomputableDays,
  rawCoveragePlan,
  rawEventCutoff,
  rollupDeletionBefore,
  rollupExpiresAt,
  rollupExpiryCutoff,
  shiftCalendarMonths,
} from '../src/lib/server/analytics/retention-plan';
import { recomputableFrom, siteLocalDate } from '../src/lib/analytics/day-boundaries';

// 这组用例只覆盖纯函数与只读候选仓储的 SQL 契约，不需要数据库。
// 真实事务、租约与生产保留授权门禁由 M5-T11 在隔离 PostgreSQL 上集成验证。

const TZ = 'Asia/Shanghai';

type QueryDb = Pick<PrismaClient, '$queryRaw'>;

function sqlText(query: Prisma.Sql): string {
  return (query as unknown as { text: string }).text;
}

function fakeQueryDb(handler: (query: Prisma.Sql, call: number) => unknown[]) {
  const calls: Prisma.Sql[] = [];
  const db = {
    $queryRaw: async (query: Prisma.Sql) => {
      calls.push(query);
      return handler(query, calls.length - 1);
    },
  };
  return { db: db as unknown as QueryDb, calls };
}

test('旧清理链的严格早于边界逐字保留，等号仍保留', () => {
  const now = new Date('2027-02-01T10:00:00.000Z');
  assert.equal(rawEventCutoff(now).toISOString(), '2027-01-02T10:00:00.000Z');
  assert.equal(rollupDeletionBefore(now, TZ), '2026-01-01');
  assert.equal(eventDeletionFloorLocalDate(now, TZ), '2027-01-03');
});

test('旧候选分类仍按代次、缺口与下限过滤', () => {
  const out = classifyRetentionDays({
    floorLocalDate: '2026-02-01',
    contiguousThrough: '2026-01-10',
    currentRevision: 2,
    days: [
      { siteDate: '2026-01-05', timezoneRevision: 2 },
      { siteDate: '2026-01-06', timezoneRevision: 1 },
      { siteDate: '2026-01-12', timezoneRevision: 2 },
      { siteDate: '2026-02-01', timezoneRevision: 2 },
    ],
  });
  assert.deepEqual(out.deletable, ['2026-01-05']);
  assert.equal(out.skippedRevisionMismatchDays, 1);
  assert.equal(out.skippedAfterGapDays, 1);
  assert.deepEqual(deletionBatchSizes(12_000, 5_000, 20_000), [5_000, 5_000, 2_000]);
});

test('原始事件在 receivedAt+30 天整到期，等号算到期', () => {
  const receivedAt = new Date('2026-03-01T00:00:00.000Z');
  const expiry = eventExpiresAt(receivedAt);
  assert.equal(expiry.toISOString(), '2026-03-31T00:00:00.000Z');
  assert.equal(isEventExpired(receivedAt, new Date(expiry.getTime() - 1)), false);
  assert.equal(isEventExpired(receivedAt, expiry), true);
  assert.equal(eventExpiryCutoff(expiry).toISOString(), receivedAt.toISOString());
  // 毫秒精度：timestamp(3) 与 JS Date 都是毫秒。
  const withMillis = new Date('2026-03-01T00:00:00.123Z');
  assert.equal(eventExpiresAt(withMillis).toISOString(), '2026-03-31T00:00:00.123Z');
  assert.equal(isEventExpired(withMillis, new Date('2026-03-31T00:00:00.123Z')), true);
  assert.equal(isEventExpired(withMillis, new Date('2026-03-31T00:00:00.122Z')), false);
});

test('汇总行在 siteDate+13 个自然月到期日整到期，等号算到期', () => {
  assert.equal(rollupExpiresAt('2026-01-15'), '2027-02-15');
  // Asia/Shanghai 2027-02-15 00:00 = 2027-02-14T16:00:00.000Z（上海无 DST）。
  const justBefore = new Date(Date.parse('2027-02-14T16:00:00.000Z') - 1);
  const atExpiry = new Date('2027-02-14T16:00:00.000Z');
  assert.equal(siteLocalDate(atExpiry, TZ), '2027-02-15');
  assert.equal(isRollupExpired('2026-01-15', justBefore, TZ), false);
  assert.equal(isRollupExpired('2026-01-15', atExpiry, TZ), true);
  assert.equal(rollupExpiryCutoff(atExpiry, TZ), '2026-01-15');
  assert.equal(rollupExpiryCutoff(justBefore, TZ), '2026-01-14');
});

test('13 个自然月跨闰月与月末夹取', () => {
  assert.equal(shiftCalendarMonths('2023-01-31', 13), '2024-02-29');
  assert.equal(shiftCalendarMonths('2024-01-31', 13), '2025-02-28');
  assert.equal(shiftCalendarMonths('2026-02-28', 13), '2027-03-28');
  assert.equal(shiftCalendarMonths('2026-12-31', -13), '2025-11-30');
});

test('到期上界按站点本地日计算，不受 DST 日 23/25 小时影响', () => {
  const dst = 'America/New_York';
  const atNoon = new Date('2027-03-14T12:00:00.000Z');
  assert.equal(siteLocalDate(atNoon, dst), '2027-03-14');
  assert.equal(rollupExpiryCutoff(atNoon, dst), '2026-02-14');
  const lastSecondBefore = new Date('2027-03-14T04:59:59.999Z');
  assert.equal(siteLocalDate(lastSecondBefore, dst), '2027-03-13');
  assert.equal(rollupExpiryCutoff(lastSecondBefore, dst), '2026-02-13');
});

test('完整原始覆盖起点与 recomputableFrom 一致，部分清理日不可重算', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const plan = rawCoveragePlan(now, TZ);
  assert.equal(plan.completeRawCoverageStartUtc, recomputableFrom(now, TZ));
  assert.equal(plan.completeRawCoverageStartLocalDate, '2026-01-31');

  const boundary = Date.parse(plan.completeRawCoverageStartUtc);
  const dayBefore = siteLocalDate(new Date(boundary - 1), TZ);
  const dayAfter = siteLocalDate(new Date(boundary + 24 * 60 * 60 * 1000), TZ);
  const partition = partitionRecomputableDays({
    siteDates: [dayAfter, dayBefore, plan.completeRawCoverageStartLocalDate, dayBefore],
    siteTimezone: TZ,
    completeRawCoverageStartUtc: plan.completeRawCoverageStartUtc,
  });
  assert.deepEqual(partition.nonRecomputable, [dayBefore]);
  assert.deepEqual(partition.recomputable, [plan.completeRawCoverageStartLocalDate, dayAfter]);

  // 40 天前的日子可能已被部分清理：只能保留旧完整聚合，不得标可重算。
  const partiallyCleaned = siteLocalDate(new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000), TZ);
  const partial = partitionRecomputableDays({
    siteDates: [partiallyCleaned],
    siteTimezone: TZ,
    completeRawCoverageStartUtc: plan.completeRawCoverageStartUtc,
  });
  assert.deepEqual(partial.recomputable, []);
  assert.deepEqual(partial.nonRecomputable, [partiallyCleaned]);
});

test('无效时刻、日期与时区被拒绝', () => {
  assert.throws(() => eventExpiresAt(new Date('not-a-date')), /invalid_instant/);
  assert.throws(() => isEventExpired(new Date('not-a-date'), new Date()), /invalid_instant/);
  assert.throws(() => rollupExpiresAt('2026-02-30'), /invalid_date/);
  assert.throws(() => rollupExpiryCutoff(new Date('not-a-date'), TZ), /invalid_instant/);
  assert.throws(() => rawCoveragePlan(new Date('not-a-date'), TZ), /invalid_instant/);
  assert.throws(
    () => partitionRecomputableDays({
      siteDates: ['2026-1-1'],
      siteTimezone: TZ,
      completeRawCoverageStartUtc: '2026-01-01T00:00:00.000Z',
    }),
    /invalid_date/,
  );
  assert.throws(
    () => partitionRecomputableDays({
      siteDates: ['2026-01-01'],
      siteTimezone: TZ,
      completeRawCoverageStartUtc: 'not-a-date',
    }),
    /invalid_instant/,
  );
});

test('候选统计只返回数量，不删除也不导出身份列', async () => {
  const now = new Date('2027-02-01T10:00:00.000Z');
  const { db, calls } = fakeQueryDb((_query, call) => {
    if (call === 0) return [{ count: 7 }];
    if (call === 1) return [{ count: 3 }];
    return [{ count: 2 }];
  });
  const repo = createRetentionCandidateRepo({ db, now, siteTimezone: TZ });
  const counts = await repo.counts();
  assert.deepEqual(counts, { events: 7, rollupDailyRows: 3, rollupDays: 2, total: 12 });
  assert.equal(calls.length, 3);
  assert.match(sqlText(calls[0]), /FROM "AnalyticsEvent" WHERE "receivedAt" <= \$1::timestamptz AT TIME ZONE 'UTC'/);
  assert.match(sqlText(calls[1]), /FROM "AnalyticsDailyRollup" WHERE "siteDate" <= \$1/);
  assert.match(sqlText(calls[2]), /FROM "AnalyticsRollupDay" WHERE "siteDate" <= \$1/);
  assert.equal(calls[0].values[0], '2027-01-02T10:00:00.000Z');
  assert.equal(calls[1].values[0], '2026-01-01');
  for (const query of calls) {
    const text = sqlText(query).toLowerCase();
    assert.equal(text.includes('delete'), false);
    assert.equal(text.includes('browserhash'), false);
    assert.equal(text.includes('payloadhash'), false);
    assert.equal(text.includes('"path"'), false);
  }
});

test('候选事件只列举 eventId，按接收时间稳定排序并有界', async () => {
  const now = new Date('2027-02-01T10:00:00.000Z');
  const { db, calls } = fakeQueryDb(() => [{ eventId: 'evt-a' }, { eventId: 'evt-b' }]);
  const repo = createRetentionCandidateRepo({ db, now, siteTimezone: TZ });
  const ids = await repo.eventIds(50);
  assert.deepEqual(ids, ['evt-a', 'evt-b']);
  assert.match(sqlText(calls[0]), /ORDER BY "receivedAt" ASC, "eventId" ASC/);
  assert.match(sqlText(calls[0]), /LIMIT \$2/);
  assert.deepEqual(calls[0].values, ['2027-01-02T10:00:00.000Z', 50]);
  assert.equal(sqlText(calls[0]).toLowerCase().includes('browserhash'), false);
});

test('汇总候选只返回日期与维度 key，不返回计数细节或身份', async () => {
  const now = new Date('2027-02-01T10:00:00.000Z');
  const { db, calls } = fakeQueryDb((_query, call) => {
    if (call === 0) {
      return [{ siteDate: '2026-01-01', kind: 'page_view', locale: 'en', productSlug: '' }];
    }
    return [{ siteDate: '2026-01-01' }];
  });
  const repo = createRetentionCandidateRepo({ db, now, siteTimezone: TZ });
  const keys = await repo.rollupDailyKeys(25);
  assert.deepEqual(keys, [{ siteDate: '2026-01-01', kind: 'page_view', locale: 'en', productSlug: '' }]);
  const days = await repo.rollupDays(25);
  assert.deepEqual(days, ['2026-01-01']);
  assert.match(sqlText(calls[0]), /SELECT "siteDate", "kind"::text AS "kind", "locale", "productSlug"/);
  assert.match(sqlText(calls[0]), /"siteDate" <= \$1/);
  assert.equal(sqlText(calls[0]).toLowerCase().includes('count'), false);
  assert.equal(sqlText(calls[0]).toLowerCase().includes('browserhash'), false);
  assert.equal(sqlText(calls[1]).toLowerCase().includes('count'), false);
});

test('候选列举上限有界，非法上限在查询前拒绝', async () => {
  const { db, calls } = fakeQueryDb(() => []);
  const repo = createRetentionCandidateRepo({
    db,
    now: new Date('2027-02-01T10:00:00.000Z'),
    siteTimezone: TZ,
  });
  await assert.rejects(repo.eventIds(0), /invalid_limit/);
  await assert.rejects(repo.eventIds(1.5), /invalid_limit/);
  await assert.rejects(repo.rollupDailyKeys(RETENTION_CLEANUP_MAX_PER_RUN + 1), /invalid_limit/);
  await assert.rejects(repo.rollupDays(-1), /invalid_limit/);
  assert.equal(calls.length, 0);
});

test('候选仓储构造后固定同一套截止值，重复查询口径一致', async () => {
  const now = new Date('2027-02-01T10:00:00.000Z');
  const { db, calls } = fakeQueryDb(() => [{ count: 0 }]);
  const repo = createRetentionCandidateRepo({ db, now, siteTimezone: TZ });
  await repo.counts();
  await repo.counts();
  assert.equal(calls.length, 6);
  assert.equal(calls[0].values[0], calls[3].values[0]);
  assert.equal(calls[1].values[0], calls[4].values[0]);
});
