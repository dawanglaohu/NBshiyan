import { Prisma, type PrismaClient } from '@prisma/client';
import { planSnapshot, type CoverageState } from '../../analytics/aggregate-plan';
import { siteDayUtcBounds, siteLocalDate } from '../../analytics/day-boundaries';
import type { AppErrorCode } from '../../contracts/errors';
import type { JobCountsDTO, JobResultStatus } from '../../contracts/ops';
import { createJobLeaseRepo } from '../jobs/lease-repo';
import {
  JOB_MAX_BATCH,
  budgetExhausted,
  createJobBudget,
  isBudgetTimeoutError,
  runWithinBudget,
  type JobBudget,
  type JobRunContext,
  type JobRunOutcome,
  type RegisteredJob,
} from '../jobs/registry';
import {
  AggregateBatchExceeded,
  AggregateDeadlineExceeded,
  AggregateVersionConflict,
  aggregateOneDayInSnapshot,
  runAggregateOnce,
} from './aggregate';
import {
  RETENTION_CLEANUP_BATCH_SIZE,
  RETENTION_CLEANUP_MAX_PER_RUN,
  createRetentionCandidateRepo,
  eventExpiryCutoff,
  rawCoveragePlan,
  rollupExpiryCutoff,
  type RetentionCandidateCounts,
} from './retention-plan';
import { ANALYTICS_ROLLUP_JOB_KEY, readAnalyticsSiteClock } from './rollup';

/**
 * M5-T11：默认 dry-run 的分析保留任务。
 *
 * 与 M5-T5 计划器（retention-plan.ts）和旧清理链（retention-cleanup.ts）的分工：
 * 计划器只读候选与边界，旧链是挂在独立路由上的临时实现；本文件把边界接到固定
 * registry 的 `analytics-retention` 作业上，并提供：
 *   1. 租约：沿用 `analytics-aggregate` 那把锁（claimPreservingStatus），
 *      与 5 分钟聚合作业互斥；结果写到自己的 `analytics-retention` 行，
 *      代次/租约对不上时 `completeSeparately` 整笔回滚，旧代次不能发布。
 *   2. 授权：只有容器设了 `RETENTION_CLEANUP_MODE=delete`（由调用方注入为
 *      `deleteAuthorized`）且 operations 请求显式 `dryRun:false` 才删行；
 *      缺任一条件都不删，未授权但请求删除时记 FAILED/forbidden。
 *   3. 删除：`receivedAt <= now-30d` 的原始事件、`siteDate <= 13 个自然月截止日`
 *      的日聚合与日水位；每批一个事务、批内续租，合计不超过单轮上限。
 *   4. 重算：删完调用既有 `runAggregateOnce`，只重算 `dayStart >= 完整原始覆盖起点`
 *      的自然日（今天 + 48h 迟到窗口）；超范围保留旧聚合、不重建过期明细。
 *
 * 只读候选查询不选 browserHash/path/payloadHash，删除也不回写事件正文；返回的
 * 只有计数、日期与聚合种类，落库的 JobState 摘要也只有候选/实际计数。
 */

/** 固定作业 key：operations 请求与 registry 都用它。 */
export const ANALYTICS_RETENTION_KEY = 'analytics-retention';

/** 租约 owner：只用于领取/续租/完成，不接受请求传入。 */
const RETENTION_OWNER = 'analytics-retention';

export type RetentionMode = 'dry-run' | 'delete';

export type RetentionModeDecision = {
  /** 本轮是否真的删行。任何不确定都落回 dry-run。 */
  mode: RetentionMode;
  /** 请求了删除但没有授权：计数照做，删行 0，结果记拒绝。 */
  rejected: boolean;
};

/**
 * 纯函数：把「请求是否要删」与「是否有生产保留授权」合成实际模式。
 * 删除需要两者同时成立；其余组合一律 dry-run，未授权时单独标记为拒绝。
 */
export function resolveRetentionMode(input: {
  requestedDelete?: boolean;
  authorized?: boolean;
}): RetentionModeDecision {
  const requestedDelete = input.requestedDelete === true;
  const authorized = input.authorized === true;
  if (!requestedDelete) return { mode: 'dry-run', rejected: false };
  if (!authorized) return { mode: 'dry-run', rejected: true };
  return { mode: 'delete', rejected: false };
}

