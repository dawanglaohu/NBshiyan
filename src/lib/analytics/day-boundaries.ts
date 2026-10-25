import { LocalDateSchema, TimezoneSchema } from '../contracts/common';

/** 原始事件按 receivedAt 保留的绝对时长。不是本地日历月，夏令时不改变这个截止时刻。 */
export const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SiteDayBounds = {
  localDate: string;
  timezone: string;
  /** 本地午夜，含此刻。 */
  startUtc: string;
  /** 次日本地午夜，不含此刻。 */
  endUtc: string;
};

export class DayBoundaryError extends Error {
  readonly reason: 'invalid_timezone' | 'invalid_date' | 'invalid_instant';

  constructor(reason: 'invalid_timezone' | 'invalid_date' | 'invalid_instant') {
    super(reason);
    this.name = 'DayBoundaryError';
    this.reason = reason;
  }
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function assertTimezone(timeZone: string): string {
  const parsed = TimezoneSchema.safeParse(timeZone);
  if (!parsed.success) throw new DayBoundaryError('invalid_timezone');
  return parsed.data;
}

function assertInstant(instant: Date): Date {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new DayBoundaryError('invalid_instant');
  return instant;
}

function assertLocalDate(localDate: string): string {
  const parsed = LocalDateSchema.safeParse(localDate);
  if (!parsed.success) throw new DayBoundaryError('invalid_date');
  return parsed.data;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function wallParts(instant: Date, timeZone: string): WallClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new DayBoundaryError('invalid_timezone');
  }
  const pick = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value || !/^\d+$/.test(value)) throw new DayBoundaryError('invalid_timezone');
    return Number(value);
  };
  let year = pick('year');
  let month = pick('month');
  let day = pick('day');
  let hour = pick('hour');
  if (hour === 24) {
    hour = 0;
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return { year, month, day, hour, minute: pick('minute'), second: pick('second') };
}

function isWall(instant: Date, expected: WallClock, timeZone: string): boolean {
  const wall = wallParts(instant, timeZone);
  return wall.year === expected.year
    && wall.month === expected.month
    && wall.day === expected.day
    && wall.hour === expected.hour
    && wall.minute === expected.minute
    && wall.second === expected.second;
}

function offsetMs(instant: Date, timeZone: string): number {
  const wall = wallParts(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function shiftLocalDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const label = `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  return assertLocalDate(label);
}

/** 找到格式化为该本地午夜的最早 UTC 时刻。重叠时取较早的一个，保证左闭右开不重不漏。 */
function localMidnightUtc(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  const expected: WallClock = { year, month, day, hour: 0, minute: 0, second: 0 };
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = offsetMs(new Date(guess), timeZone);
  const candidates = [guess - first];
  const second = offsetMs(new Date(candidates[0]), timeZone);
  if (second !== first) candidates.push(guess - second);
  for (const utc of candidates) {
    const instant = new Date(utc);
    if (isWall(instant, expected, timeZone)) return instant;
  }
  let earliest: number | null = null;
  for (let minute = -14 * 60; minute <= 14 * 60; minute += 1) {
    const utc = guess - minute * 60 * 1000;
    const instant = new Date(utc);
    if (!isWall(instant, expected, timeZone)) continue;
    if (earliest === null || utc < earliest) earliest = utc;
  }
  if (earliest === null) throw new DayBoundaryError('invalid_date');
  return new Date(earliest);
}

/**
 * 站点自然日的 UTC 边界。browserTimezone 只是调用方带来的查看者时区，不参与计算，也不能在站点时区无效时代替它。
 */
export function siteDayUtcBounds(localDate: string, siteTimezone: string, browserTimezone?: string): SiteDayBounds {
  void browserTimezone;
  const timezone = assertTimezone(siteTimezone);
  const date = assertLocalDate(localDate);
  const start = localMidnightUtc(date, timezone);
  const end = localMidnightUtc(shiftLocalDate(date, 1), timezone);
  if (end.getTime() <= start.getTime()) throw new DayBoundaryError('invalid_date');
  return { localDate: date, timezone, startUtc: start.toISOString(), endUtc: end.toISOString() };
}

/** 该 UTC 时刻所属的站点本地日。午夜属于新的一天。 */
export function siteLocalDate(instant: Date, siteTimezone: string, browserTimezone?: string): string {
  void browserTimezone;
  const timezone = assertTimezone(siteTimezone);
  const wall = wallParts(assertInstant(instant), timezone);
  const label = `${String(wall.year).padStart(4, '0')}-${pad(wall.month)}-${pad(wall.day)}`;
  return assertLocalDate(label);
}

/** 包含该时刻的左闭右开站点日。窗口与 formatToParts 不一致时拒绝，不用固定 24 小时补齐。 */
export function siteDayContaining(instant: Date, siteTimezone: string, browserTimezone?: string): SiteDayBounds {
  const date = siteLocalDate(instant, siteTimezone, browserTimezone);
  const bounds = siteDayUtcBounds(date, siteTimezone, browserTimezone);
  const time = assertInstant(instant).getTime();
  if (time < Date.parse(bounds.startUtc) || time >= Date.parse(bounds.endUtc)) throw new DayBoundaryError('invalid_date');
  return bounds;
}

/**
 * 仍可整日重算的最早本地午夜。dayStart 早于 receivedAt 保留截止时刻的那一天是残日，返回下一本地午夜。
 */
export function recomputableFrom(now: Date, siteTimezone: string): string {
  const cutoff = assertInstant(now).getTime() - RAW_EVENT_RETENTION_MS;
  const containing = siteDayContaining(new Date(cutoff), siteTimezone);
  if (Date.parse(containing.startUtc) >= cutoff) return containing.startUtc;
  return containing.endUtc;
}
