import { Prisma, type PrismaClient } from '@prisma/client';
import { DayBoundaryError, siteDayUtcBounds } from '../../analytics/day-boundaries';
import { audit as writeAudit } from '../admin/audit';
import { createJobLeaseRepo, type JobLeaseRepo } from '../jobs/lease-repo';
import type { ClaimResult } from '../jobs/types';
import {
  ANALYTICS_ROLLUP_JOB_KEY,
  isSiteDateRolledUp,
  latestContiguousRolledUpDate,
  readAnalyticsSiteClock,
} from './rollup';
import {
  classifyRetentionDays,
  eventDeletionFloorLocalDate,
  rawEventCutoff,
  RETENTION_CLEANUP_BATCH_SIZE,
  RETENTION_CLEANUP_MAX_PER_RUN,
  retentionCleanupMode,
  rollupDeletionBefore,
  type RetentionCleanupMode,
} from './retention-plan';

const OWNER = 'retention-cleanup';
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const TX = { maxWait: 5_000, timeout: 15_000 } as const;

type Query = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;
export type RetentionCleanupDb = Query & Pick<PrismaClient, '$transaction'>;
type Acquired = Extract<ClaimResult, { acquired: true }>;

export type RetentionCleanupCounts = {
  mode: RetentionCleanupMode;
  candidateEvents: number;
  deletedEvents: number;
  candidateRollupRows: number;
  deletedRollupRows: number;
  skippedUnrolledDays: number;
  skippedRevisionMismatchDays: number;
  skippedAfterGapDays: number;
  keptExpiredEvents: number;
  batches: number;
  batchSize: number;
  maxPerRun: number;
};

export type RetentionCleanupResult =
  | { status: 'busy' }
  | ({ status: 'succeeded' } & RetentionCleanupCounts)
  | { status: 'failed'; errorCode: 'invalid' | 'internal_error' | 'service_unavailable'; deletedEvents: number; deletedRollupRows: number };

type AuditWrite = (entry: { action: string; meta?: Prisma.InputJsonValue }) => Promise<void>;

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name)) return error.name;
  return 'Error';
}

function errorCodeOf(error: unknown): 'invalid' | 'internal_error' | 'service_unavailable' {
  if (error instanceof DayBoundaryError) return 'invalid';
  if (error instanceof Error && (error.name === 'JobLeaseAbort' || error.message === 'clock_unreadable')) return 'service_unavailable';
  return 'internal_error';
}

async function defaultAudit(entry: { action: string; meta?: Prisma.InputJsonValue }): Promise<void> {
  await writeAudit({ action: entry.action, meta: entry.meta });
}

async function readDbNow(db: Query): Promise<Date> {
  const rows = await db.$queryRaw<{ now: string }[]>`
    SELECT to_char(now() AT TIME ZONE 'UTC', ${ISO_FORMAT}) AS "now"
  `;
  const now = new Date(rows[0]?.now ?? '');
  if (!Number.isFinite(now.getTime())) throw new Error('clock_unreadable');
  return now;
}

function summaryFor(counts: RetentionCleanupCounts, timezoneRevision: number) {
  const cap = 2_147_483_647;
  const clamp = (value: number) => Math.max(0, Math.min(cap, value));
  return {
    counts: {
      candidateCount: clamp(counts.candidateEvents + counts.candidateRollupRows),
      deletedCount: clamp(counts.deletedEvents + counts.deletedRollupRows),
    },
    versions: { timezoneRevision },
  };
}

async function finish(
  db: RetentionCleanupDb,
  repo: JobLeaseRepo,
  claim: Acquired,
  status: 'SUCCEEDED' | 'FAILED',
  counts: RetentionCleanupCounts,
  errorCode: 'invalid' | 'internal_error' | 'service_unavailable' | null,
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await repo.complete({
        key: ANALYTICS_ROLLUP_JOB_KEY,
        owner: OWNER,
        generation: claim.generation,
        status,
        summary: summaryFor(counts, claim.timezoneRevision),
        errorCode,
        timezoneRevision: claim.timezoneRevision,
      }, tx);
    }, TX);
  } catch (error) {
    console.error('[cron] retention-cleanup lease finish failed', errorName(error));
  }
}

async function renew(db: RetentionCleanupDb, repo: JobLeaseRepo, claim: Acquired): Promise<void> {
  await db.$transaction(async (tx) => {
    await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER, generation: claim.generation }, tx);
  }, TX);
}

/**
 * 删除早于保留截止点、并且落在这一站点日里的原始事件。
 * 截止时刻由本次运行读到的服务器时间减去 RAW_EVENT_RETENTION_MS，再用 utc() 绑定。
 * 冒烟路径不单独豁免。只锁这一批的行，提交后下一批才开始。
 */
