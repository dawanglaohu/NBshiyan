import { Prisma, type PrismaClient } from '@prisma/client';
import { DayBoundaryError, siteDayUtcBounds } from '../../analytics/day-boundaries';
import { audit as writeAudit } from '../admin/audit';
import { createJobLeaseRepo, type JobLeaseRepo } from '../jobs/lease-repo';
import type { ClaimResult } from '../jobs/types';
import { AggregateCommitUnknown } from './aggregate';
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
/** 清理结果单独记在这一行。租约仍用 analytics-aggregate，不改汇总的状态。 */
const STATUS_KEY = 'analytics-retention';
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
const TX = { maxWait: 5_000, timeout: 15_000 } as const;

type Query = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;
export type RetentionCleanupDb = Query & Pick<PrismaClient, '$transaction'>;
type Acquired = Extract<ClaimResult, { acquired: true }>;

/**
 * 本次运行实际消费的三个租约方法。假 repo 只实现这三个，不需要 `as any`；
 * 注入缝仅在 server 内部（测试用），不从 HTTP/ENV/公开 ops 配置接。
 */
type RetentionLeaseRepo = Pick<JobLeaseRepo, 'claimPreservingStatus' | 'renew' | 'completeSeparately'>;

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

/** 回调内失败：Prisma 必回滚，确认本批没有提交。 */
class BatchCallbackFailure extends Error {
  constructor(readonly original: unknown) {
    super('batch_callback_failure');
    this.name = 'BatchCallbackFailure';
  }
}



/**
 * 单批删除事务：只有「回调内失败」与「事务没开起来」能说确认没提交。
 *
 * 回调已返回、`$transaction` 才抛＝COMMIT 答复未知：抛 AggregateCommitUnknown，
 * 由调用方停止后续批次、只保留已确认批次的计数，且不写 FAILED 终态。
 */
export async function runRetentionBatch(
  db: RetentionCleanupDb,
  targets: string[],
  work: (tx: Prisma.TransactionClient) => Promise<number>,
): Promise<number> {
  // 按**执行位置**判别，不看错误码：P2028/57014/55P03 若发生在回调之后，一律是未知提交。
  let started = false;
  try {
    return await db.$transaction(async (tx) => {
      started = true;
      try {
        return await work(tx);
      } catch (error) {
        throw new BatchCallbackFailure(error);
      }
    }, TX);
  } catch (error) {
    if (error instanceof BatchCallbackFailure) throw error.original; // 回调内失败＝Prisma 必回滚
    if (!started) throw error;                                      // BEGIN 前失败（含 P2024）＝确认无提交
    throw new AggregateCommitUnknown('metrics', targets.length > 0 ? targets : ['retention_cleanup']);
  }
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
  repo: RetentionLeaseRepo,
  claim: Acquired,
  status: 'SUCCEEDED' | 'FAILED',
  counts: RetentionCleanupCounts,
  errorCode: 'invalid' | 'internal_error' | 'service_unavailable' | null,
): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await repo.completeSeparately({
        leaseKey: ANALYTICS_ROLLUP_JOB_KEY,
        statusKey: STATUS_KEY,
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

async function renew(db: RetentionCleanupDb, repo: RetentionLeaseRepo, claim: Acquired): Promise<void> {
  await db.$transaction(async (tx) => {
    await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER, generation: claim.generation }, tx);
  }, TX);
}

/**
 * 这一站点日里可以删除的原始事件：occurredAt 和 receivedAt 都早于保留截止点。
 * 两个时刻都早于 cutoff 时，事件落在任何时区的 recomputableFrom 之前，不能再被整日重算。
 * 截止时刻由本次运行读到的服务器时间减去 RAW_EVENT_RETENTION_MS，再用 utc() 绑定。
 * 冒烟路径不单独豁免。只锁这一批的行，提交后下一批才开始。
 */
function deletableEventFilter(start: Date, end: Date, cutoff: Date): Prisma.Sql {
  return Prisma.sql`
    "occurredAt" >= ${utc(start)}
    AND "occurredAt" < ${utc(end)}
    AND "occurredAt" < ${utc(cutoff)}
    AND "receivedAt" < ${utc(cutoff)}
  `;
}
async function deleteEventBatch(
  db: RetentionCleanupDb,
  repo: RetentionLeaseRepo,
  claim: Acquired,
  siteDate: string,
  timeZone: string,
  now: Date,
  limit: number,
): Promise<number> {
  const bounds = siteDayUtcBounds(siteDate, timeZone);
  const deleted = await runRetentionBatch(db, [siteDate], async (tx) => {
    await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER, generation: claim.generation }, tx);
    const cutoff = rawEventCutoff(now);
    return tx.$executeRaw`
      DELETE FROM "AnalyticsEvent"
      WHERE "eventId" IN (
        SELECT "eventId" FROM "AnalyticsEvent"
        WHERE ${deletableEventFilter(new Date(bounds.startUtc), new Date(bounds.endUtc), cutoff)}
        ORDER BY "receivedAt" ASC, "eventId" ASC
        LIMIT ${limit}
      )
    `;
  });
  return Number(deleted);
}