export type AnalyticsRetentionHistory = {
  /** 本轮删除会碰到的站点本地日（升序去重）。 */
  affectedDays: string[];
  /** 仍完整可重算、已先整日聚合的日。 */
  recomputedDays: string[];
  /** 已有完整旧聚合、保留原结果的日。 */
  preservedDays: string[];
  /** 既无完整旧聚合、又不在可整日重算范围内：显式覆盖缺口。 */
  gapDays: string[];
  /** 历史受影响日汇总出的覆盖度；近期 complete 不能覆盖它。 */
  coverage: CoverageState;
};

export type AnalyticsRetentionReport = {
  mode: RetentionMode;
  requestedDelete: boolean;
  authorized: boolean;
  /** 同一固定截止值下的事件/日聚合/水位候选条数。 */
  candidates: RetentionCandidateCounts;
  deletedEvents: number;
  deletedRollupDailyRows: number;
  deletedRollupDays: number;
  batches: number;
  /** 本轮综合覆盖度：历史受影响日与近期聚合取最坏值。 */
  coverage: CoverageState;
  history: AnalyticsRetentionHistory;
  /** 完整原始覆盖起点（UTC 瞬时与所在站点本地日），用于解释 partial/unavailable。 */
  completeRawCoverageStartUtc: string;
  completeRawCoverageStartLocalDate: string;
  /** 事件到期上界（receivedAt <= 此瞬时即到期）。 */
  eventExpiryCutoff: string;
  /** 汇总到期上界（siteDate <= 此本地日即到期）。 */
  rollupExpiryCutoff: string;
  recomputedDays: number;
  skippedDays: string[];
};

export type HistoricalDayClass = 'expired' | 'recomputable' | 'preserved' | 'gap';

export type HistoricalDayInput = {
  siteDate: string;
  /** 该站点本地日的 UTC 起点（siteDayUtcBounds().startUtc）。 */
  dayStartUtc: string;
  /** 该日是否已有完整旧聚合标记（AnalyticsRollupDay 行）。 */
  hasAggregate: boolean;
};

/**
 * 删除前逐受影响站点日分类。顺序即优先级：
 * 1. 已过 13 个自然月的日：原始与聚合都在本轮到期，按保留规则正常删，不记缺口；
 * 2. 日界不早于完整原始覆盖起点：仍可整日重算，先聚合再删；
 * 3. 已有完整旧聚合：保留原结果，原始覆盖变为不完整；
 * 4. 其余：既不能重算、也没有旧聚合，显式记覆盖缺口。
 *
 * 这是纯函数：调用方负责在预算内读取标记、并只为 recomputable 日调用既有聚合能力。
 */
export function classifyHistoricalDays(input: {
  days: readonly HistoricalDayInput[];
  /** recomputableFrom(now, timezone) 的 UTC 瞬时。 */
  completeRawCoverageStartUtc: string;
  /** 汇总到期上界：siteDate <= 此本地日即已过 13 个自然月。 */
  rollupExpiryThrough: string;
}): Pick<AnalyticsRetentionHistory, 'affectedDays' | 'recomputedDays' | 'preservedDays' | 'gapDays' | 'coverage'> {
  const start = Date.parse(input.completeRawCoverageStartUtc);
  const affectedDays: string[] = [];
  const recomputedDays: string[] = [];
  const preservedDays: string[] = [];
  const gapDays: string[] = [];
  for (const day of input.days) {
    affectedDays.push(day.siteDate);
    if (day.siteDate <= input.rollupExpiryThrough) continue;
    const dayStart = Date.parse(day.dayStartUtc);
    if (Number.isFinite(start) && Number.isFinite(dayStart) && dayStart >= start) {
      recomputedDays.push(day.siteDate);
      continue;
    }
    if (day.hasAggregate) preservedDays.push(day.siteDate);
    else gapDays.push(day.siteDate);
  }
  const coverage: CoverageState = gapDays.length > 0 ? 'unavailable' : preservedDays.length > 0 ? 'partial' : 'complete';
  return { affectedDays, recomputedDays, preservedDays, gapDays, coverage };
}

/** 历史与近期覆盖度取最坏值：recent complete 不能掩盖历史 gap。 */
export function worstCoverage(left: CoverageState, right: CoverageState): CoverageState {
  const rank: Record<CoverageState, number> = { complete: 0, partial: 1, unavailable: 2 };
  return rank[left] >= rank[right] ? left : right;
}

