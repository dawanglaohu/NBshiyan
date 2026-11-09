/**
 * M5-T3 一致快照聚合：cutoff、迟到重算窗口、可用性判定。
 *
 * 09 节约束（`09-数据模型.md:71-72`）：
 * - 每轮捕获 cutoff 与 RepeatableRead 快照，按 `receivedAt ≤ cutoff` 且该快照可见的原始事实重算；
 * - 重算「当前日」与「48h 迟到可能影响的日」；
 * - 只重算 dayStart 不早于完整原始覆盖起点的自然日，禁止用已部分清理日的残片替换完整旧聚合；
 * - 超范围返回 `coverage=partial/unavailable` 及最早可重算时间，不能填 0、不能混算。
 *
 * 日界与保留期的计算一律复用 `day-boundaries.ts`，本文件只补它没有的
 * 「cutoff + 48h 迟到窗口 + 覆盖度」这一层，避免重复实现时区逻辑。
 */
import {
  recomputableFrom,
  siteDayUtcBounds,
  siteLocalDate,
} from './day-boundaries';

/** 迟到准入窗口：事件发生时间最远可回溯 48h（09 节 `:69`）。 */
export const LATE_ARRIVAL_MS = 48 * 60 * 60 * 1000;

/** 覆盖度状态。`complete` 表示本轮所有目标日都可整日重算。 */
export type CoverageState = 'complete' | 'partial' | 'unavailable';

/** 因超出完整原始覆盖而无法重算的连续区间；不逐日枚举、不塞进 skippedDates。 */
export type SkippedRange = { from: string; to: string; dayCount: number };

