import { recomputableFrom, siteDayUtcBounds, siteLocalDate, type SiteDayBounds } from './day-boundaries';

/** 一次运行最多重算这么多个已结束的站点日，从最早未完成的日子开始。 */
export const ROLLUP_MAX_DAYS = 7;

export const ANALYTICS_EVENT_KINDS = [
  'page_view',
  'product_view',
  'model_view_start',
  'model_load_success',
  'model_load_failure',
  'chat_start',
] as const;

export type AnalyticsRollupKind = (typeof ANALYTICS_EVENT_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENT_KINDS);
const SMOKE_PREFIX = 'nbs-smoke-';

export class RollupEventError extends Error {
  constructor() {
    super('invalid_rollup_event');
    this.name = 'RollupEventError';
  }
}

export type RollupSourceEvent = {
  occurredAt: Date;
  receivedAt: Date;
  kind: string;
  locale: string;
  productSlug: string | null;
  path: string | null;
  browserHash: string;
};

export type DailyRollupRow = {
  siteDate: string;
  kind: AnalyticsRollupKind;
  locale: string;
  /** 没有产品时是空字符串，不是 null。 */
  productSlug: string;
  count: number;
  uniqueBrowsers: number;
};

export type StoredRollupDay = {
  siteDate: string;
  timezoneRevision: number;
  sourceMaxReceivedAt: string | null;
};

export type DayFreshness = {
  siteDate: string;
  /** 这一天非冒烟事件里最晚的 receivedAt。没有这类事件时为 null。 */
  sourceMaxReceivedAt: string | null;
};

/**
 * 冒烟路径不进汇总，也不进 eventCount。入库路径带语言前缀，例如 /en/nbs-smoke-probe。
 * 任一路径段以 nbs-smoke- 开头即排除；段中间出现这串字不算。查询串和片段先去掉。
 * server/analytics/rollup.ts 里的 SQL 谓词必须和这里同一规则。
 */
export function isSmokeAnalyticsPath(path: string | null | undefined): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  const pathname = path.split(/[?#]/, 1)[0];
  if (pathname.startsWith(SMOKE_PREFIX)) return true;
  return pathname.split('/').some((segment) => segment.startsWith(SMOKE_PREFIX));
}

/** 当前时区下可以整日重算、并且已经完整结束的站点本地日，从最早到昨天。不含今天和未来。 */
export function eligibleSiteDates(now: Date, timeZone: string): string[] {
  const floor = recomputableFrom(now, timeZone);
  const today = siteLocalDate(now, timeZone);
  const dates: string[] = [];
  let cursor = siteLocalDate(new Date(floor), timeZone);
  for (let guard = 0; guard < 40 && cursor < today; guard += 1) {
    const bounds = siteDayUtcBounds(cursor, timeZone);
    const start = Date.parse(bounds.startUtc);
    const end = Date.parse(bounds.endUtc);
    if (start >= Date.parse(floor) && end <= now.getTime()) dates.push(cursor);
    const next = siteLocalDate(new Date(bounds.endUtc), timeZone);
    if (next <= cursor) break;
    cursor = next;
  }
  return dates;
}

/**
 * 从最早的未完成日开始，最多取 maxDays 天。
 * 当前时区代次不符，或非冒烟事件的 receivedAt 比已记录的 sourceMaxReceivedAt 更新，都要重算。
 */
export function selectRollupDates(input: {
  eligible: readonly string[];
  stored: readonly StoredRollupDay[];
  freshness: readonly DayFreshness[];
  timezoneRevision: number;
  maxDays?: number;
}): string[] {
  const maxDays = input.maxDays ?? ROLLUP_MAX_DAYS;
  const stored = new Map(input.stored.map((day) => [day.siteDate, day]));
  const freshness = new Map(input.freshness.map((day) => [day.siteDate, day.sourceMaxReceivedAt]));
  const chosen: string[] = [];
  for (const siteDate of input.eligible) {
    if (needsWork(stored.get(siteDate), freshness.get(siteDate), input.timezoneRevision)) chosen.push(siteDate);
    if (chosen.length >= maxDays) break;
  }
  return chosen;
}

function needsWork(stored: StoredRollupDay | undefined, currentMax: string | null | undefined, timezoneRevision: number): boolean {
  if (!stored || stored.timezoneRevision !== timezoneRevision) return true;
  if (currentMax === undefined) return true;
  if (currentMax === null) return false;
  if (stored.sourceMaxReceivedAt === null) return true;
  return Date.parse(currentMax) > Date.parse(stored.sourceMaxReceivedAt);
}

/** 把已经落在这一天左闭右开窗口里的非冒烟事件收成计数。同一输入重复调用，行和计数相同。 */
export function aggregateSiteDay(events: readonly RollupSourceEvent[], bounds: SiteDayBounds): {
  rows: DailyRollupRow[];
  eventCount: number;
  sourceMaxReceivedAt: Date | null;
} {
  const start = Date.parse(bounds.startUtc);
  const end = Date.parse(bounds.endUtc);
  const groups = new Map<string, { kind: AnalyticsRollupKind; locale: string; productSlug: string; count: number; browsers: Set<string> }>();
  let eventCount = 0;
  let maxReceived: number | null = null;
  for (const event of events) {
    if (!validInstant(event.occurredAt) || !validInstant(event.receivedAt)) throw new RollupEventError();
    const occurred = event.occurredAt.getTime();
    if (occurred < start || occurred >= end) continue;
    if (isSmokeAnalyticsPath(event.path)) continue;
    if (!KIND_SET.has(event.kind) || !/^[a-z]{2}$/.test(event.locale)) throw new RollupEventError();
    const productSlug = event.productSlug ?? '';
    if (productSlug !== '' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(productSlug)) throw new RollupEventError();
    if (typeof event.browserHash !== 'string' || event.browserHash.length === 0) throw new RollupEventError();
    eventCount += 1;
    const received = event.receivedAt.getTime();
    if (maxReceived === null || received > maxReceived) maxReceived = received;
    const key = `${event.kind}\u001f${event.locale}\u001f${productSlug}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.browsers.add(event.browserHash);
    } else {
      groups.set(key, {
        kind: event.kind as AnalyticsRollupKind,
        locale: event.locale,
        productSlug,
        count: 1,
        browsers: new Set([event.browserHash]),
      });
    }
  }
  const rows = [...groups.values()]
    .map((group) => ({
      siteDate: bounds.localDate,
      kind: group.kind,
      locale: group.locale,
      productSlug: group.productSlug,
      count: group.count,
      uniqueBrowsers: group.browsers.size,
    }))
    .sort((left, right) => left.kind.localeCompare(right.kind)
      || left.locale.localeCompare(right.locale)
      || left.productSlug.localeCompare(right.productSlug));
  return {
    rows,
    eventCount,
    sourceMaxReceivedAt: maxReceived === null ? null : new Date(maxReceived),
  };
}

/** 当前代次里，从最早一个已完成日连续走到的最后一天。中间有空缺就停在空缺之前。 */
export function latestContiguousDate(siteDates: readonly string[]): string | null {
  const dates = [...siteDates].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  if (dates.length === 0) return null;
  let last = dates[0];
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] !== nextCalendarDate(last)) break;
    last = dates[index];
  }
  return last;
}

function nextCalendarDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + 1));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function validInstant(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}
