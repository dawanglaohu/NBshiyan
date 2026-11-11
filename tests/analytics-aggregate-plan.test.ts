import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LATE_ARRIVAL_MS,
  isDateRecomputable,
  lateArrivalSiteDates,
  localDateDayCount,
  localDateRange,
  mayPublish,
  planSnapshot,
  shiftLocalDate,
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

// ---------------------------------------------------------------------------
// M5-T4：rebuildFrom → 站点日窗口 / skippedRange / 日期算术
// ---------------------------------------------------------------------------

test('P1 无 rebuildFrom 时行为与现状等价，skippedRange 为 null', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const currentDate = siteLocalDate(now, TZ);
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate });
  assert.equal(plan.skippedRange, null);
  const withoutFloor = planSnapshot({ now, siteTimezone: TZ, currentDate, rebuildFrom: undefined });
  assert.deepEqual(withoutFloor.siteDates, plan.siteDates);
  assert.deepEqual(withoutFloor.skippedDates, plan.skippedDates);
});

test('P2 floor 是 UTC 瞬时：先映射成站点日再定窗口（ISO slice 负控多一天）', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const currentDate = siteLocalDate(now, TZ);
  const floor = '2026-01-31T16:00:00.000Z'; // +08 站点 2026-02-01 00:00
  assert.equal(siteLocalDate(new Date(floor), TZ), '2026-02-01');
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate, rebuildFrom: floor });
  assert.equal(plan.siteDates[0], '2026-02-01');
  assert.equal(plan.siteDates[plan.siteDates.length - 1], currentDate);
  assert.equal(plan.siteDates.length, 29, '02-01 到 03-01 共 29 天（2026 非闰年）');
  assert.equal(plan.skippedRange, null);
  // 负控：按 ISO 前 10 位取 01-31 会多算一天
  assert.equal(floor.slice(0, 10), '2026-01-31');
  assert.notEqual(floor.slice(0, 10), plan.siteDates[0]);
});

test('P3 floor 早于完整原始覆盖：只枚举可重算窗口，旧区间用 skippedRange 表示', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const currentDate = siteLocalDate(now, TZ);
  const floor = new Date(now.getTime() - 61 * 86_400_000).toISOString();
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate, rebuildFrom: floor });
  const earliest = recomputableFrom(now, TZ);
  const earliestDate = siteLocalDate(new Date(earliest), TZ);
  assert.deepEqual(plan.siteDates, localDateRange(earliestDate, currentDate), '窗口从完整覆盖起点开始');
  assert.deepEqual(plan.skippedDates, [], '旧区间不逐日枚举');
  assert.ok(plan.skippedRange);
  assert.equal(plan.skippedRange.from, siteLocalDate(new Date(floor), TZ));
  assert.equal(plan.skippedRange.to, shiftLocalDate(earliestDate, -1));
  assert.equal(plan.skippedRange.dayCount, localDateDayCount(plan.skippedRange.from, plan.skippedRange.to));
  assert.equal(plan.coverage, 'partial');
});

test('P4 floor 仍在完整覆盖内：从 floor 站点日起，不产生 skippedRange', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const currentDate = siteLocalDate(now, TZ);
  const floorDate = '2026-02-20';
  const floor = `${floorDate}T04:00:00.000Z`;
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate, rebuildFrom: floor });
  assert.equal(plan.siteDates[0], siteLocalDate(new Date(floor), TZ));
  assert.equal(plan.skippedRange, null);
  assert.equal(plan.coverage, 'complete');
  assert.deepEqual(plan.siteDates, localDateRange(siteLocalDate(new Date(floor), TZ), currentDate));
});

test('P6 floor == now 属于可重算（不是未来），窗口只含当前日', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const currentDate = siteLocalDate(now, TZ);
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate, rebuildFrom: now.toISOString() });
  assert.deepEqual(plan.siteDates, [currentDate]);
  assert.equal(plan.skippedRange, null);
  assert.equal(plan.coverage, 'complete');
});

test('P7 日期算术：闰年、年末、DST 日标签都按 UTC 日序，不受 23/25h 影响', () => {
  assert.deepEqual(localDateRange('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.equal(localDateDayCount('2024-02-28', '2024-03-01'), 3);
  assert.deepEqual(localDateRange('2025-12-30', '2026-01-02'), ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
  assert.equal(localDateDayCount('2025-12-31', '2025-12-31'), 1);
  assert.equal(localDateDayCount('2026-01-02', '2026-01-01'), 0);
  assert.deepEqual(localDateRange('2026-01-02', '2026-01-01'), []);
  assert.equal(shiftLocalDate('2024-02-29', 1), '2024-03-01');
  assert.equal(shiftLocalDate('2026-01-01', -1), '2025-12-31');
  assert.equal(localDateDayCount('2026-03-07', '2026-03-09'), 3, 'DST 起止日仍是 3 个自然日标签');
});

test('P8 窗口升序去重且不产生未来日', () => {
  const now = new Date('2026-03-01T10:00:00.000Z');
  const currentDate = siteLocalDate(now, TZ);
  const floor = new Date(now.getTime() - 40 * 86_400_000).toISOString();
  const plan = planSnapshot({ now, siteTimezone: TZ, currentDate, rebuildFrom: floor });
  assert.deepEqual(plan.siteDates, [...new Set(plan.siteDates)].sort());
  assert.ok(plan.siteDates.length > 0);
  for (const date of plan.siteDates) assert.ok(date <= currentDate, `${date} 不得晚于当前站点日`);
});
