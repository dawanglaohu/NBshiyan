import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  RETENTION_CLEANUP_MAX_PER_RUN,
  candidateCountLabels,
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
  assert.deepEqual(counts, {
    events: 7,
    rollupDailyRows: 3,
    rollupDays: 2,
    total: 12,
    daily: 2,
    dayState: 0,
    dayChange: 2,
    totalAll: 16,
  });
  assert.equal(calls.length, 6);
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
  assert.equal(calls.length, 12);
  assert.equal(calls[0].values[0], calls[6].values[0]);
  assert.equal(calls[1].values[0], calls[7].values[0]);
});

test('B1：月末夹取时截止日以正推 expiresAt 为准（Jan31 → Feb28）', () => {
  // Asia/Shanghai 2027-02-28 12:00；自然月正推会把 2026-01-29..31 都夹到 2027-02-28。
  const today = new Date('2027-02-28T04:00:00.000Z');
  assert.equal(siteLocalDate(today, TZ), '2027-02-28');
  assert.equal(rollupExpiresAt('2026-01-31'), '2027-02-28');
  assert.equal(rollupExpiresAt('2026-02-01'), '2027-03-01');
  assert.equal(rollupExpiryCutoff(today, TZ), '2026-01-31');
  assert.equal(isRollupExpired('2026-01-31', today, TZ), true);
  assert.equal(isRollupExpired('2026-02-01', today, TZ), false);
});

test('B1：Mar31 → Apr30 与闰年二月的截止日', () => {
  const apr30 = new Date('2027-04-30T04:00:00.000Z');
  assert.equal(rollupExpiresAt('2026-03-31'), '2027-04-30');
  assert.equal(rollupExpiryCutoff(apr30, TZ), '2026-03-31');
  assert.equal(isRollupExpired('2026-03-31', apr30, TZ), true);
  assert.equal(isRollupExpired('2026-04-01', apr30, TZ), false);

  // 闰年：2023-01-31 + 13 个月 = 2024-02-29；到 2024-02-29 当天算到期。
  const leapDay = new Date('2024-02-29T04:00:00.000Z');
  assert.equal(siteLocalDate(leapDay, TZ), '2024-02-29');
  assert.equal(rollupExpiresAt('2023-01-31'), '2024-02-29');
  assert.equal(rollupExpiryCutoff(leapDay, TZ), '2023-01-31');
  assert.equal(isRollupExpired('2023-01-31', leapDay, TZ), true);
  assert.equal(isRollupExpired('2023-02-01', leapDay, TZ), false);
});

test('B1：普通非月末日期与到期前/当日/后的边界', () => {
  const onExpiry = new Date('2027-02-15T04:00:00.000Z');
  assert.equal(rollupExpiryCutoff(onExpiry, TZ), '2026-01-15');
  assert.equal(isRollupExpired('2026-01-15', onExpiry, TZ), true);
  assert.equal(isRollupExpired('2026-01-16', onExpiry, TZ), false);

  const dayBefore = new Date(onExpiry.getTime() - 24 * 60 * 60 * 1000);
  assert.equal(siteLocalDate(dayBefore, TZ), '2027-02-14');
  assert.equal(rollupExpiryCutoff(dayBefore, TZ), '2026-01-14');
  assert.equal(isRollupExpired('2026-01-14', dayBefore, TZ), true);
  assert.equal(isRollupExpired('2026-01-15', dayBefore, TZ), false);

  const dayAfter = new Date(onExpiry.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(rollupExpiryCutoff(dayAfter, TZ), '2026-01-16');
  assert.equal(isRollupExpired('2026-01-16', dayAfter, TZ), true);
});

test('B1：候选计数、列表与判定共用同一边界', async () => {
  const today = new Date('2027-02-28T04:00:00.000Z');
  const cutoff = rollupExpiryCutoff(today, TZ);
  assert.equal(cutoff, '2026-01-31');
  const { db, calls } = fakeQueryDb(() => [{ count: 1 }]);
  const repo = createRetentionCandidateRepo({ db, now: today, siteTimezone: TZ });
  await repo.counts();
  assert.equal(calls[1].values[0], cutoff, '汇总行计数必须用修正后的截止日');
  assert.equal(calls[2].values[0], cutoff, 'watermark 计数必须用修正后的截止日');
});

const PG_URL = process.env.M5T5_TEST_DATABASE_URL?.startsWith('postgres')
  ? process.env.M5T5_TEST_DATABASE_URL
  : null;
// e2e job 设 M5T5_REQUIRE_DATABASE=true：缺地址不能让 PG 用例静默跳过，必须失败；
// 无库的单元 job 不设该 flag，继续明确 skip。
const REQUIRE_PG = process.env.M5T5_REQUIRE_DATABASE === 'true';

test('B1 真实 PG：月末截止日行命中、次日未到期行排除（计数与列表一致）', {
  skip: !PG_URL && !REQUIRE_PG && 'no M5T5_TEST_DATABASE_URL',
}, async () => {
  if (!PG_URL) {
    throw new Error('M5T5_REQUIRE_DATABASE=true 时 M5T5_TEST_DATABASE_URL 必须设置（PG 用例不允许静默 skip）');
  }
  const schema = `m5t5_b1_${process.pid}`;
  const url = `${PG_URL}${PG_URL.includes('?') ? '&' : '?'}schema=${encodeURIComponent(schema)}`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const { execFileSync } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    execFileSync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 站点日 2027-02-28：2026-01-30/31 已到期（31 日经月末夹取），2026-02-01 未到期。
    await db.$executeRawUnsafe(`
      INSERT INTO "AnalyticsRollupDay" ("siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt")
      VALUES
        ('2026-01-30', 1, '2026-02-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC', 1, NULL, now(), now()),
        ('2026-01-31', 1, '2026-02-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC', 2, NULL, now(), now()),
        ('2026-02-01', 1, '2026-02-02T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC', 3, NULL, now(), now())
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "AnalyticsDailyRollup" ("siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt")
      VALUES
        ('2026-01-31', 'page_view'::"AnalyticsEventKind", 'en', '', 2, 1, now(), now()),
        ('2026-02-01', 'page_view'::"AnalyticsEventKind", 'en', '', 3, 1, now(), now())
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "AnalyticsEvent" ("eventId", "semanticKey", "payloadHash", "browserHash", "kind", "locale", "productSlug", "path", "occurredAt", "receivedAt")
      VALUES
        ('ev-expired', 'sk-expired', '${'p'.repeat(64)}', 'bh-1', 'page_view'::"AnalyticsEventKind", 'en', NULL, '/en',
         '2026-01-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC', '2026-01-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC'),
        ('ev-fresh', 'sk-fresh', '${'p'.repeat(64)}', 'bh-2', 'page_view'::"AnalyticsEventKind", 'en', NULL, '/en',
         '2027-02-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC', '2027-02-01T00:00:00.000Z'::timestamptz AT TIME ZONE 'UTC')
    `);

    const now = new Date('2027-02-28T04:00:00.000Z');
    const cutoff = rollupExpiryCutoff(now, TZ);
    assert.equal(cutoff, '2026-01-31');
    assert.equal(isRollupExpired('2026-02-01', now, TZ), false);

    const repo = createRetentionCandidateRepo({ db, now, siteTimezone: TZ });
    const counts = await repo.counts();
    // 候选计数扩为八字段（旧三表 + AnalyticsDaily + state + dayChange 上界 + 六表合计）：total 仍是旧三表语义。
    assert.deepEqual(counts, {
      events: 1,
      rollupDailyRows: 1,
      rollupDays: 2,
      total: 4,
      daily: 0,
      dayState: 0,
      dayChange: 0,
      totalAll: 4,
    });
    assert.deepEqual(await repo.rollupDays(10), ['2026-01-30', '2026-01-31']);
    assert.deepEqual(
      (await repo.rollupDailyKeys(10)).map((key) => key.siteDate),
      ['2026-01-31'],
    );
    assert.deepEqual(await repo.eventIds(10), ['ev-expired']);
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await db.$disconnect();
  }
});