async function deleteEventBatch(
  db: RetentionCleanupDb,
  repo: JobLeaseRepo,
  claim: Acquired,
  siteDate: string,
  timeZone: string,
  now: Date,
  limit: number,
): Promise<number> {
  const bounds = siteDayUtcBounds(siteDate, timeZone);
  const deleted = await db.$transaction(async (tx) => {
    await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER, generation: claim.generation }, tx);
    return tx.$executeRaw`
      DELETE FROM "AnalyticsEvent"
      WHERE "eventId" IN (
        SELECT "eventId" FROM "AnalyticsEvent"
        WHERE "occurredAt" >= ${utc(new Date(bounds.startUtc))}
          AND "occurredAt" < ${utc(new Date(bounds.endUtc))}
          AND "receivedAt" < ${utc(rawEventCutoff(now))}
        ORDER BY "receivedAt" ASC, "eventId" ASC
        LIMIT ${limit}
      )
    `;
  }, TX);
  return Number(deleted);
}

async function deleteDailyBatch(
  db: RetentionCleanupDb,
  repo: JobLeaseRepo,
  claim: Acquired,
  before: string,
  limit: number,
): Promise<number> {
  const deleted = await db.$transaction(async (tx) => {
    await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER, generation: claim.generation }, tx);
    return tx.$executeRaw`
      DELETE FROM "AnalyticsDailyRollup" AS target
      USING (
        SELECT "siteDate", "kind", "locale", "productSlug"
        FROM "AnalyticsDailyRollup"
        WHERE "siteDate" < ${before}
        ORDER BY "siteDate", "kind", "locale", "productSlug"
        LIMIT ${limit}
      ) AS picked
      WHERE target."siteDate" = picked."siteDate"
        AND target."kind" = picked."kind"
        AND target."locale" = picked."locale"
        AND target."productSlug" = picked."productSlug"
    `;
  }, TX);
  return Number(deleted);
}

async function deleteRollupDayBatch(
  db: RetentionCleanupDb,
  repo: JobLeaseRepo,
  claim: Acquired,
  before: string,
  limit: number,
): Promise<number> {
  const deleted = await db.$transaction(async (tx) => {
    await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER, generation: claim.generation }, tx);
    return tx.$executeRaw`
      DELETE FROM "AnalyticsRollupDay"
      WHERE "siteDate" IN (
        SELECT "siteDate" FROM "AnalyticsRollupDay"
        WHERE "siteDate" < ${before}
        ORDER BY "siteDate"
        LIMIT ${limit}
      )
    `;
  }, TX);
  return Number(deleted);
}

type Budget = { removed: number; batches: number; batchSize: number; maxPerRun: number };

async function drain(budget: Budget, deleteBatch: (limit: number) => Promise<number>): Promise<number> {
  let deleted = 0;
  while (budget.removed < budget.maxPerRun) {
    const limit = Math.min(budget.batchSize, budget.maxPerRun - budget.removed);
    const count = await deleteBatch(limit);
    if (!Number.isInteger(count) || count < 0 || count > limit) throw new Error('batch_failed');
    if (count === 0) break;
    budget.removed += count;
    budget.batches += 1;
    deleted += count;
    if (count < limit) break;
  }
  return deleted;
}

/**
 * 分析保留清理。先拿 analytics-aggregate 租约，汇总正在重算时返回 busy。
 * dry-run 只统计并写审计，不删行。delete 每批一个事务，原始事件先于汇总行。
 * 询盘和聊天不在这里删除。
 */
