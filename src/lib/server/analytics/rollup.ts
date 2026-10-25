import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  aggregateSiteDay,
  eligibleSiteDates,
  latestContiguousDate,
  ROLLUP_MAX_DAYS,
  selectRollupDates,
  type DayFreshness,
  type RollupSourceEvent,
  type StoredRollupDay,
} from '../../analytics/rollup-plan';
import { DayBoundaryError, siteDayUtcBounds, type SiteDayBounds } from '../../analytics/day-boundaries';
import { LocalDateSchema, NonNegativeIntSchema, PositiveIntSchema, TimezoneSchema, UtcDateTimeSchema } from '../../contracts/common';
import type { AppErrorCode } from '../../contracts/errors';
import { ANALYTICS_SETTINGS_KEY, INITIAL_TIMEZONE_REVISION } from '../jobs/types';
import { createJobLeaseRepo, type JobLeaseRepo } from '../jobs/lease-repo';
import type { ClaimResult } from '../jobs/types';
import { prisma } from '../db';

/** 契约里的聚合作业名。租约和 JobState 都用这一把锁。 */
export const ANALYTICS_ROLLUP_JOB_KEY = 'analytics-aggregate';

const ANALYTICS_ROLLUP_OWNER = 'analytics-rollup';

// DateTime 列是不含时区的 UTC 时刻。在 SQL 里格式化，避免驱动按会话时区解释。
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

const StoredSettingsSchema = z.object({
  version: NonNegativeIntSchema,
  timezone: TimezoneSchema,
  timezoneRevision: PositiveIntSchema,
  changedAt: UtcDateTimeSchema,
  updatedBy: z.string().min(1).max(128).nullable(),
}).strict();

type SiteClock = { timezone: string; timezoneRevision: number };
type Acquired = Extract<ClaimResult, { acquired: true }>;

export type RollupRunResult =
  | { status: 'succeeded'; days: number; eventCount: number }
  | { status: 'busy' }
  | { status: 'failed'; days: number; errorCode: AppErrorCode };

type Query = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

export type RollupDb = Query & Pick<PrismaClient, '$transaction'>;

class RollupStopped extends Error {
  readonly code: AppErrorCode;

  constructor(code: AppErrorCode) {
    super(code);
    this.name = 'RollupStopped';
    this.code = code;
  }
}

/** 与 event-repo、settings-repo 的 utc 相同：绑定 ISO 字符串，再按 UTC 写入 timestamp。 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/**
 * 与 isSmokeAnalyticsPath 同一规则。查询串和片段先切掉；整段或以 / 分开的路径段以 nbs-smoke- 开头才排除。
 */
function notSmokeSql(): Prisma.Sql {
  return Prisma.sql`(
    "path" IS NULL
    OR (
      split_part(split_part("path", '?', 1), '#', 1) NOT LIKE 'nbs-smoke-%'
      AND split_part(split_part("path", '?', 1), '#', 1) NOT LIKE '%/nbs-smoke-%'
    )
  )`;
}

function asJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function validNow(now: Date): boolean {
  return now instanceof Date && Number.isFinite(now.getTime());
}