export type SnapshotPlan = {
  /** 本轮快照时间点：只统计 receivedAt ≤ cutoff 的事件。 */
  cutoff: Date;
  /** 需要重算的站点自然日（升序、去重、不晚于当前日）。 */
  siteDates: string[];
  /** 因超出完整原始覆盖而无法全部重算时的覆盖度。 */
  coverage: CoverageState;
  /** 仍可整日重算的最早日界（`recomputableFrom` 的结果），供 DTO 说明。 */
  earliestRecomputableDate: string;
  /** 因超出覆盖范围而被跳过的目标日。 */
  skippedDates: string[];
  /** 重算起点早于完整原始覆盖时，被跳过的连续区间；无则为 null。 */
  skippedRange: SkippedRange | null;
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function localDateOrdinal(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** 站点自然日标签加减（UTC 日序，不受 DST 23/25h 影响）。 */
export function shiftLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** 闭区间日数；`to < from` 时为 0。 */
export function localDateDayCount(from: string, to: string): number {
  const diff = localDateOrdinal(to) - localDateOrdinal(from);
  return diff < 0 ? 0 : Math.round(diff / 86_400_000) + 1;
}

/** 闭区间枚举（升序）；`to < from` 时为空。 */
export function localDateRange(from: string, to: string): string[] {
  const count = localDateDayCount(from, to);
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) out.push(shiftLocalDate(from, index));
  return out;
}

/**
 * 48h 迟到可能影响的站点自然日。
 *
 * 在 `now` 到达的事件，其 occurredAt 最远可回溯 48h，因此只有 occurredAt 落在
 * `[now-48h, now]` 内的自然日可能被迟到事件改变。用小时步进而不是固定 24h，
 * 避免 DST 日（23/25 小时）漏掉边界那一天。
 */
export function lateArrivalSiteDates(now: Date, siteTimezone: string): string[] {
  const from = now.getTime() - LATE_ARRIVAL_MS;
  const out = new Set<string>();
  const stepMs = 60 * 60 * 1000;
  for (let t = from; t <= now.getTime(); t += stepMs) {
    out.add(siteLocalDate(new Date(t), siteTimezone));
  }
  out.add(siteLocalDate(now, siteTimezone));
  return [...out].sort();
}

/**
 * 判断某自然日是否可整日重算。
 * 比较用该日 `[dayStart, nextDayStart)` 的 UTC 起点与最早可重算日界，
 * 与 `recomputableFrom` 的口径一致（横跨保留截止的残日不可用）。
 */
export function isDateRecomputable(siteDate: string, siteTimezone: string, earliestRecomputable: string): boolean {
  return Date.parse(siteDayUtcBounds(siteDate, siteTimezone).startUtc) >= Date.parse(earliestRecomputable);
}

/**
 * 生成本轮快照计划。
 *
 * @param now 本轮开始时间
 * @param siteTimezone 站点 IANA 时区（取自当前 settings revision，提交前还需重查）
 * @param currentDate 当前站点自然日
 * @param rebuildFrom 可选：时区切换后的重算起点（UTC 瞬时，调用方已排除未来）
 */
export function planSnapshot(input: {
  now: Date;
  siteTimezone: string;
  currentDate: string;
  rebuildFrom?: string;
}): SnapshotPlan {
  const { now, siteTimezone, currentDate, rebuildFrom } = input;
  const earliest = recomputableFrom(now, siteTimezone);
  const earliestDate = siteLocalDate(new Date(earliest), siteTimezone);
  // 上界是「此刻的站点日」，不是调用方传入的候选日：候选日可能是更早的旧日。
  const upperDate = siteLocalDate(now, siteTimezone);

  const candidates = new Set<string>();
  let skippedRange: SkippedRange | null = null;
  if (rebuildFrom === undefined) {
    candidates.add(currentDate);
    for (const date of lateArrivalSiteDates(now, siteTimezone)) candidates.add(date);
  } else {
    // floor 是日界瞬时，必须先映射成站点日；不能取 ISO 前 10 位。
    const floorDate = siteLocalDate(new Date(rebuildFrom), siteTimezone);
    const windowStart = floorDate > earliestDate ? floorDate : earliestDate;
    // 窗口 = [max(floor, earliest), 当前站点日]：floor 之前的迟到日不属于新 revision 的重算范围。
    for (const date of localDateRange(windowStart, upperDate)) candidates.add(date);
    if (floorDate < windowStart) {
      const to = shiftLocalDate(windowStart, -1);
      skippedRange = { from: floorDate, to, dayCount: localDateDayCount(floorDate, to) };
    }
  }

  const siteDates: string[] = [];
  const skippedDates: string[] = [];
  for (const date of [...candidates].sort()) {
    // 上界先定死：不枚举当前站点日之后的日子。
    if (date > upperDate) continue;
    if (isDateRecomputable(date, siteTimezone, earliest)) siteDates.push(date);
    else skippedDates.push(date);
  }

  const coverage: CoverageState =
    siteDates.length === 0 ? 'unavailable' : skippedRange !== null || skippedDates.length > 0 ? 'partial' : 'complete';

  return {
    // cutoff 取「此刻」：receivedAt 晚于它的新事件必须留给下一轮，
    // 不能在本轮已发布的结果上滚加（E-80）。
    cutoff: new Date(now.getTime()),
    siteDates,
    coverage,
    earliestRecomputableDate: earliest,
    skippedDates,
    skippedRange,
  };
}

/**
 * 提交校验：旧 generation 或旧 timezoneRevision 一律拒绝提交（E-81/E-83）。
 * `null` 表示尚无已存结果，可直接发布。
 */
export function mayPublish(input: {
  claimGeneration: number;
  storedGeneration: number | null;
  claimTimezoneRevision: number;
  storedTimezoneRevision: number | null;
}): boolean {
  const { claimGeneration, storedGeneration, claimTimezoneRevision, storedTimezoneRevision } = input;
  if (storedGeneration !== null && storedGeneration > claimGeneration) return false;
  if (storedTimezoneRevision !== null && storedTimezoneRevision > claimTimezoneRevision) return false;
  return true;
}
