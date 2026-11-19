import { Prisma, type PrismaClient } from '@prisma/client';
import { recomputableFrom, siteDayUtcBounds, siteLocalDate } from '../../analytics/day-boundaries';
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

/* ------------------------------------------------------------------------- *
 * M5-T5 保留候选与覆盖边界计划器（供 M5-T11 消费）
 *
 * 边界语义按本任务验收：等号即到期——事件在 receivedAt+30 天整到期，汇总行在
 * siteDate+13 个自然月的到期日整到期。上文的旧清理链仍用严格早于（等号保留），
 * 这里不修改那些导出；两套语义同时存在，M5-T11 只用下面这组等号到期函数。
 * ------------------------------------------------------------------------- */

function assertInstant(instant: Date): Date {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new Error('invalid_instant');
  return instant;
}

/** 单条原始事件的到期时刻：receivedAt + 30 天。等号即到期。 */
export function eventExpiresAt(receivedAt: Date): Date {
  return new Date(assertInstant(receivedAt).getTime() + RAW_EVENT_RETENTION_MS);
}

/** 注入时钟下，原始事件的到期上界（含等号）：receivedAt <= 此瞬时即到期。 */
export function eventExpiryCutoff(now: Date): Date {
  return new Date(assertInstant(now).getTime() - RAW_EVENT_RETENTION_MS);
}

/** 原始事件是否已到期。now 恰好等于 receivedAt+30 天时算到期。 */
export function isEventExpired(receivedAt: Date, now: Date): boolean {
  return assertInstant(now).getTime() >= eventExpiresAt(receivedAt).getTime();
}

/** 站点本地日加减自然日。用 UTC 日历做纯日期运算，不涉及时区偏移。 */
function shiftLocalDays(localDate: string, days: number): string {
  const { year, month, day } = assertLocalDate(localDate);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** 汇总行的到期本地日：siteDate + 13 个自然月（目标月无该日时夹到月末）。等号即到期。 */
export function rollupExpiresAt(siteDate: string): string {
  assertLocalDate(siteDate);
  return shiftCalendarMonths(siteDate, ROLLUP_RETENTION_MONTHS);
}

/**
 * 注入时钟下，已到期汇总行的站点本地日上界（含等号）。
 *
 * 边界必须以正推 `rollupExpiresAt` 为准：截止日是「到期日不晚于当前站点日期」的
 * 最大原日期。自然月正推会把 29–31 日夹到短月的月末，直接按 -13 个月推算会漏掉
 * 这些日子（例如 2027-02-28 时 2026-01-31 的到期日也是 2027-02-28，但 -13 个月
 * 只得到 2026-01-28）。从 -13 个月的猜测值起有界向后走，直到下一步的到期日超过今天。
 */
export function rollupExpiryCutoff(now: Date, timeZone: string): string {
  const today = siteLocalDate(assertInstant(now), timeZone);
  let cutoff = shiftCalendarMonths(today, -ROLLUP_RETENTION_MONTHS);
  // 猜测值与真实截止日的差距上界为 31 天（短月夹取 + 跨月），留足余量后必然停止。
  for (let step = 0; step < 40; step += 1) {
    const next = shiftLocalDays(cutoff, 1);
    if (rollupExpiresAt(next) > today) break;
    cutoff = next;
  }
  return cutoff;
}

/** 汇总行是否已到期。当前站点本地日恰好等于 expiresAt 时算到期。 */
export function isRollupExpired(siteDate: string, now: Date, timeZone: string): boolean {
  assertLocalDate(siteDate);
  return siteDate <= rollupExpiryCutoff(now, timeZone);
}

export type RawCoveragePlan = {  /** 完整原始覆盖起点（UTC 瞬时，ISO）。早于它的站点日本地日原始事实可能已被部分清理。 */
  completeRawCoverageStartUtc: string;
  /** 上述瞬时所在的站点本地日；这一天整日仍完整，更早的日子不一定。 */
  completeRawCoverageStartLocalDate: string;
};

/**
 * 完整原始覆盖起点与 recomputableFrom 同一条线：横跨保留截止的残日不算完整。
 * 这里只导出给 M5-T11 展示覆盖；能否整日重算仍由 dayStart 与起点比较判定。
 */
export function rawCoveragePlan(now: Date, timeZone: string): RawCoveragePlan {
  const startUtc = recomputableFrom(assertInstant(now), timeZone);
  return {
    completeRawCoverageStartUtc: startUtc,
    completeRawCoverageStartLocalDate: siteLocalDate(new Date(startUtc), timeZone),
  };
}

export type RecomputableDayPartition = {
  /** 整日重算仍完整的日子，升序去重。 */
  recomputable: string[];
  /** 原始事实可能已被部分清理的日子，升序去重；不得标记为可整日重算。 */
  nonRecomputable: string[];
};

/**
 * 按完整原始覆盖起点给站点本地日分类。dayStart 早于起点的日子可能只剩残片，
 * 必须保留旧完整聚合；与起点同瞬间开始的日子整日完整。
 */
export function partitionRecomputableDays(input: {
  siteDates: readonly string[];
  siteTimezone: string;
  completeRawCoverageStartUtc: string;
}): RecomputableDayPartition {
  const start = Date.parse(input.completeRawCoverageStartUtc);
  if (!Number.isFinite(start)) throw new Error('invalid_instant');
  const unique = [...new Set(input.siteDates)].sort();
  const recomputable: string[] = [];
  const nonRecomputable: string[] = [];
  for (const siteDate of unique) {
    const dayStart = Date.parse(siteDayUtcBounds(siteDate, input.siteTimezone).startUtc);
    if (dayStart >= start) recomputable.push(siteDate);
    else nonRecomputable.push(siteDate);
  }
  return { recomputable, nonRecomputable };
}

type RetentionQuery = Pick<PrismaClient, '$queryRaw'>;

/** 候选列举上限复用清理单次上限，避免只读查询本身无界。 */
const CANDIDATE_LIMIT_MAX = RETENTION_CLEANUP_MAX_PER_RUN;

function assertCandidateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > CANDIDATE_LIMIT_MAX) throw new Error('invalid_limit');
  return limit;
}