export async function runRetentionCleanup(deps: {
  db: RetentionCleanupDb;
  clock?: () => Date;
  mode?: RetentionCleanupMode;
  batchSize?: number;
  maxPerRun?: number;
  audit?: AuditWrite;
}): Promise<RetentionCleanupResult> {
  const mode = deps.mode ?? retentionCleanupMode();
  const batchSize = deps.batchSize ?? RETENTION_CLEANUP_BATCH_SIZE;
  const maxPerRun = deps.maxPerRun ?? RETENTION_CLEANUP_MAX_PER_RUN;
  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(maxPerRun) || maxPerRun < batchSize) {
    return { status: 'failed', errorCode: 'invalid', deletedEvents: 0, deletedRollupRows: 0 };
  }
  const now = deps.clock ? deps.clock() : await readDbNow(deps.db);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { status: 'failed', errorCode: 'invalid', deletedEvents: 0, deletedRollupRows: 0 };
  }
  const leaseClock = deps.clock ?? (() => new Date());
  const repo = createJobLeaseRepo({ db: deps.db, clock: leaseClock });
  const claim = await repo.claim({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER });
  if (!claim.acquired) {
    if (claim.reason === 'busy') return { status: 'busy' };
    return { status: 'failed', errorCode: 'service_unavailable', deletedEvents: 0, deletedRollupRows: 0 };
  }
  const counts: RetentionCleanupCounts = {
    mode,
    candidateEvents: 0,
    deletedEvents: 0,
    candidateRollupRows: 0,
    deletedRollupRows: 0,
    skippedUnrolledDays: 0,
    skippedRevisionMismatchDays: 0,
    skippedAfterGapDays: 0,
    keptExpiredEvents: 0,
    batches: 0,
    batchSize,
    maxPerRun,
  };
  try {
    const clock = await readAnalyticsSiteClock(deps.db);
    if (clock === 'corrupt' || clock.timezoneRevision !== claim.timezoneRevision) {
      await finish(deps.db, repo, claim, 'FAILED', counts, 'service_unavailable');
      return { status: 'failed', errorCode: 'service_unavailable', deletedEvents: 0, deletedRollupRows: 0 };
    }
    const floorLocalDate = eventDeletionFloorLocalDate(now, clock.timezone);
    const rollupBefore = rollupDeletionBefore(now, clock.timezone);
    const contiguousThrough = await latestContiguousRolledUpDate(deps.db);
    const marked = await deps.db.$queryRaw<{ siteDate: string; timezoneRevision: number }[]>`
      SELECT "siteDate", "timezoneRevision"
      FROM "AnalyticsRollupDay"
      WHERE "siteDate" < ${floorLocalDate}
      ORDER BY "siteDate"
    `;
    const classified = classifyRetentionDays({
      floorLocalDate,
      contiguousThrough,
      currentRevision: clock.timezoneRevision,
      days: marked.map((day) => ({ siteDate: day.siteDate, timezoneRevision: Number(day.timezoneRevision) })),
    });
    counts.skippedRevisionMismatchDays = classified.skippedRevisionMismatchDays;
    counts.skippedAfterGapDays = classified.skippedAfterGapDays;
    const confirmed: string[] = [];
    for (const [index, siteDate] of classified.deletable.entries()) {
      if (index % 25 === 0) await renew(deps.db, repo, claim);
      if (await isSiteDateRolledUp(siteDate, deps.db)) confirmed.push(siteDate);
      else counts.skippedUnrolledDays += 1;
    }
    const cutoff = utc(rawEventCutoff(now));
    for (const [index, siteDate] of confirmed.entries()) {
      if (index % 25 === 0) await renew(deps.db, repo, claim);
      const bounds = siteDayUtcBounds(siteDate, clock.timezone);
      const rows = await deps.db.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS "count"
        FROM "AnalyticsEvent"
        WHERE "occurredAt" >= ${utc(new Date(bounds.startUtc))}
          AND "occurredAt" < ${utc(new Date(bounds.endUtc))}
          AND "receivedAt" < ${cutoff}
      `;
      counts.candidateEvents += Number(rows[0]?.count ?? 0);
    }
    const expiredRows = await deps.db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "receivedAt" < ${cutoff}
    `;
    const expired = Number(expiredRows[0]?.count ?? 0);
    counts.keptExpiredEvents = Math.max(0, expired - counts.candidateEvents);
    const dailyRows = await deps.db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM "AnalyticsDailyRollup" WHERE "siteDate" < ${rollupBefore}
    `;
    const dayRows = await deps.db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM "AnalyticsRollupDay" WHERE "siteDate" < ${rollupBefore}
    `;
    counts.candidateRollupRows = Number(dailyRows[0]?.count ?? 0) + Number(dayRows[0]?.count ?? 0);
    if (mode === 'delete') {
      const budget: Budget = { removed: 0, batches: 0, batchSize, maxPerRun };
      for (const siteDate of confirmed) {
        counts.deletedEvents += await drain(budget, (limit) => deleteEventBatch(deps.db, repo, claim, siteDate, clock.timezone, now, limit));
      }
      const deletedDaily = await drain(budget, (limit) => deleteDailyBatch(deps.db, repo, claim, rollupBefore, limit));
      const deletedDays = await drain(budget, (limit) => deleteRollupDayBatch(deps.db, repo, claim, rollupBefore, limit));
      counts.deletedRollupRows = deletedDaily + deletedDays;
      counts.batches = budget.batches;
    }
    try {
      await (deps.audit ?? defaultAudit)({
        action: 'cron.retention_cleanup',
        meta: {
          mode,
          candidateEvents: counts.candidateEvents,
          deletedEvents: counts.deletedEvents,
          candidateRollupRows: counts.candidateRollupRows,
          deletedRollupRows: counts.deletedRollupRows,
          skippedUnrolledDays: counts.skippedUnrolledDays,
          skippedRevisionMismatchDays: counts.skippedRevisionMismatchDays,
          skippedAfterGapDays: counts.skippedAfterGapDays,
          keptExpiredEvents: counts.keptExpiredEvents,
          batches: counts.batches,
        },
      });
    } catch (error) {
      console.error('[cron] retention-cleanup audit failed', errorName(error));
    }
    await finish(deps.db, repo, claim, 'SUCCEEDED', counts, null);
    return { status: 'succeeded', ...counts };
  } catch (error) {
    await finish(deps.db, repo, claim, 'FAILED', counts, errorCodeOf(error));
    return { status: 'failed', errorCode: errorCodeOf(error), deletedEvents: counts.deletedEvents, deletedRollupRows: counts.deletedRollupRows };
  }
}