test('dry-run 候选分账：新三表独立计数，旧三表语义不变', async () => {
  const db = {
    $queryRaw: async (strings: unknown, ...values: unknown[]) => {
      const arg = strings as { strings?: readonly string[] } | readonly string[];
      const text = Array.isArray(arg)
        ? (arg as readonly string[]).join('?')
        : ((arg as { strings?: readonly string[] }).strings ?? []).join('?');
      if (text.includes('FROM "AnalyticsEvent"')) return [{ count: 11 }];
      if (text.includes('FROM "AnalyticsDailyRollup"')) return [{ count: 5 }];
      if (text.includes('FROM "AnalyticsRollupDay"')) return [{ count: 4 }];
      if (text.includes('FROM "AnalyticsDaily"') && text.includes('"expiresAt" >')) {
        return [{ localDate: '2025-01-02', timezoneRevision: 1 }];
      }
      if (text.includes('FROM "AnalyticsDaily"')) return [{ count: 7 }];
      if (text.includes('FROM "AnalyticsAggregateDayState"')) {
        return [
          { localDate: '2025-01-01', timezoneRevision: 1, timezone: 'UTC' },
          { localDate: '2025-01-02', timezoneRevision: 1, timezone: 'UTC' },
          { localDate: '2027-01-01', timezoneRevision: 1, timezone: 'UTC' },
        ];
      }
      if (text.includes('FROM "AnalyticsDayChange"')) return [{ count: 3 }];
      void values;
      return [];
    },
  };
  const repo = createRetentionCandidateRepo({
    db: db as never,
    now: new Date('2026-05-01T00:00:00.000Z'),
    siteTimezone: 'UTC',
  });
  const counts = await repo.counts();
  assert.equal(counts.events, 11);
  assert.equal(counts.rollupDailyRows, 5);
  assert.equal(counts.rollupDays, 4);
  assert.equal(counts.total, 20, '旧三表合计语义不变');
  assert.equal(counts.daily, 7);
  assert.equal(counts.dayState, 1, '2027 未到期、2025-01-02 被未到期 Daily 挡住');
  assert.equal(counts.dayChange, 3);
  assert.equal(counts.totalAll, 31);
});

test('候选计数的生产日志口径：metadata 不进四表上限，上界与六表读数是分开的标签', () => {
  const counts = {
    events: 11,
    rollupDailyRows: 5,
    rollupDays: 4,
    total: 20,
    daily: 7,
    dayState: 1,
    dayChange: 3,
    totalAll: 31,
  };
  assert.deepEqual(candidateCountLabels(counts), {
    legacyThreeTables: 20,
    newDaily: 7,
    // 四表 20k 口径 = 旧三表 + AnalyticsDaily；metadata 两表不在这里。
    fourTableBudget: 27,
    metadataState: 1,
    metadataDayChangeUpperBound: 3,
    metadataTotal: 4,
    totalAllSixTables: 31,
  });
  const labels = candidateCountLabels(counts);
  assert.notEqual(labels.fourTableBudget, labels.totalAllSixTables);
  assert.equal(labels.fourTableBudget + labels.metadataTotal, labels.totalAllSixTables);
});