/** 与 rollup、event-repo、retention-cleanup 相同的 UTC 绑定：不让会话时区参与 timestamp 解释。 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

export type ExpiredRollupDailyKey = {
  siteDate: string;
  kind: string;
  locale: string;
  productSlug: string;
};

/**
 * dry-run 候选计数。
 *
 * `events/rollupDailyRows/rollupDays/total` 保持旧语义（三张老表）；
 * `daily/dayState/dayChange` 是 M5-T12 新三表的候选；`totalAll` 是六表合计。
 * 新三表各有独立额度（Daily ≤1,000 并计入四表 20k；state/marker 各 ≤500、合 ≤1,000），
 * 因此 `totalAll` 只作读数，不做任何一批的预算判定。
 */
export type RetentionCandidateCounts = {
  events: number;
  rollupDailyRows: number;
  rollupDays: number;
  /** 旧三表合计，语义不变。 */
  total: number;
  /** `AnalyticsDaily` 中 `expiresAt <= now` 的到期行（等号到期）。 */
  daily: number;
  /**
   * `AnalyticsAggregateDayState` 中按**行内时区**已到期、且没有未到期 AnalyticsDaily
   * 同 (localDate, revision) 行的行数；扫描窗口与删除阶段同一上限。
   */
  dayState: number;
  /**
   * `AnalyticsDayChange` 中 UTC 日严格早于「UTC 今日 −13 自然月 −2 天」的行数**上界**：
   * 仍被存续 state 覆盖的 UTC 日由删除阶段排除，这里不减，故只作读数。
   */
  dayChange: number;
  /** 六表合计读数；不用于额度判定。 */
  totalAll: number;
};

/**
 * 生产日志口径：候选计数按**预算栏位**分列，避免把 metadata 算进四表 20k，
 * 也避免把 `dayChange` 上界当精确值、把 `totalAll` 当额度。
 *
 * 只做标签与算术，不含任何行内容或连接信息。
 */
export function candidateCountLabels(counts: RetentionCandidateCounts) {
  return {
    /** 旧三表（事件、日汇总、水位）合计，`total` 语义不变。 */
    legacyThreeTables: counts.total,
    /** `AnalyticsDaily` 到期行：单表 ≤1,000，并且计入四表每轮上限。 */
    newDaily: counts.daily,
    /** 四表共用每轮 `RETENTION_CLEANUP_MAX_PER_RUN` 的计数口径；metadata 不在其中。 */
    fourTableBudget: counts.total + counts.daily,
    /** `AnalyticsAggregateDayState` 到期行，走独立额度。 */
    metadataState: counts.dayState,
    /** `AnalyticsDayChange` 的上界读数：仍被存续 state 覆盖的 UTC 日没有减。 */
    metadataDayChangeUpperBound: counts.dayChange,
    /** metadata 两表合计，只受各 500 与合计 1,000 约束。 */
    metadataTotal: counts.dayState + counts.dayChange,
    /** 六表合计读数，不参与任何额度判定。 */
    totalAllSixTables: counts.totalAll,
  };
}

/**
 * 只读候选仓储：不提供删除方法，不选 browserHash、path、payloadHash 或任何事件正文，
 * 只返回 eventId、日期、种类、语言与产品内部 key，够 M5-T11 计数与分批定位。
 */