async function readSiteClock(db: Query): Promise<SiteClock | 'corrupt'> {
  const rows = await db.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY}
  `;
  if (rows.length === 0) return { timezone: 'UTC', timezoneRevision: INITIAL_TIMEZONE_REVISION };
  const parsed = StoredSettingsSchema.safeParse(asJson(rows[0]?.value));
  if (!parsed.success) return 'corrupt';
  return { timezone: parsed.data.timezone, timezoneRevision: parsed.data.timezoneRevision };
}

function resolveMaxDays(value: number | undefined): number {
  if (value === undefined) return ROLLUP_MAX_DAYS;
  if (!Number.isInteger(value) || value < 1 || value > 40) return ROLLUP_MAX_DAYS;
  return value;
}

function errorCodeOf(error: unknown): AppErrorCode {
  if (error instanceof RollupStopped) return error.code;
  if (error instanceof DayBoundaryError) return 'invalid';
  if (error instanceof Error && error.name === 'RollupEventError') return 'invalid';
  if (error instanceof Error && error.name === 'JobLeaseAbort') {
    if (error.message === 'revision_conflict') return 'version_conflict';
    if (error.message === 'stale' || error.message === 'expired') return 'job_busy';
    return 'service_unavailable';
  }
  return 'internal_error';
}

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name)) return error.name;
  return 'Error';
}

function summaryFor(days: number, now: Date, timezoneRevision: number, sourceThrough?: string, dataThrough?: string) {
  return {
    counts: { candidateCount: days },
    times: {
      aggregatedAt: now.toISOString(),
      ...(sourceThrough ? { sourceThrough } : {}),
      ...(dataThrough ? { dataThrough } : {}),
    },
    versions: { timezoneRevision },
  };
}

async function finish(
  db: RollupDb,
  repo: JobLeaseRepo,
  claim: Acquired,
  status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL',
  errorCode: AppErrorCode | null,
  days: number,
  now: Date,
  sourceThrough?: string,
  dataThrough?: string,
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await repo.complete({
        key: ANALYTICS_ROLLUP_JOB_KEY,
        owner: ANALYTICS_ROLLUP_OWNER,
        generation: claim.generation,
        status,
        summary: summaryFor(days, now, claim.timezoneRevision, sourceThrough, dataThrough),
        errorCode,
        timezoneRevision: claim.timezoneRevision,
      }, tx);
    }, { maxWait: 5_000, timeout: 15_000 });
  } catch (error) {
    console.error('[cron] analytics rollup lease finish failed', errorName(error));
  }
}

async function loadStored(db: Query, eligible: readonly string[]): Promise<StoredRollupDay[]> {
  if (eligible.length === 0) return [];
  const rows = await db.$queryRaw<{ siteDate: string; timezoneRevision: number; sourceMaxReceivedAt: string | null }[]>`
    SELECT
      "siteDate",
      "timezoneRevision",
      to_char("sourceMaxReceivedAt", ${ISO_FORMAT}) AS "sourceMaxReceivedAt"
    FROM "AnalyticsRollupDay"
    WHERE "siteDate" >= ${eligible[0]} AND "siteDate" <= ${eligible[eligible.length - 1]}
  `;
  return rows.map((row) => ({
    siteDate: row.siteDate,
    timezoneRevision: Number(row.timezoneRevision),
    sourceMaxReceivedAt: row.sourceMaxReceivedAt,
  }));
}

async function loadFreshness(db: Query, stored: readonly StoredRollupDay[], clock: SiteClock): Promise<DayFreshness[]> {
  const freshness: DayFreshness[] = [];
  for (const day of stored) {
    if (day.timezoneRevision !== clock.timezoneRevision) continue;
    const bounds = siteDayUtcBounds(day.siteDate, clock.timezone);
    const rows = await db.$queryRaw<{ maxReceivedAt: string | null }[]>`
      SELECT to_char(MAX("receivedAt"), ${ISO_FORMAT}) AS "maxReceivedAt"
      FROM "AnalyticsEvent"
      WHERE "occurredAt" >= ${utc(new Date(bounds.startUtc))}
        AND "occurredAt" < ${utc(new Date(bounds.endUtc))}
        AND ${notSmokeSql()}
    `;
    freshness.push({ siteDate: day.siteDate, sourceMaxReceivedAt: rows[0]?.maxReceivedAt ?? null });
  }
  return freshness;
}

async function loadEvents(db: Query, bounds: SiteDayBounds): Promise<RollupSourceEvent[]> {
  // browserHash 只在这次内存里用来数 distinct，不写入汇总表，也不进日志。
  const rows = await db.$queryRaw<{
    kind: string;
    locale: string;
    productSlug: string | null;
    path: string | null;
    browserHash: string;
    occurredAt: string;
    receivedAt: string;
  }[]>`
    SELECT
      "kind"::text AS "kind",
      "locale",
      "productSlug",
      "path",
      "browserHash",
      to_char("occurredAt", ${ISO_FORMAT}) AS "occurredAt",
      to_char("receivedAt", ${ISO_FORMAT}) AS "receivedAt"
    FROM "AnalyticsEvent"
    WHERE "occurredAt" >= ${utc(new Date(bounds.startUtc))}
      AND "occurredAt" < ${utc(new Date(bounds.endUtc))}
  `;
  return rows.map((row) => ({
    kind: row.kind,
    locale: row.locale,
    productSlug: row.productSlug,
    path: row.path,
    browserHash: row.browserHash,
    occurredAt: new Date(row.occurredAt),
    receivedAt: new Date(row.receivedAt),
  }));
}

async function writeDay(
  db: RollupDb,
  repo: JobLeaseRepo,
  claim: Acquired,
  clock: SiteClock,
  siteDate: string,
  now: Date,
): Promise<{ eventCount: number; sourceMaxReceivedAt: string | null; endUtc: string }> {
  const bounds = siteDayUtcBounds(siteDate, clock.timezone);
  return db.$transaction(async (tx) => {
    await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: ANALYTICS_ROLLUP_OWNER, generation: claim.generation }, tx);
    await tx.$executeRaw`LOCK TABLE "SiteSetting" IN SHARE ROW EXCLUSIVE MODE`;
    const current = await readSiteClock(tx);
    if (current === 'corrupt' || current.timezone !== clock.timezone || current.timezoneRevision !== claim.timezoneRevision) {
      throw new RollupStopped('version_conflict');
    }
    const aggregated = aggregateSiteDay(await loadEvents(tx, bounds), bounds);
    // 只删这一天的汇总行再整组写入。不删除 AnalyticsEvent。
    await tx.$executeRaw`DELETE FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${bounds.localDate}`;
    if (aggregated.rows.length > 0) {
      const values = aggregated.rows.map((row) => Prisma.sql`(
        ${row.siteDate},
        ${row.kind}::"AnalyticsEventKind",
        ${row.locale},
        ${row.productSlug},
        ${row.count},
        ${row.uniqueBrowsers},
        ${utc(now)},
        ${utc(now)}
      )`);
      await tx.$executeRaw`
        INSERT INTO "AnalyticsDailyRollup" (
          "siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt"
        ) VALUES ${Prisma.join(values)}
      `;
    }
    const sourceMax = aggregated.sourceMaxReceivedAt;
    await tx.$executeRaw`
      INSERT INTO "AnalyticsRollupDay" (
        "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
      ) VALUES (
        ${bounds.localDate},
        ${claim.timezoneRevision},
        ${utc(now)},
        ${aggregated.eventCount},
        ${sourceMax ? utc(sourceMax) : Prisma.sql`NULL`},
        ${utc(now)},
        ${utc(now)}
      )
      ON CONFLICT ("siteDate") DO UPDATE SET
        "timezoneRevision" = EXCLUDED."timezoneRevision",
        "completedAt" = EXCLUDED."completedAt",
        "eventCount" = EXCLUDED."eventCount",
        "sourceMaxReceivedAt" = EXCLUDED."sourceMaxReceivedAt",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
    return {
      eventCount: aggregated.eventCount,
      sourceMaxReceivedAt: sourceMax ? sourceMax.toISOString() : null,
      endUtc: bounds.endUtc,
    };
  }, { maxWait: 5_000, timeout: 15_000 });
}