export type AnalyticsRetentionRun =
  | { kind: 'busy' }
  | { kind: 'timeout' }
  | {
      kind: 'completed';
      status: JobResultStatus;
      errorCode: AppErrorCode | null;
      counts: JobCountsDTO;
      report: AnalyticsRetentionReport;
    }
  /** 终态没写进数据库：调用方不能对外宣称 SUCCEEDED/FAILED 已持久化。 */
  | { kind: 'finish_failed'; report: AnalyticsRetentionReport };

/** 只碰分析三表与 JobState/SiteSetting；不读也不写备份、恢复或业务表。 */
export type RetentionDb = Pick<PrismaClient, '$queryRaw' | '$executeRaw' | '$transaction'>;

type Acquired = Extract<Awaited<ReturnType<ReturnType<typeof createJobLeaseRepo>['claimPreservingStatus']>>, { acquired: true }>;

/** 本轮预算耗尽：不写终态，租约 90s 后由下一次调度接管。 */
class RetentionRunTimeout extends Error {
  constructor() {
    super('retention_run_timeout');
    this.name = 'RetentionRunTimeout';
  }
}

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name)) return error.name;
  return 'Error';
}

function errorCodeOf(error: unknown): AppErrorCode {
  if (error instanceof AggregateVersionConflict) return 'version_conflict';
  if (error instanceof AggregateBatchExceeded) return 'invalid';
  return 'internal_error';
}

function emptyReport(decision: RetentionModeDecision, requestedDelete: boolean, authorized: boolean): AnalyticsRetentionReport {
  return {
    mode: decision.mode,
    requestedDelete,
    authorized,
    candidates: { events: 0, rollupDailyRows: 0, rollupDays: 0, total: 0 },
    deletedEvents: 0,
    deletedRollupDailyRows: 0,
    deletedRollupDays: 0,
    batches: 0,
    coverage: 'unavailable',
    history: { affectedDays: [], recomputedDays: [], preservedDays: [], gapDays: [], coverage: 'complete' },
    completeRawCoverageStartUtc: '',
    completeRawCoverageStartLocalDate: '',
    eventExpiryCutoff: '',
    rollupExpiryCutoff: '',
    recomputedDays: 0,
    skippedDays: [],
  };
}

function countsFor(report: AnalyticsRetentionReport): JobCountsDTO {
  const deleted = report.deletedEvents + report.deletedRollupDailyRows + report.deletedRollupDays;
  return {
    candidateCount: report.candidates.total,
    deletedCount: deleted,
  };
}

/**
 * 跑一轮分析保留。调用方（registry 的包装）已把整轮预算、业务时钟与中止信号
 * 放进 `context`；本函数不读请求、不读环境变量，授权与批量参数都显式传入。
 */