export type RetentionCandidateRepo = {
  counts(): Promise<RetentionCandidateCounts>;
  eventIds(limit: number): Promise<string[]>;
  rollupDailyKeys(limit: number): Promise<ExpiredRollupDailyKey[]>;
  rollupDays(limit: number): Promise<string[]>;
};

/**
 * 注入时钟与站点时区后固定一套截止值；同一实例的所有查询共用同一个固定截止值。
 * 真实事务、租约与生产保留授权门禁由 M5-T11 集成，这里只读。
 */
export function createRetentionCandidateRepo(deps: {
  db: RetentionQuery;
  now: Date;
  siteTimezone: string;
}): RetentionCandidateRepo {
  const db = deps.db;
  const eventCutoff = utc(eventExpiryCutoff(deps.now));
  const rollupThrough = rollupExpiryCutoff(deps.now, deps.siteTimezone);
  return {
    async counts() {
      const [events, daily, days] = await Promise.all([
        db.$queryRaw<{ count: number }[]>(Prisma.sql`
          SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "receivedAt" <= ${eventCutoff}
        `),
        db.$queryRaw<{ count: number }[]>(Prisma.sql`
          SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" <= ${rollupThrough}
        `),
        db.$queryRaw<{ count: number }[]>(Prisma.sql`
          SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" <= ${rollupThrough}
        `),
      ]);
      const eventCount = Number(events[0]?.count ?? 0);
      const dailyCount = Number(daily[0]?.count ?? 0);
      const dayCount = Number(days[0]?.count ?? 0);
      const legacyTotal = eventCount + dailyCount + dayCount;

      // M5-T12 新三表：与删除阶段同一判据（只是只读），额度各自独立，不进 legacy total。
      const dailyTableRows = await db.$queryRaw<{ count: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS "count" FROM "AnalyticsDaily" WHERE "expiresAt" <= ${utc(deps.now)}
      `);
      const dailyTable = Number(dailyTableRows[0]?.count ?? 0);

      const stateFloor = stateRetentionFloor(siteLocalDate(deps.now, deps.siteTimezone));
      const stateCandidates = await db.$queryRaw<
        { localDate: string; timezoneRevision: number; timezone: string }[]
      >(Prisma.sql`
        SELECT "localDate", "timezoneRevision", "timezone"
        FROM "AnalyticsAggregateDayState"
        WHERE "localDate" < ${stateFloor}
        ORDER BY "localDate" ASC, "timezoneRevision" ASC
        LIMIT ${DAILY_RETENTION_SCAN_LIMIT}
      `);
      const expiredStates: Array<{ localDate: string; timezoneRevision: number }> = [];
      for (const row of stateCandidates) {
        try {
          // 行内时区正推 13 个自然月后那一日的起点；与 aggregate-day-state.dailyExpiresAt 同式。
          if (new Date(siteDayUtcBounds(rollupExpiresAt(row.localDate), row.timezone).startUtc).getTime() > deps.now.getTime()) {
            continue;
          }
        } catch {
          continue; // 坏时区只诊断，不计入候选（删除阶段也定向保留）。
        }
        expiredStates.push({ localDate: row.localDate, timezoneRevision: Number(row.timezoneRevision) });
      }
      let dayState = expiredStates.length;
      if (expiredStates.length > 0) {
        const pairs = expiredStates.map((row) => Prisma.sql`(${row.localDate}, ${row.timezoneRevision})`);
        const unexpired = await db.$queryRaw<{ localDate: string; timezoneRevision: number }[]>(Prisma.sql`
          SELECT DISTINCT "localDate", "timezoneRevision"
          FROM "AnalyticsDaily"
          WHERE "expiresAt" > ${utc(deps.now)}
            AND ("localDate", "timezoneRevision") IN (${Prisma.join(pairs)})
        `);
        const blocked = new Set(unexpired.map((row) => `${row.localDate}|${Number(row.timezoneRevision)}`));
        dayState = expiredStates.filter((row) => !blocked.has(`${row.localDate}|${row.timezoneRevision}`)).length;
      }

      const dayChangeRows = await db.$queryRaw<{ count: number }[]>(Prisma.sql`
        SELECT COUNT(*)::int AS "count" FROM "AnalyticsDayChange"
        WHERE "utcDate" < ${dayChangeRetentionCutoff(utcDateOf(deps.now))}
      `);
      const dayChange = Number(dayChangeRows[0]?.count ?? 0);

      return {
        events: eventCount,
        rollupDailyRows: dailyCount,
        rollupDays: dayCount,
        total: legacyTotal,
        daily: dailyTable,
        dayState,
        dayChange,
        totalAll: legacyTotal + dailyTable + dayState + dayChange,
      };
    },
    async eventIds(limit) {
      const take = assertCandidateLimit(limit);
      const rows = await db.$queryRaw<{ eventId: string }[]>(Prisma.sql`
        SELECT "eventId" FROM "AnalyticsEvent"
        WHERE "receivedAt" <= ${eventCutoff}
        ORDER BY "receivedAt" ASC, "eventId" ASC
        LIMIT ${take}
      `);
      return rows.map((row) => row.eventId);
    },
    async rollupDailyKeys(limit) {
      const take = assertCandidateLimit(limit);
      const rows = await db.$queryRaw<ExpiredRollupDailyKey[]>(Prisma.sql`
        SELECT "siteDate", "kind"::text AS "kind", "locale", "productSlug"
        FROM "AnalyticsDailyRollup"
        WHERE "siteDate" <= ${rollupThrough}
        ORDER BY "siteDate" ASC, "kind" ASC, "locale" ASC, "productSlug" ASC
        LIMIT ${take}
      `);
      return rows.map((row) => ({
        siteDate: row.siteDate,
        kind: row.kind,
        locale: row.locale,
        productSlug: row.productSlug,
      }));
    },
    async rollupDays(limit) {
      const take = assertCandidateLimit(limit);
      const rows = await db.$queryRaw<{ siteDate: string }[]>(Prisma.sql`
        SELECT "siteDate" FROM "AnalyticsRollupDay"
        WHERE "siteDate" <= ${rollupThrough}
        ORDER BY "siteDate" ASC
        LIMIT ${take}
      `);
      return rows.map((row) => row.siteDate);
    },
  };
}

/* ------------------------------------------------------------------------- *
 * M5-T12 新三表保留（docs/data-retention.md「分析原始事件和汇总」表）
 *
 * - `AnalyticsDaily`：行内时区 13 个自然月，`expiresAt <= now`（等号到期），每轮至多 1,000 行。
 * - `AnalyticsAggregateDayState`：自身时区 13 个自然月到期、且无未到期 `AnalyticsDaily` 才删；
 *   坏时区只诊断并定向保留（保守不删）。
 * - `AnalyticsDayChange`：UTC 日反推 13 个自然月＋2 天，严格 `<`；保留仍存续 state 覆盖的
 *   UTC 日与 `markerVersions` 键；**先删 state，再删 marker**。
 * ------------------------------------------------------------------------- */

/** `AnalyticsDaily` 单轮删除上限；四个分析表合计仍受 `RETENTION_CLEANUP_MAX_PER_RUN` 约束。 */
export const DAILY_RETENTION_MAX_PER_RUN = 1_000;

/** 两张元数据表各自单轮上限。 */
export const METADATA_RETENTION_MAX_PER_TABLE = 500;

/** 两张元数据表单轮合计上限（独立于四表 20k）。 */
export const METADATA_RETENTION_MAX_TOTAL = 1_000;

/** 元数据表删除批大小：固定 500，不跟随可配 `batchSize`。 */
export const NEW_TABLE_RETENTION_BATCH = 500;

/** state/marker 本轮各自还能删多少：各自 ≤500，合计 ≤1,000，与四表预算无关。 */
export function metadataRetentionCaps(deletedStates: number): { stateCap: number; markerCap: number } {
  const stateCap = METADATA_RETENTION_MAX_PER_TABLE;
  const totalLeft = Math.max(0, METADATA_RETENTION_MAX_TOTAL - Math.max(0, deletedStates));
  return { stateCap, markerCap: Math.min(METADATA_RETENTION_MAX_PER_TABLE, totalLeft) };
}

/** 新表删除的候选扫描上限：与单轮上限同量级，避免只读查询无界。 */
export const DAILY_RETENTION_SCAN_LIMIT = 2_000;

/** state 到期日预筛的下界：`localDate < 今日 − 13 自然月`（真正的到期判定还要按行内时区正推）。 */
export function stateRetentionFloor(todayLocalDate: string): string {
  assertLocalDate(todayLocalDate);
  return shiftCalendarMonths(todayLocalDate, -ROLLUP_RETENTION_MONTHS);
}

/** `AnalyticsDayChange` 的严格上界：`UTC 今日 − 13 自然月 − 2 天`。 */
export function dayChangeRetentionCutoff(nowUtcDate: string): string {
  assertLocalDate(nowUtcDate);
  return shiftLocalDays(shiftCalendarMonths(nowUtcDate, -ROLLUP_RETENTION_MONTHS), -2);
}

/** `now` 的 UTC 自然日标签（marker 键就是 UTC 日，不能用站点时区折算）。 */
export function utcDateOf(now: Date): string {
  return assertInstant(now).toISOString().slice(0, 10);
}

export type AnalyticsDailyKey = { localDate: string; timezoneRevision: number; dimension: string };
export type AnalyticsDayStateKey = { localDate: string; timezoneRevision: number };