/**
 * 汇总已经结束、并且仍在 recomputableFrom 之内的站点本地日。
 * 同一天在一个事务里先删再写，然后才 upsert AnalyticsRollupDay。重复跑同一批输入，结果不变。
 */
export async function runAnalyticsRollup(deps: {
  db: RollupDb;
  clock?: () => Date;
  maxDays?: number;
}): Promise<RollupRunResult> {
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  if (!validNow(now)) return { status: 'failed', days: 0, errorCode: 'invalid' };
  const settings = await readSiteClock(deps.db);
  const repo = createJobLeaseRepo({ db: deps.db, clock });
  const claim = await repo.claim({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: ANALYTICS_ROLLUP_OWNER });
  if (!claim.acquired) {
    if (claim.reason === 'busy') return { status: 'busy' };
    return { status: 'failed', days: 0, errorCode: 'service_unavailable' };
  }
  if (settings === 'corrupt' || settings.timezoneRevision !== claim.timezoneRevision) {
    await finish(deps.db, repo, claim, 'FAILED', 'service_unavailable', 0, now);
    return { status: 'failed', days: 0, errorCode: 'service_unavailable' };
  }
  let written = 0;
  let eventCount = 0;
  let sourceThrough: string | undefined;
  let dataThrough: string | undefined;
  try {
    const eligible = eligibleSiteDates(now, settings.timezone);
    const stored = await loadStored(deps.db, eligible);
    const freshness = await loadFreshness(deps.db, stored, settings);
    const dates = selectRollupDates({
      eligible,
      stored,
      freshness,
      timezoneRevision: settings.timezoneRevision,
      maxDays: resolveMaxDays(deps.maxDays),
    });
    for (const siteDate of dates) {
      const wrote = await writeDay(deps.db, repo, claim, settings, siteDate, now);
      written += 1;
      eventCount += wrote.eventCount;
      if (wrote.sourceMaxReceivedAt && (!sourceThrough || Date.parse(wrote.sourceMaxReceivedAt) > Date.parse(sourceThrough))) {
        sourceThrough = wrote.sourceMaxReceivedAt;
      }
      dataThrough = wrote.endUtc;
    }
    await finish(deps.db, repo, claim, 'SUCCEEDED', null, written, now, sourceThrough, dataThrough);
    return { status: 'succeeded', days: written, eventCount };
  } catch (error) {
    const errorCode = errorCodeOf(error);
    await finish(deps.db, repo, claim, written > 0 ? 'PARTIAL' : 'FAILED', errorCode, written, now, sourceThrough, dataThrough);
    return { status: 'failed', days: written, errorCode };
  }
}

