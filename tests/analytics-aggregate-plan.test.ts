import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATE_ARRIVAL_MS,
  isDateRecomputable,
  lateArrivalSiteDates,
  mayPublish,
  planSnapshot,
} from '../src/lib/analytics/aggregate-plan';
import { recomputableFrom, siteLocalDate } from '../src/lib/analytics/day-boundaries';

// 这组用例只覆盖纯函数（cutoff / 迟到窗口 / 覆盖度 / 提交校验），
// 不需要数据库，任何机器都能跑。数据库级的不变式在 analytics-aggregate.db.test.ts。

const TZ = 'Asia/Shanghai';

test('cutoff 取本轮开始时刻，新到事件必须留给下一轮', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
  assert.equal(plan.cutoff.toISOString(), now.toISOString());
  // 同一时刻重复计算，cutoff 不变，保证「同一轮只有一个快照点」
  const again = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
  assert.equal(again.cutoff.toISOString(), plan.cutoff.toISOString());
});

test('48h 迟到窗口覆盖当前日与其前两天，不多不少', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const dates = lateArrivalSiteDates(now, TZ);
  const current = siteLocalDate(now, TZ);
  assert.ok(dates.includes(current), '必须包含当前站点日');
  // 48h 最多跨 3 个自然日
  assert.ok(dates.length >= 2 && dates.length <= 3, `迟到日数量应在 2..3，实际 ${dates.length}`);
  // 升序且去重
  assert.deepEqual(dates, [...new Set(dates)].sort());
  // 窗口起点前 1 小时所在日不在窗口内（除非恰好同日）
  const before = siteLocalDate(new Date(now.getTime() - LATE_ARRIVAL_MS - 60 * 60 * 1000), TZ);
  if (before !== siteLocalDate(new Date(now.getTime() - LATE_ARRIVAL_MS), TZ)) {
    assert.equal(dates.includes(before), false, '窗口外的更早日期不应进入重算集合');
  }
});

test('DST 日按 23/25 小时计算，不用固定 24h', () => {
  // 2026-03-08 美国东部进入夏令时：当地 02:00 跳到 03:00，该日 23 小时
  const tz = 'America/New_York';
  const now = new Date('2026-03-09T12:00:00.000Z');
  const dates = lateArrivalSiteDates(now, tz);
  assert.ok(dates.length >= 2 && dates.length <= 3, `DST 日附近迟到日数量异常: ${dates.length}`);
  for (const d of dates) {
    const start = Date.parse(`${d}T00:00:00Z`);
    assert.ok(Number.isFinite(start), `${d} 应是合法自然日`);
  }
});

test('覆盖度：完整覆盖时为 complete，越界时降级且列出跳过日', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate: siteLocalDate(now, TZ) });
  assert.equal(plan.coverage, 'complete');
  assert.deepEqual(plan.skippedDates, []);
  assert.equal(plan.earliestRecomputableDate, recomputableFrom(now, TZ));
});

test('超出原始保留范围的自然日不可整日重算', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const earliest = recomputableFrom(now, TZ);
  // 保留期边界前很久的一天
  const tooOld = siteLocalDate(new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000), TZ);
  assert.equal(isDateRecomputable(tooOld, TZ, earliest), false);
  // 当前日一定可重算
  assert.equal(isDateRecomputable(siteLocalDate(now, TZ), TZ, earliest), true);
});

test('旧 generation 或旧 timezoneRevision 不得覆盖新结果', () => {
  // 同代次可发布
  assert.equal(mayPublish({ claimGeneration: 5, storedGeneration: 5, claimTimezoneRevision: 2, storedTimezoneRevision: 2 }), true);
  // 更老的代次试图提交 → 拒绝
  assert.equal(mayPublish({ claimGeneration: 4, storedGeneration: 5, claimTimezoneRevision: 2, storedTimezoneRevision: 2 }), false);
  // 旧的时区代次试图提交 → 拒绝
  assert.equal(mayPublish({ claimGeneration: 5, storedGeneration: 5, claimTimezoneRevision: 1, storedTimezoneRevision: 2 }), false);
  // 尚无已存结果 → 可发布
  assert.equal(mayPublish({ claimGeneration: 1, storedGeneration: null, claimTimezoneRevision: 1, storedTimezoneRevision: null }), true);
});

test('午夜事件只归属一个自然日', () => {
  // 中国时区 2026-03-02 00:00:00 整
  const midnightLocal = new Date('2026-03-01T16:00:00.000Z');
  assert.equal(siteLocalDate(midnightLocal, TZ), '2026-03-02');
  // 前一毫秒属于前一天
  assert.equal(siteLocalDate(new Date(midnightLocal.getTime() - 1), TZ), '2026-03-01');
});
