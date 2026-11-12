import { Prisma, type PrismaClient } from '@prisma/client';
import { planSnapshot, type CoverageState } from '../../analytics/aggregate-plan';
import { utcDatesCovered } from '../../analytics/daily-aggregate';
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
  AggregateCommitUnknown,
  AggregateDeadlineExceeded,
  AggregateGuardFailure,
  AggregateVersionConflict,
  aggregateOneDayInSnapshot,
  assertCurrentTimezoneRevision,
  runAggregateOnce,
} from './aggregate';
import { dailyExpiresAt, parseMarkerVersions } from './aggregate-day-state';
import {
  DAILY_RETENTION_MAX_PER_RUN,
  DAILY_RETENTION_SCAN_LIMIT,
  METADATA_RETENTION_MAX_PER_TABLE,
  METADATA_RETENTION_MAX_TOTAL,
  NEW_TABLE_RETENTION_BATCH,
  RETENTION_CLEANUP_BATCH_SIZE,
  RETENTION_CLEANUP_MAX_PER_RUN,
  candidateCountLabels,
  createRetentionCandidateRepo,
  dayChangeRetentionCutoff,
  eventExpiryCutoff,
  metadataRetentionCaps,
  rawCoveragePlan,
  rollupExpiryCutoff,
  stateRetentionFloor,
  utcDateOf,
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
 *      的日聚合与日水位；每批一个事务、批内续租，合计不超过单轮上限。每个删除批次在写入前
 *      原子复核时区代次（`assertCurrentTimezoneRevision`），冲突即停手，已提交批次仍如实计数。
 *   4. 重算：删完调用既有 `runAggregateOnce`，只重算 `dayStart >= 完整原始覆盖起点`
 *      的自然日（今天 + 48h 迟到窗口）；超范围保留旧聚合、不重建过期明细。
 *   5. 完整性：没有可证明的提交闭集，因此不判任何历史日「完整」；旧 `AnalyticsRollupDay`
 *      行只作为「原结果实物仍在」报 retained，其余非可重算日记 gap，旧行与 revision 原样保留。
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
  /**
   * 旧 `AnalyticsRollupDay` 行仍在、但完整性**无法确认**的日：本轮不重算、不删、不覆盖。
   * 它只表示「旧结果实物留在库里」，不是完整性证明，也不能当成当前口径；
   * 原始事件仍按 30 天规则删除，不因此延长保留。
   */
  retainedAggregateDays: string[];
  /** 既不能重算、也没有旧聚合留存的日：显式覆盖缺口。 */
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
  /** M5-T12 新表：`AnalyticsDaily`（唯一清理者，`expiresAt<=now`，每轮 ≤1,000 行）。 */
  deletedDailyRows: number;
  /** `AnalyticsAggregateDayState`：13 月到期且无未到期 daily 行才删。 */
  deletedDayStates: number;
  /** `AnalyticsDayChange`：UTC 日严格早于 13 自然月＋2 天且无存续 state 引用才删。 */
  deletedDayChanges: number;
  /** 坏时区被定向保留的 state 行数（只诊断，不删）。 */
  retainedBadTimezoneStates: number;
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

export type HistoricalDayInput = {
  siteDate: string;
  /** 该站点本地日的 UTC 起点（siteDayUtcBounds）。 */
  dayStartUtc: string;
  /** 该日是否仍有旧的 `AnalyticsRollupDay` 行：只作「旧结果实物仍在」的观察，不判完整性。 */
  hasAggregate: boolean;
};

/**
 * 删除前逐受影响站点日分类。顺序即优先级：
 * 1. 已过 13 个自然月的日：原始与聚合都在本轮到期，按保留规则正常删，不记缺口；
 * 2. 日界不早于完整原始覆盖起点：仍可整日重算，先聚合再删；
 * 3. 仍有旧 `AnalyticsRollupDay` 行：保留原结果实物，报 retained（完整性无法确认，不冒充当前口径）；
 * 4. 其余：显式记覆盖缺口。
 *
 * 数据窄核结论（`db-m5t11-r2-predicate` §3）：`timezoneRevision`、`completedAt`、`sourceMaxReceivedAt`
 * 都推不出「接收后已提交可见」的提交闭集，所以这里没有任何「旧聚合完整」的判定，也不接受调用方
 * 传入 settle 数值；只保留旧结果是否仍在的观察。失败的重算日一律记 gap。
 *
 * 这是纯函数：调用方负责在预算内读取受影响日与旧行是否存在，并只为 recomputable 日调用既有聚合能力。
 */
export function classifyHistoricalDays(input: {
  days: readonly HistoricalDayInput[];
  /** recomputableFrom(now, timezone) 的 UTC 瞬时。 */
  completeRawCoverageStartUtc: string;
  /** 汇总到期上界：siteDate <= 此本地日即已过 13 个自然月。 */
  rollupExpiryThrough: string;
}): Pick<
  AnalyticsRetentionHistory,
  'affectedDays' | 'recomputedDays' | 'retainedAggregateDays' | 'gapDays' | 'coverage'
> {
  const start = Date.parse(input.completeRawCoverageStartUtc);
  const affectedDays: string[] = [];
  const recomputedDays: string[] = [];
  const retainedAggregateDays: string[] = [];
  const gapDays: string[] = [];
  for (const day of input.days) {
    affectedDays.push(day.siteDate);
    if (day.siteDate <= input.rollupExpiryThrough) continue;
    const dayStart = Date.parse(day.dayStartUtc);
    if (Number.isFinite(start) && Number.isFinite(dayStart) && dayStart >= start) {
      recomputedDays.push(day.siteDate);
      continue;
    }
    if (day.hasAggregate) retainedAggregateDays.push(day.siteDate);
    else gapDays.push(day.siteDate);
  }
  const coverage: CoverageState = gapDays.length > 0 ? 'unavailable' : retainedAggregateDays.length > 0 ? 'partial' : 'complete';
  return { affectedDays, recomputedDays, retainedAggregateDays, gapDays, coverage };
}

/** 由当前 retained/gap 重算历史覆盖度：聚合失败回退时用它，而不是沿用旧值。 */
export function coverageOfHistory(history: Pick<AnalyticsRetentionHistory, 'retainedAggregateDays' | 'gapDays'>): CoverageState {
  if (history.gapDays.length > 0) return 'unavailable';
  if (history.retainedAggregateDays.length > 0) return 'partial';
  return 'complete';
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

/**
 * 守卫阶段失败（版本冲突或守卫本身没能完成）必须终止本轮：不能再记 gap、更不能继续删除。
 * 校验通过之后的普通聚合失败不在此列，仍按契约记 gap。
 */
export function abortsRetentionRun(error: unknown): boolean {
  return error instanceof AggregateVersionConflict
    || error instanceof AggregateGuardFailure
    || error instanceof AggregateCommitUnknown;
}

function errorCodeOf(error: unknown): AppErrorCode {
  if (error instanceof AggregateVersionConflict) return 'version_conflict';
  // 守卫未完成：按内部错误上报，不冒充版本冲突，也不是普通聚合失败。
  if (error instanceof AggregateGuardFailure) return 'internal_error';
  if (error instanceof AggregateBatchExceeded) return 'invalid';
  return 'internal_error';
}

function emptyReport(decision: RetentionModeDecision, requestedDelete: boolean, authorized: boolean): AnalyticsRetentionReport {
  return {
    mode: decision.mode,
    requestedDelete,
    authorized,
    candidates: { events: 0, rollupDailyRows: 0, rollupDays: 0, total: 0, daily: 0, dayState: 0, dayChange: 0, totalAll: 0 },
    deletedEvents: 0,
    deletedRollupDailyRows: 0,
    deletedRollupDays: 0,
    deletedDailyRows: 0,
    deletedDayStates: 0,
    deletedDayChanges: 0,
    retainedBadTimezoneStates: 0,
    batches: 0,
    coverage: 'unavailable',
    history: {
      affectedDays: [],
      recomputedDays: [],
      retainedAggregateDays: [],
      gapDays: [],
      coverage: 'complete',
    },
    completeRawCoverageStartUtc: '',
    completeRawCoverageStartLocalDate: '',
    eventExpiryCutoff: '',
    rollupExpiryCutoff: '',
    recomputedDays: 0,
    skippedDays: [],
  };
}

function countsFor(report: AnalyticsRetentionReport): JobCountsDTO {
  const deleted = report.deletedEvents + report.deletedRollupDailyRows + report.deletedRollupDays
    + report.deletedDailyRows + report.deletedDayStates + report.deletedDayChanges;
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
    // 候选计数进生产日志：分栏按预算口径，metadata 不并入四表上限；dry-run 也打，便于对账。
    // 只含计数、常量与截止值，不含行内容或连接信息。
    console.info('[cron] analytics retention candidates', {
      ...candidateCountLabels(report.candidates),
      mode: decision.mode,
      fourTableBudgetLimit: maxPerRun,
      dailyCap: DAILY_RETENTION_MAX_PER_RUN,
      stateScanLimit: DAILY_RETENTION_SCAN_LIMIT,
      metadataPerTableCap: METADATA_RETENTION_MAX_PER_TABLE,
      metadataTotalCap: METADATA_RETENTION_MAX_TOTAL,
      dailyCutoff: now.toISOString(),
      stateFloor: stateRetentionFloor(currentDate),
      dayChangeCutoff: dayChangeRetentionCutoff(utcDateOf(now)),
    });

    // 4. 默认路径：dry-run 或未授权删除请求。都不写一行。
    if (decision.mode === 'dry-run') {
      if (decision.rejected) return persistHere('FAILED', 'forbidden', report);
      return persistHere('SUCCEEDED', null, report);
    }

    // 5. 删除前 preflight：按受影响站点日分类，缺口显式上报（09:72 / E-82）。
    //    删除资格按 receivedAt，但聚合归属日必须看 occurredAt（跨日迟到可能差一到两天），
    //    否则缺口会标在错误的统计日上。
    // 5. 删除前 preflight（D2）：候选事件集合与本轮删除共用同一有界集合同序——
    //    先按 receivedAt,eventId 取前 maxPerRun 个待删事件，再从这批事件派生 occurredAt 站点日，
    //    删除只按这份 id 清单分批，不会滑入未分类事件。
    const candidateRows = await runWithinBudget(deps.db, budget, (tx) =>
      tx.$queryRaw<{ eventId: string; siteDate: string }[]>(Prisma.sql`
        SELECT "eventId" AS "eventId",
               to_char(("occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS "siteDate"
        FROM "AnalyticsEvent"
        WHERE "receivedAt" <= ${utc(eventCutoff)}
        ORDER BY "receivedAt" ASC, "eventId" ASC
        LIMIT ${maxPerRun}
      `));
    if (candidateRows.kind === 'budget') return { kind: 'timeout' };
    if (candidateRows.kind === 'error') throw candidateRows.error;
    const candidateIds = candidateRows.value.map((row) => row.eventId);
    const affectedSiteDates = [...new Set(candidateRows.value.map((row) => row.siteDate))].sort();

    // 5a. 旧结果是否仍在（D5）：只读 `AnalyticsRollupDay` 行是否存在。
    //     不读 revision/watermark/完成时刻：数据窄核确认这些字段推不出提交闭集，
    //     不能用来判完整；旧行只作为「原结果实物还在」的观察。
    const existingAggregateDays = new Set<string>();
    if (affectedSiteDates.length > 0) {
      const existingRead = await runWithinBudget(deps.db, budget, (tx) =>
        tx.$queryRaw<{ siteDate: string }[]>(Prisma.sql`
          SELECT "siteDate" AS "siteDate"
          FROM "AnalyticsRollupDay"
          WHERE "siteDate" IN (${Prisma.join(affectedSiteDates)})
        `));
      if (existingRead.kind === 'budget') return { kind: 'timeout' };
      if (existingRead.kind === 'error') throw existingRead.error;
      for (const row of existingRead.value) existingAggregateDays.add(row.siteDate);
    }

    report.history = classifyHistoricalDays({
      days: affectedSiteDates.map((siteDate) => ({
        siteDate,
        dayStartUtc: siteDayUtcBounds(siteDate, timezone).startUtc,
        hasAggregate: existingAggregateDays.has(siteDate),
      })),
      completeRawCoverageStartUtc: coveragePlan.completeRawCoverageStartUtc,
      rollupExpiryThrough: rollupThrough,
    });
    // 可整日重算的到期日：删除前先整日聚合，事务预算取本轮剩余预算。
    // 预算耗尽 → 删除前停手；代次冲突 → 交给外层按 FAILED 处理；其它失败 → 显式缺口。
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
          deadlineAt: budget.deadlineAt,
          occurredNotAfter: now,
          // D4：写前原子复核时区代次；旧快照/并发更新导致的冲突必须让本轮停手，不能降级成 gap。
          assertTimezoneRevision: true,
        });
      } catch (error) {
        if (error instanceof AggregateDeadlineExceeded || isBudgetTimeoutError(error) || budgetExhausted(budget)) {
          throw new RetentionRunTimeout();
        }
        // 守卫阶段失败（含 23505/未知 SQLSTATE 这类“核对没完成”的错误）：终止整轮，
        // 不记 gap、不继续删除。只有校验通过后的普通聚合失败才走下面的 gap 分支。
        if (abortsRetentionRun(error)) throw error;
        // 尝试已发生但失败：完整性无法确认，记 gap；随后仍按 30 天删除，
        // 不无限延长原始保留，也不改写旧聚合实物。
        console.error('[cron] analytics retention preflight aggregate failed', errorName(error));
        report.history.recomputedDays = report.history.recomputedDays.filter((day) => day !== siteDate);
        report.history.gapDays = [...report.history.gapDays, siteDate].sort();
        report.history.coverage = coverageOfHistory(report.history);
      }
    }
    if (report.history.gapDays.length > 0 || report.history.retainedAggregateDays.length > 0) {
      console.info('[cron] analytics retention history coverage', {
        affected: report.history.affectedDays.length,
        recomputed: report.history.recomputedDays.length,
        retained: report.history.retainedAggregateDays.length,
        gap: report.history.gapDays.length,
      });
    }

    // 6. 删除：每批独立事务，批内续租并按剩余预算重设 statement/lock timeout。
    const runBatch = async (work: (tx: Prisma.TransactionClient) => Promise<number>): Promise<number> => {
      if (budgetExhausted(budget)) throw new RetentionRunTimeout();
      const result = await runWithinBudget(deps.db, budget, async (tx) => {
        await repo.renew({ key: ANALYTICS_ROLLUP_JOB_KEY, owner: RETENTION_OWNER, generation: claim.generation }, tx);
        // D4：续租后、删除前原子复核时区代次。冲突直接抛出：本批不写、后续批次也不继续，
        // 之前已提交的批次仍按真实差量计入报告。
        await assertCurrentTimezoneRevision(tx, claim.timezoneRevision, now);
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

    // 6. 删除：只删 preflight 同一份候选 id 清单，逐批续租 + 预算；
    //    每批事务提交后立刻累计，失败批次不计（B2 机制不变）。
    for (let offset = 0; offset < candidateIds.length; offset += batchSize) {
      const slice = candidateIds.slice(offset, offset + batchSize);
      const removed = await runBatch((tx) => tx.$executeRaw(Prisma.sql`
        DELETE FROM "AnalyticsEvent"
        WHERE "eventId" IN (${Prisma.join(slice)})
          AND "receivedAt" <= ${utc(eventCutoff)}
      `));
      if (!Number.isInteger(removed) || removed < 0 || removed > slice.length) {
        throw new Error('retention_batch_invalid');
      }
      // 与 drain 同口径：只有真正删到行的已提交批次才计批次与行数；0 行说明候选已被别处删掉。
      if (removed > 0) {
        report.deletedEvents += removed;
        report.batches += 1;
      }
    }

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

    // 6b. M5-T12 新三表。04:30 这条链是 `AnalyticsDaily` 的唯一清理者：
    //     行内时区 13 个自然月、`expiresAt <= now`（等号到期）、每轮至多 1,000 行；
    //     四表合计仍受 maxPerRun 约束。先删 daily，再删 state，最后删 marker
    //     （marker 要按**仍存续**的 state 计算保留集）。
    const deletedTotal = () => report.deletedEvents + report.deletedRollupDailyRows + report.deletedRollupDays
      + report.deletedDailyRows + report.deletedDayStates + report.deletedDayChanges;

    const dailyCap = Math.min(DAILY_RETENTION_MAX_PER_RUN, Math.max(0, maxPerRun - deletedTotal()));
    if (dailyCap > 0) {
      await drain(dailyCap, (limit) => runBatch((tx) => tx.$executeRaw(Prisma.sql`
        DELETE FROM "AnalyticsDaily" AS target
        USING (
          SELECT "localDate", "timezoneRevision", "dimension"
          FROM "AnalyticsDaily"
          WHERE "expiresAt" <= ${utc(now)}
          ORDER BY "expiresAt" ASC, "localDate" ASC, "timezoneRevision" ASC, "dimension" ASC
          LIMIT ${limit}
        ) AS picked
        WHERE target."localDate" = picked."localDate"
          AND target."timezoneRevision" = picked."timezoneRevision"
          AND target."dimension" = picked."dimension"
          AND target."expiresAt" <= ${utc(now)}
      `)), (count) => {
        report.deletedDailyRows += count;
      });
    }

    // 6c. day-state：日期预筛后按**行内时区**正推到期；坏时区只诊断、定向保留；
    //     仍有未到期 AnalyticsDaily 行（同 localDate+revision）的一律不删。
    const stateCap = metadataRetentionCaps(0).stateCap;
    if (stateCap > 0) {
      const floor = stateRetentionFloor(currentDate);
      const candidatesRead = await runWithinBudget(deps.db, budget, (tx) =>
        tx.$queryRaw<{ localDate: string; timezoneRevision: number; timezone: string }[]>(Prisma.sql`
          SELECT "localDate", "timezoneRevision", "timezone"
          FROM "AnalyticsAggregateDayState"
          WHERE "localDate" < ${floor}
          ORDER BY "localDate" ASC, "timezoneRevision" ASC
          LIMIT ${DAILY_RETENTION_SCAN_LIMIT}
        `));
      if (candidatesRead.kind === 'budget') return { kind: 'timeout' };
      if (candidatesRead.kind === 'error') throw candidatesRead.error;

      const expired: Array<{ localDate: string; timezoneRevision: number }> = [];
      for (const row of candidatesRead.value) {
        if (expired.length >= stateCap) break;
        try {
          if (dailyExpiresAt(row.localDate, row.timezone).getTime() > now.getTime()) continue;
        } catch {
          report.retainedBadTimezoneStates += 1;
          continue;
        }
        expired.push({ localDate: row.localDate, timezoneRevision: Number(row.timezoneRevision) });
      }

      if (expired.length > 0) {
        const pairs = expired.map((row) => Prisma.sql`(${row.localDate}, ${row.timezoneRevision})`);
        const unexpiredRead = await runWithinBudget(deps.db, budget, (tx) =>
          tx.$queryRaw<{ localDate: string; timezoneRevision: number }[]>(Prisma.sql`
            SELECT DISTINCT "localDate", "timezoneRevision"
            FROM "AnalyticsDaily"
            WHERE "expiresAt" > ${utc(now)}
              AND ("localDate", "timezoneRevision") IN (${Prisma.join(pairs)})
          `));
        if (unexpiredRead.kind === 'budget') return { kind: 'timeout' };
        if (unexpiredRead.kind === 'error') throw unexpiredRead.error;
        const blocked = new Set(unexpiredRead.value.map((row) => `${row.localDate}|${Number(row.timezoneRevision)}`));
        const deletable = expired.filter((row) => !blocked.has(`${row.localDate}|${row.timezoneRevision}`));

        for (let offset = 0; offset < deletable.length; offset += NEW_TABLE_RETENTION_BATCH) {
          const slice = deletable.slice(offset, offset + NEW_TABLE_RETENTION_BATCH);
          const removing = slice.map((row) => Prisma.sql`(${row.localDate}, ${row.timezoneRevision})`);
          const removed = await runBatch((tx) => tx.$executeRaw(Prisma.sql`
            DELETE FROM "AnalyticsAggregateDayState"
            WHERE ("localDate", "timezoneRevision") IN (${Prisma.join(removing)})
          `));
          if (!Number.isInteger(removed) || removed < 0 || removed > slice.length) {
            throw new Error('retention_batch_invalid');
          }
          // 与 drain 同一口径：只有真正删到行的已提交批次才计批次与行数；
          // 0 行说明这批候选已被别处删掉，不当成一次确认删除。
          if (removed > 0) {
            report.deletedDayStates += removed;
            report.batches += 1;
          }
        }
      }
    }

    // 6d. marker：UTC 日严格早于「UTC 今日 − 13 自然月 − 2 天」；保留仍存续 state
    //     覆盖的 UTC 日与 markerVersions 键。state 行读不全（超上限/坏时区）时整步跳过，
    //     宁可不删也不误删仍被引用的 marker。
    const markerCap = metadataRetentionCaps(report.deletedDayStates).markerCap;
    if (markerCap > 0) {
      const survivingRead = await runWithinBudget(deps.db, budget, (tx) =>
        tx.$queryRaw<{ localDate: string; timezone: string; markerVersions: unknown }[]>(Prisma.sql`
          SELECT "localDate", "timezone", "markerVersions"
          FROM "AnalyticsAggregateDayState"
          ORDER BY "localDate" ASC, "timezoneRevision" ASC
          LIMIT ${DAILY_RETENTION_SCAN_LIMIT + 1}
        `));
      if (survivingRead.kind === 'budget') return { kind: 'timeout' };
      if (survivingRead.kind === 'error') throw survivingRead.error;
      const complete = survivingRead.value.length <= DAILY_RETENTION_SCAN_LIMIT;
      const keepMarkers = new Set<string>();
      let badTimezone = !complete;
      if (complete) {
        for (const row of survivingRead.value) {
          for (const key of Object.keys(parseMarkerVersions(row.markerVersions))) keepMarkers.add(key);
          try {
            const bounds = siteDayUtcBounds(row.localDate, row.timezone);
            for (const utcDate of utcDatesCovered(bounds)) keepMarkers.add(utcDate);
          } catch {
            badTimezone = true;
            break;
          }
        }
      }
      if (badTimezone) {
        report.retainedBadTimezoneStates += 1;
      } else {
        const cutoff = dayChangeRetentionCutoff(utcDateOf(now));
        const keep = [...keepMarkers].sort();
        const keepSql = keep.length === 0
          ? Prisma.empty
          : Prisma.sql`AND "utcDate" NOT IN (${Prisma.join(keep)})`;
        await drain(markerCap, (limit) => runBatch((tx) => tx.$executeRaw(Prisma.sql`
          DELETE FROM "AnalyticsDayChange"
          WHERE "utcDate" IN (
            SELECT "utcDate" FROM "AnalyticsDayChange"
            WHERE "utcDate" < ${cutoff} ${keepSql}
            ORDER BY "utcDate" ASC
            LIMIT ${limit}
          )
        `)), (count) => {
          report.deletedDayChanges += count;
        });
      }
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
      // 与本次 claim/complete 同一时钟引用：日轮若在此路径启用，提交点用同一时间基准判租约。
      clock,
      deadlineAt: budget.deadlineAt,
      occurredNotAfter: now,
      maxBatchDays: JOB_MAX_BATCH,
      // D4：删后近期聚合同样在写事务内原子复核时区代次；冲突让整组聚合回滚，
      // 已提交的删除批次仍如实计数，不宣称整轮回滚。
      assertTimezoneRevision: true,
    });
    report.recomputedDays = aggregate.days.filter((day) => day.written).length;
    report.skippedDays = aggregate.days.filter((day) => !day.written).map((day) => day.siteDate);
    // 历史受影响日与近期窗口取最坏值：近期 complete 不得掩盖历史 gap/retained。
    report.coverage = worstCoverage(report.history.coverage, aggregate.coverage);
    const status: JobResultStatus = report.coverage === 'complete' ? 'SUCCEEDED' : 'PARTIAL';
    return persistHere(status, status === 'SUCCEEDED' ? null : 'source_unavailable', report);
  } catch (error) {
    // COMMIT 答复未知：既不能记 FAILED（假“确认回滚”），也不能记 gap 或继续删除。
    // 不写任何终态，交给租约到期后的下一轮；可能已落库的内容以数据库自身状态为准。
    if (error instanceof AggregateCommitUnknown) {
      // 终态没有写进数据库（不是已证预算耗尽，也不能宣“未写/必回滚”）：交回 lease 到期后重试。
      console.error('[cron] analytics retention commit_unknown', {
        phase: error.phase,
        targets: error.unknownTargets.length,
      });
      return { kind: 'finish_failed', report };
    }
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
