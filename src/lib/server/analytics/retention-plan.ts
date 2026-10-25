import { recomputableFrom, siteLocalDate } from '../../analytics/day-boundaries';
import { RAW_EVENT_RETENTION_MS, ROLLUP_RETENTION_MONTHS } from '../retention';

/** 一次删除语句最多动这么多行。每批各自提交，不把整次运行放进一个事务。 */
export const RETENTION_CLEANUP_BATCH_SIZE = 5_000;

/** 一次运行最多删除这么多行（原始事件和汇总行合计）。没删完的留给下次。 */
export const RETENTION_CLEANUP_MAX_PER_RUN = 20_000;

export type RetentionCleanupMode = 'dry-run' | 'delete';

/** 只有精确的 delete 会删行。缺省、dry-run 和其他值都只统计。 */
export function retentionCleanupMode(
  env: NodeJS.ProcessEnv | { RETENTION_CLEANUP_MODE?: string } = process.env,
): RetentionCleanupMode {
  return env.RETENTION_CLEANUP_MODE === 'delete' ? 'delete' : 'dry-run';
}

/** receivedAt 早于这个时刻的原始事件才过了 30 天。时刻本身保留。 */
export function rawEventCutoff(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('invalid_instant');
  return new Date(now.getTime() - RAW_EVENT_RETENTION_MS);
}

/**
 * 仍可整日重算的第一个站点本地日。更早的本地日才允许删除原始事件。
 * 和 recomputableFrom 同一条线：残日不在重算范围内，删除不会碰到还能重算的那一天。
 */
export function eventDeletionFloorLocalDate(now: Date, timeZone: string): string {
  return siteLocalDate(new Date(recomputableFrom(now, timeZone)), timeZone);
}

function assertLocalDate(localDate: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error('invalid_date');
  const [year, month, day] = localDate.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error('invalid_date');
  }
  return { year, month, day };
}

/** 站点本地日加减日历月。目标月没有这一天时夹到该月最后一天。 */
export function shiftCalendarMonths(localDate: string, months: number): string {
  if (!Number.isInteger(months)) throw new Error('invalid_date');
  const { year, month, day } = assertLocalDate(localDate);
  const monthIndex = year * 12 + (month - 1) + months;
  let nextYear = Math.floor(monthIndex / 12);
  let nextMonth = monthIndex % 12;
  if (nextMonth < 0) {
    nextMonth += 12;
    nextYear -= 1;
  }
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const nextDay = Math.min(day, lastDay);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(nextYear).padStart(4, '0')}-${pad(nextMonth + 1)}-${pad(nextDay)}`;
}

/** 严格早于这个站点本地日的汇总行才超过 13 个月。这一天本身保留。 */
export function rollupDeletionBefore(now: Date, timeZone: string): string {
  return shiftCalendarMonths(siteLocalDate(now, timeZone), -ROLLUP_RETENTION_MONTHS);
}

export type MarkedRollupDay = { siteDate: string; timezoneRevision: number };

/**
 * 原始事件能删的站点日。
 * contiguousThrough 只做上界：晚于它的日子，哪怕单独看已汇总，也不进名单。
 * 每一天还要当前时区代次相符，并且早于重算下限。代次不符或落在空缺之后的日子只计数。
 */
export function classifyRetentionDays(input: {
  floorLocalDate: string;
  contiguousThrough: string | null;
  currentRevision: number;
  days: readonly MarkedRollupDay[];
}): { deletable: string[]; skippedRevisionMismatchDays: number; skippedAfterGapDays: number } {
  const deletable: string[] = [];
  let skippedRevisionMismatchDays = 0;
  let skippedAfterGapDays = 0;
  for (const day of input.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.siteDate) || day.siteDate >= input.floorLocalDate) continue;
    if (day.timezoneRevision !== input.currentRevision) {
      skippedRevisionMismatchDays += 1;
      continue;
    }
    if (input.contiguousThrough === null || day.siteDate > input.contiguousThrough) {
      skippedAfterGapDays += 1;
      continue;
    }
    deletable.push(day.siteDate);
  }
  return { deletable, skippedRevisionMismatchDays, skippedAfterGapDays };
}

/** 把待删除行数切成每批不超过 batchSize、合计不超过 maxPerRun 的批次。 */
export function deletionBatchSizes(total: number, batchSize: number, maxPerRun: number): number[] {
  if (!Number.isInteger(total) || total < 0) throw new Error('invalid_total');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('invalid_batch');
  if (!Number.isInteger(maxPerRun) || maxPerRun < 1) throw new Error('invalid_cap');
  const sizes: number[] = [];
  const cap = Math.min(total, maxPerRun);
  let done = 0;
  while (done < cap) {
    const size = Math.min(batchSize, cap - done);
    sizes.push(size);
    done += size;
  }
  return sizes;
}