/** 当前时区代次下，这一站点本地日的汇总已经写完。今天、未来、旧代次和非法日期都不是。 */
export async function isSiteDateRolledUp(siteDate: string, db: Query = prisma): Promise<boolean> {
  if (!LocalDateSchema.safeParse(siteDate).success) return false;
  const clock = await readSiteClock(db);
  if (clock === 'corrupt') return false;
  const rows = await db.$queryRaw<{ timezoneRevision: number }[]>`
    SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${siteDate}
  `;
  return rows.length === 1 && Number(rows[0]?.timezoneRevision) === clock.timezoneRevision;
}

/** 当前时区代次下、早于 cutoff 的已汇总站点日，按日期升序。cutoff 不是合法本地日时拒绝。 */
export async function rolledUpDatesBefore(cutoff: string, db: Query = prisma): Promise<string[]> {
  if (!LocalDateSchema.safeParse(cutoff).success) throw new Error('invalid_date');
  const clock = await readSiteClock(db);
  if (clock === 'corrupt') return [];
  const rows = await db.$queryRaw<{ siteDate: string }[]>`
    SELECT "siteDate" FROM "AnalyticsRollupDay"
    WHERE "timezoneRevision" = ${clock.timezoneRevision} AND "siteDate" < ${cutoff}
    ORDER BY "siteDate"
  `;
  return rows.map((row) => row.siteDate);
}

/**
 * 当前时区代次里，从最早一个已完成日连续走到的最后一天。
 * 保留清理只能删到这一天为止；这一天之后，包括中间有空缺的后来日子，都不在这个结果里。
 */
export async function latestContiguousRolledUpDate(db: Query = prisma): Promise<string | null> {
  const clock = await readSiteClock(db);
  if (clock === 'corrupt') return null;
  const rows = await db.$queryRaw<{ siteDate: string }[]>`
    SELECT "siteDate" FROM "AnalyticsRollupDay"
    WHERE "timezoneRevision" = ${clock.timezoneRevision}
    ORDER BY "siteDate"
  `;
  return latestContiguousDate(rows.map((row) => row.siteDate));
}