export async function runAnalyticsRetention(deps: {
  db: RetentionDb;
  context: JobRunContext;
  clock?: () => Date;
  /** 显式生产保留授权（容器 RETENTION_CLEANUP_MODE=delete），缺省 false。 */
  deleteAuthorized?: boolean;
  batchSize?: number;
  maxPerRun?: number;
  /** 测试注入：claim 成功后、读设置前执行，用于制造租约被接管的场景。 */
  afterClaim?: (claim: { generation: number; timezoneRevision: number }) => Promise<void>;
}): Promise<AnalyticsRetentionRun> {
  const clock = deps.clock ?? (() => new Date());
  const budget: JobBudget = createJobBudget(deps.context);
  const now = deps.context.now;
  const requestedDelete = deps.context.dryRun === false;
  const authorized = deps.deleteAuthorized === true;
  const decision = resolveRetentionMode({ requestedDelete, authorized });
  const report = emptyReport(decision, requestedDelete, authorized);
  const batchSize = deps.batchSize ?? RETENTION_CLEANUP_BATCH_SIZE;
  const maxPerRun = deps.maxPerRun ?? RETENTION_CLEANUP_MAX_PER_RUN;

  // 1. 领取与 5 分钟聚合同一把租约：聚合进行中时本轮直接 409，不读半截快照、
  //    也不会在聚合写 watermark 的同时删行。claim 本身也受本轮剩余预算约束。
  const claimed = await runWithinBudget(deps.db, budget, (tx) =>
    createJobLeaseRepo({ db: tx, clock }).claimPreservingStatus({
      key: ANALYTICS_ROLLUP_JOB_KEY,
      owner: RETENTION_OWNER,
    }));
  if (claimed.kind === 'budget') return { kind: 'timeout' };
  if (claimed.kind === 'error') throw claimed.error;
  const claimResult = claimed.value;
  if (!claimResult.acquired) {
    if (claimResult.reason === 'busy') return { kind: 'busy' };
    throw new Error(`retention_claim_${claimResult.reason}`);
  }
  const claim: Acquired = claimResult;

  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(maxPerRun) || maxPerRun < batchSize) {
    return persist('FAILED', 'invalid', report, deps, budget, claim, now);
  }

  if (deps.afterClaim) await deps.afterClaim({ generation: claim.generation, timezoneRevision: claim.timezoneRevision });

  const repo = createJobLeaseRepo({ db: deps.db, clock });

  /** 写终态：释放 analytics-aggregate 租约，结果写到 analytics-retention（同事务）。 */
  async function persist(
    status: JobResultStatus,
    errorCode: AppErrorCode | null,
    payload: AnalyticsRetentionReport,
    dbDeps: { db: RetentionDb },
    runBudget: JobBudget,
    heldClaim: Acquired,
    finishedAt: Date,
  ): Promise<AnalyticsRetentionRun> {
    const summary = {
      counts: {
        candidateCount: payload.candidates.total,
        deletedCount: payload.deletedEvents + payload.deletedRollupDailyRows + payload.deletedRollupDays,
      },
      times: { aggregatedAt: finishedAt.toISOString() },
      versions: { timezoneRevision: heldClaim.timezoneRevision },
    };
    const written = await runWithinBudget(dbDeps.db, runBudget, (tx) =>
      createJobLeaseRepo({ db: tx, clock }).completeSeparately({
        leaseKey: ANALYTICS_ROLLUP_JOB_KEY,
        statusKey: ANALYTICS_RETENTION_KEY,
        owner: RETENTION_OWNER,
        generation: heldClaim.generation,
        status,
        summary,
        errorCode,
        timezoneRevision: heldClaim.timezoneRevision,
      }, tx));
    if (written.kind === 'budget') return { kind: 'timeout' };
    if (written.kind === 'error') {
      // 旧代次/租约过期/时区代次不符：整笔回滚，不能宣称已持久化。
      console.error('[cron] analytics retention lease finish failed', errorName(written.error));
      return { kind: 'finish_failed', report: payload };
    }
    return { kind: 'completed', status, errorCode, counts: countsFor(payload), report: payload };
  }

  const persistHere = (status: JobResultStatus, errorCode: AppErrorCode | null, payload: AnalyticsRetentionReport) =>
    persist(status, errorCode, payload, deps, budget, claim, now);

  try {
    // 2. 站点时钟：代次与租约领取时不一致说明期间改过时区，整轮不写。
    const settings = await runWithinBudget(deps.db, budget, (tx) => readAnalyticsSiteClock(tx));
    if (settings.kind === 'budget') return { kind: 'timeout' };
    if (settings.kind === 'error') return persistHere('FAILED', 'service_unavailable', report);
    const siteClock = settings.value;
    if (siteClock === 'corrupt' || siteClock.timezoneRevision !== claim.timezoneRevision) {
      return persistHere('FAILED', 'service_unavailable', report);
    }

    const timezone = siteClock.timezone;
    const currentDate = siteLocalDate(now, timezone);
    const eventCutoff = eventExpiryCutoff(now);
    const rollupThrough = rollupExpiryCutoff(now, timezone);
    const coveragePlan = rawCoveragePlan(now, timezone);
    const plan = planSnapshot({ now, siteTimezone: timezone, currentDate });
    report.eventExpiryCutoff = eventCutoff.toISOString();
    report.rollupExpiryCutoff = rollupThrough;
    report.completeRawCoverageStartUtc = coveragePlan.completeRawCoverageStartUtc;
    report.completeRawCoverageStartLocalDate = coveragePlan.completeRawCoverageStartLocalDate;
    report.coverage = plan.coverage;
    report.skippedDays = [...plan.skippedDates];

    // 3. 候选：与删除用同一套截止值，只取计数，不选浏览器哈希/路径/事件正文。
    const counted = await runWithinBudget(deps.db, budget, (tx) =>
      createRetentionCandidateRepo({ db: tx, now, siteTimezone: timezone }).counts());
    if (counted.kind === 'budget') return { kind: 'timeout' };
    if (counted.kind === 'error') throw counted.error;
    report.candidates = counted.value;

    // 4. 默认路径：dry-run 或未授权删除请求。都不写一行。
    if (decision.mode === 'dry-run') {
      if (decision.rejected) return persistHere('FAILED', 'forbidden', report);
      return persistHere('SUCCEEDED', null, report);
    }

    // 5. 删除前 preflight：按受影响站点日分类，缺口显式上报（09:72 / E-82）。
    //    只有日界不早于完整原始覆盖起点的日才允许先整日聚合；其余不碰旧聚合，
    //    也不为了凑 complete 去调单日测试路径或伪造 now/currentDate。
    const affected = await runWithinBudget(deps.db, budget, (tx) =>
      tx.$queryRaw<{ siteDate: string; hasAggregate: boolean }[]>(Prisma.sql`
        SELECT d."siteDate" AS "siteDate", (r."siteDate" IS NOT NULL) AS "hasAggregate"
        FROM (
          SELECT DISTINCT to_char(
            ("receivedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM-DD'
          ) AS "siteDate"
          FROM "AnalyticsEvent"
          WHERE "receivedAt" <= ${utc(eventCutoff)}
          ORDER BY 1
          LIMIT ${maxPerRun}
        ) AS d
        LEFT JOIN "AnalyticsRollupDay" AS r ON r."siteDate" = d."siteDate"
        ORDER BY d."siteDate"
      `));
    if (affected.kind === 'budget') return { kind: 'timeout' };
    if (affected.kind === 'error') throw affected.error;
    report.history = classifyHistoricalDays({
      days: affected.value.map((row) => ({
        siteDate: row.siteDate,
        dayStartUtc: siteDayUtcBounds(row.siteDate, timezone).startUtc,
        hasAggregate: row.hasAggregate,
      })),
      completeRawCoverageStartUtc: coveragePlan.completeRawCoverageStartUtc,
      rollupExpiryThrough: rollupThrough,
    });
    if (report.history.gapDays.length > 0 || report.history.preservedDays.length > 0) {
      console.info('[cron] analytics retention history coverage', {
        affected: report.history.affectedDays.length,
        recomputed: report.history.recomputedDays.length,
        preserved: report.history.preservedDays.length,
        gap: report.history.gapDays.length,
      });
    }
    for (const siteDate of [...report.history.recomputedDays]) {
      if (budgetExhausted(budget)) throw new RetentionRunTimeout();
      try {
        await aggregateOneDayInSnapshot({
          db: deps.db,
          siteDate,
          siteTimezone: timezone,
          cutoff: now,
          timezoneRevision: claim.timezoneRevision,
          generation: claim.generation,
          now,
        });
      } catch (error) {
        if (error instanceof AggregateDeadlineExceeded || isBudgetTimeoutError(error)) throw new RetentionRunTimeout();
        if (error instanceof AggregateVersionConflict) throw error;
        // 先尝试失败：不重写历史、不用残片补，降级为显式缺口。
        console.error('[cron] analytics retention preflight aggregate skipped', errorName(error));
        report.history.recomputedDays = report.history.recomputedDays.filter((day) => day !== siteDate);
        report.history.gapDays = [...report.history.gapDays, siteDate].sort();
        report.history.coverage = 'unavailable';
      }
    }

    // 6. 删除：每批独立事务，批内续租并按剩余预算重设 statement/lock timeout。
    const runBatch = async (work: (tx: Prisma.TransactionClient) => Promise<number>): Promise<number> => {
      if (budgetExhausted(budget)) throw new RetentionRunTimeout();
      const result = await runWithinBudget(deps.db, budget, async (tx) => {
        await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: RETENTION_OWNER, generation: claim.generation }, tx);
        return work(tx);
      });
      if (result.kind === 'budget') throw new RetentionRunTimeout();
      if (result.kind === 'error') throw result.error;
      return Number(result.value);
    };

    /**
     * 每批事务提交返回后才记入报告：中途某批失败时，前面已提交批次的真实删除数
     * 仍在返回计数和 FAILED 摘要里；失败批次不计，已计入的不重复。
     */
    const drain = async (
      cap: number,
      remove: (limit: number) => Promise<number>,
      commit: (count: number) => void,
    ): Promise<void> => {
      let removed = 0;
      while (removed < cap) {
        const limit = Math.min(batchSize, cap - removed);
        const count = await remove(limit);
        if (!Number.isInteger(count) || count < 0 || count > limit) throw new Error('retention_batch_invalid');
        if (count === 0) break;
        removed += count;
        commit(count);
        report.batches += 1;
        if (count < limit) break;
      }
    };

    await drain(maxPerRun, (limit) => runBatch((tx) => tx.$executeRaw(Prisma.sql`
      DELETE FROM "AnalyticsEvent"
      WHERE "eventId" IN (
        SELECT "eventId" FROM "AnalyticsEvent"
        WHERE "receivedAt" <= ${utc(eventCutoff)}
        ORDER BY "receivedAt" ASC, "eventId" ASC
        LIMIT ${limit}
      )
    `)), (count) => {
      report.deletedEvents += count;
    });

    const remainingAfterEvents = maxPerRun - report.deletedEvents;
    if (remainingAfterEvents > 0) {
      await drain(remainingAfterEvents, (limit) => runBatch((tx) => tx.$executeRaw(Prisma.sql`
        DELETE FROM "AnalyticsDailyRollup" AS target
        USING (
          SELECT "siteDate", "kind", "locale", "productSlug"
          FROM "AnalyticsDailyRollup"
          WHERE "siteDate" <= ${rollupThrough}
          ORDER BY "siteDate" ASC, "kind" ASC, "locale" ASC, "productSlug" ASC
          LIMIT ${limit}
        ) AS picked
        WHERE target."siteDate" = picked."siteDate"
          AND target."kind" = picked."kind"
          AND target."locale" = picked."locale"
          AND target."productSlug" = picked."productSlug"
      `)), (count) => {
        report.deletedRollupDailyRows += count;
      });
    }

    const remainingAfterDaily = maxPerRun - report.deletedEvents - report.deletedRollupDailyRows;
    if (remainingAfterDaily > 0) {
      await drain(remainingAfterDaily, (limit) => runBatch((tx) => tx.$executeRaw(Prisma.sql`
        DELETE FROM "AnalyticsRollupDay"
        WHERE "siteDate" IN (
          SELECT "siteDate" FROM "AnalyticsRollupDay"
          WHERE "siteDate" <= ${rollupThrough}
          ORDER BY "siteDate" ASC
          LIMIT ${limit}
        )
      `)), (count) => {
        report.deletedRollupDays += count;
      });
    }

    // 7. 清理后调用既有聚合服务：只重算 dayStart >= 完整原始覆盖起点的日，
    //    超范围的日子留在旧聚合里，用 coverage=partial/unavailable 上报。
    const aggregate = await runAggregateOnce({
      db: deps.db,
      now,
      siteTimezone: timezone,
      currentDate,
      timezoneRevision: claim.timezoneRevision,
      generation: claim.generation,
      deadlineAt: budget.deadlineAt,
      occurredNotAfter: now,
      maxBatchDays: JOB_MAX_BATCH,
    });
    report.recomputedDays = aggregate.days.filter((day) => day.written).length;
    report.skippedDays = aggregate.days.filter((day) => !day.written).map((day) => day.siteDate);
    // 历史受影响日与近期窗口取最坏值：近期 complete 不得掩盖历史 gap/preserved。
    report.coverage = worstCoverage(report.history.coverage, aggregate.coverage);
    const status: JobResultStatus = report.coverage === 'complete' ? 'SUCCEEDED' : 'PARTIAL';
    return persistHere(status, status === 'SUCCEEDED' ? null : 'source_unavailable', report);
  } catch (error) {
    if (error instanceof RetentionRunTimeout) return { kind: 'timeout' };
    if (error instanceof AggregateDeadlineExceeded || isBudgetTimeoutError(error) || budgetExhausted(budget)) {
      return { kind: 'timeout' };
    }
    console.error('[cron] analytics retention failed', errorName(error));
    return persistHere('FAILED', errorCodeOf(error), report);
  }
}

/**
 * registry 的固定作业包装：把服务结果映射成 JobRunOutcome。
 * 预算耗尽返回 timeout（不写终态，handler 503）；终态没写成返回 finish_failed（handler 500）。
 */
export function createAnalyticsRetentionJob(deps: {
  db: RetentionDb;
  clock?: () => Date;
  /** 显式生产保留授权；生产组合点只在容器设了 RETENTION_CLEANUP_MODE=delete 时为 true。 */
  deleteAuthorized?: boolean;
}): RegisteredJob {
  return {
    key: ANALYTICS_RETENTION_KEY,
    async run(context: JobRunContext): Promise<JobRunOutcome> {
      const result = await runAnalyticsRetention({
        db: deps.db,
        context,
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(deps.deleteAuthorized !== undefined ? { deleteAuthorized: deps.deleteAuthorized } : {}),
      });
      if (result.kind === 'busy') return { kind: 'busy' };
      if (result.kind === 'timeout') return { kind: 'timeout' };
      if (result.kind === 'finish_failed') return { kind: 'finish_failed' };
      return { kind: 'ran', status: result.status, counts: result.counts };
    },
  };
}