async function deleteDailyBatch(
  db: RetentionCleanupDb,
  repo: RetentionLeaseRepo,
  claim: Acquired,
  before: string,
  limit: number,
): Promise<number> {
  const deleted = await runRetentionBatch(db, ['daily_rollup'], async (tx) => {
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
  });
  return Number(deleted);
}

async function deleteRollupDayBatch(
  db: RetentionCleanupDb,
  repo: RetentionLeaseRepo,
  claim: Acquired,
  before: string,
  limit: number,
): Promise<number> {
  const deleted = await runRetentionBatch(db, ['rollup_day'], async (tx) => {
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
  });
  return Number(deleted);
}

type Budget = { removed: number; batches: number; batchSize: number; maxPerRun: number };

async function drain(
  budget: Budget,
  deleteBatch: (limit: number) => Promise<number>,
  /** 每个**已确认提交**的批次立刻记账：后续批次未知时，先前确认的计数不会丢。 */
  onConfirmed: (count: number) => void = () => {},
): Promise<number> {
  let deleted = 0;
  while (budget.removed < budget.maxPerRun) {
    const limit = Math.min(budget.batchSize, budget.maxPerRun - budget.removed);
    const count = await deleteBatch(limit);
    if (!Number.isInteger(count) || count < 0 || count > limit) throw new Error('batch_failed');
    if (count === 0) break;
    budget.removed += count;
    budget.batches += 1;
    onConfirmed(count);
    deleted += count;
    if (count < limit) break;
  }
  return deleted;
}

/**
 * 分析保留清理。先拿 analytics-aggregate 租约，汇总正在重算时返回 busy。
 * 租约不改汇总那一行的状态。成功或失败写到 analytics-retention。
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
  /** 仅 server 内部注入（测试）：默认仍用真实 `createJobLeaseRepo`。 */
  repoFactory?: (deps: { db: RetentionCleanupDb; clock: () => Date }) => RetentionLeaseRepo;
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
  const repo = (deps.repoFactory ?? createJobLeaseRepo)({ db: deps.db, clock: leaseClock });
  const claim = await repo.claimPreservingStatus({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: OWNER });
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
    const cutoff = rawEventCutoff(now);
    for (const [index, siteDate] of confirmed.entries()) {
      if (index % 25 === 0) await renew(deps.db, repo, claim);
      const bounds = siteDayUtcBounds(siteDate, clock.timezone);
      const rows = await deps.db.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS "count"
        FROM "AnalyticsEvent"
        WHERE ${deletableEventFilter(new Date(bounds.startUtc), new Date(bounds.endUtc), cutoff)}
      `;
      counts.candidateEvents += Number(rows[0]?.count ?? 0);
    }
    const expiredRows = await deps.db.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM "AnalyticsEvent" WHERE "receivedAt" < ${utc(cutoff)}
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
        await drain(
          budget,
          (limit) => deleteEventBatch(deps.db, repo, claim, siteDate, clock.timezone, now, limit),
          (count) => { counts.deletedEvents += count; },
        );
      }
      await drain(
        budget,
        (limit) => deleteDailyBatch(deps.db, repo, claim, rollupBefore, limit),
        (count) => { counts.deletedRollupRows += count; },
      );
      await drain(
        budget,
        (limit) => deleteRollupDayBatch(deps.db, repo, claim, rollupBefore, limit),
        (count) => { counts.deletedRollupRows += count; },
      );
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
    if (error instanceof AggregateCommitUnknown) {
      // 终态未确认：不写 FAILED 终态、不再开批次；只保留已确认批次的计数。
      console.error('[cron] retention-cleanup commit_unknown', {
        phase: error.phase,
        targets: error.unknownTargets.length,
        confirmedBatches: counts.batches,
      });
      return {
        status: 'failed',
        errorCode: 'service_unavailable',
        deletedEvents: counts.deletedEvents,
        deletedRollupRows: counts.deletedRollupRows,
      };
    }
    await finish(deps.db, repo, claim, 'FAILED', counts, errorCodeOf(error));
    return { status: 'failed', errorCode: errorCodeOf(error), deletedEvents: counts.deletedEvents, deletedRollupRows: counts.deletedRollupRows };
  }
}
