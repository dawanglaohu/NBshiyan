import { Prisma, type PrismaClient } from '@prisma/client';
import { isListedCatalogKey } from '../../catalog/catalog';
import {
  computeDailyMetrics,
  factKey,
  utcDatesCovered,
  type AnalyticsFact,
  type DailyMetrics,
} from '../../analytics/daily-aggregate';
import {
  RAW_EVENT_RETENTION_MS,
  recomputableFrom,
  siteDayUtcBounds,
  siteLocalDate,
  type SiteDayBounds,
} from '../../analytics/day-boundaries';
import { aggregateSiteDay, type RollupSourceEvent } from '../../analytics/rollup-plan';
import { planSnapshot, shiftLocalDate, type CoverageState, type SnapshotPlan } from '../../analytics/aggregate-plan';
import { ANALYTICS_SETTINGS_KEY, INITIAL_TIMEZONE_REVISION, StoredTimezoneRevisionSchema } from '../jobs/types';
import {
  AGGREGATE_JOB_KEY,
  findEarliestStart,
  loadDailyDayFacts,
  loadPairedTerminals,
  loadEventsAtSnapshot,
  probeCrossDayInversion,
  probeFilteredStartInversion,
  readLockedGeneration,
  runInRepeatableReadSnapshot,
  upsertWatermarkGuarded,
} from './aggregate-repo';
import {
  RETRY_GAPS,
  TERMINAL_GAPS,
  casWriteDayState,
  dailyExpiresAt,
  insertDayStateIfAbsent,
  mergeDeferUntil,
  readDayState,
  readDayStatesInDomain,
  readLiveMarkerVersions,
  readSiteRowDatesInDomain,
  scanFloorLocalDate,
  type DayStateRow,
} from './aggregate-day-state';

/** 与 aggregate-repo / rollup / event-repo 相同：ISO 字符串再按 UTC 写入 timestamp，避免会话时区平移。 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/**
 * M5-T3 「以一致快照重算并原子替换日聚合」服务层。
 *
 * 09 节 `:71` 的三条硬要求：
 *   - 每轮先定 cutoff，只统计 `receivedAt ≤ cutoff` 的事实；调度作业再传
 *     `occurredNotAfter = now`，让准入的未来事件到其 occurredAt 前不计入（E-60）；
 *   - **整组目标日 + 各自 watermark 在一条 RepeatableRead 事务里替换**，
 *     任一目标日失败整组回滚，进程中断保留上一轮完整结果；
 *   - 用数据库行锁与带 WHERE 守卫的 upsert 做 generation/版本互斥，而非内存判断。
 *
 * 覆盖度（09 节 `:72`）：超出完整原始覆盖的日不重算，返回 partial/unavailable，
 * 不用残片替换旧完整值，也不填 0。
 */

/** 并发/版本冲突：让整组事务回滚，不写任何半成品。 */
export class AggregateVersionConflict extends Error {
  constructor(reason: 'stale_generation' | 'stale_timezone_revision' | 'watermark_regression' | 'write_conflict') {
    super(reason);
    this.name = 'AggregateVersionConflict';
  }
}

/** 本轮预算已用完：整组事务不得再提交，调用方不得宣称成功。 */
export class AggregateDeadlineExceeded extends Error {
  constructor() {
    super('deadline_exceeded');
    this.name = 'AggregateDeadlineExceeded';
  }
}

/** 计划规模超过防御上限：在开启事务前拒绝，不产生任何写入。 */
export class AggregateBatchExceeded extends Error {
  constructor(limit: number) {
    super(`batch_exceeded:${limit}`);
    this.name = 'AggregateBatchExceeded';
  }
}

/**
 * 守卫阶段自身失败：时区代次还没核对完就出错（未知 SQLSTATE、唯一冲突、连接中断等）。
 *
 * 阶段标记而不是错误码黑名单：只要错误出自 `assertCurrentTimezoneRevision`，就说明
 * “revision 校验没有完成”，调用方必须终止本轮、不得继续删除，也不能把它记成普通聚合
 * 失败的 gap。预算错误（55P03/57014/P2028）不在此列，仍按预算分类处理。
 */
export class AggregateGuardFailure extends Error {
  constructor(readonly original: unknown) {
    super('guard_failure');
    this.name = 'AggregateGuardFailure';
  }
}

/**
 * 回调内失败：Prisma 必定回滚，**可以确认没有提交**。
 *
 * 只用于把「回调里抛的错」与「$transaction 在 COMMIT 前后抛的错」分开；原始错误原样保留，
 * 上抛前仍走既有的版本冲突/预算分类。
 */
class AggregateCallbackFailure extends Error {
  constructor(readonly original: unknown) {
    super('aggregate_callback_failure');
    this.name = 'AggregateCallbackFailure';
  }
}

/**
 * COMMIT 答复未知（B7）：事务可能已提交，也可能没有。
 *
 * 此时既不能声称「整笔回滚」，也不能写补偿 gap、重跑旧链、或晚写一个假 FAILED/0 行。
 * `unknownTargets` 是**可能已经落库**的最小对象集合，供调用方记录，不得为空数组。
 */
export class AggregateCommitUnknown extends Error {
  constructor(
    readonly phase: 'metadata' | 'metrics',
    readonly unknownTargets: string[],
  ) {
    super(`commit_unknown:${phase}`);
    this.name = 'AggregateCommitUnknown';
  }
}

/** P2024 在取连接/开事务阶段失败，BEGIN 都没发出：可确认没有提交，不算 unknown。 */
function isPreCommitFailure(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'P2024';
}

/** COMMIT 答复未知时要记录的对象；永不为空数组。 */
function unknownTargetsOf(dates: Iterable<string>, fallback: string): string[] {
  const targets = new Set<string>();
  for (const date of dates) targets.add(date);
  if (targets.size === 0) targets.add(fallback);
  return [...targets];
}

/** 事务等待连接的上限；与执行时间合计不得超过本轮剩余预算。 */
const AGGREGATE_TX_MAX_WAIT_MS = 2_000;
/** 剩余预算低于此值就不再开启聚合事务。 */
const AGGREGATE_MIN_TX_MS = 250;

/** 事务内提交前的回调：与聚合整组写入同事务，任一失败整组回滚。 */
export type AggregateCommitHook = (
  tx: Prisma.TransactionClient,
  summary: {
    writtenDays: number;
    dataThrough: string | null;
    sourceThrough: string | null;
    /** 同一事务内已提交的无身份日数（未接日轮时为 0）。 */
    dailyCommitted: number;
  },
) => Promise<void>;

export type AggregateDb = Pick<PrismaClient, '$transaction'> & {
  $queryRaw: PrismaClient['$queryRaw'];
  $executeRaw: PrismaClient['$executeRaw'];
};

export type AggregateDayResult = {
  siteDate: string;
  /** 本轮是否真的写库。跳过时为 false。 */
  written: boolean;
  eventCount: number;
  sourceMaxReceivedAt: string | null;
  /** 被跳过的原因；written=true 时为 null。 */
  skippedReason: 'out_of_coverage' | null;
};

export type AggregateRunResult = {
  status: 'ok' | 'failed';
  cutoff: string;
  coverage: CoverageState;
  earliestRecomputableDate: string;
  days: AggregateDayResult[];
  /** 重算起点早于完整原始覆盖而被跳过的连续区间；无则为 null。 */
  skippedRange: { from: string; to: string; dayCount: number } | null;
  errorCode: string | null;
  /** 同一事务内跑过的无身份日轮结果（未接日轮时为 null）。 */
  daily?: DailyAggregateRoundResult | null;
  /**
   * 日轮的覆盖/bootstrap 元数据落点：`metadata` 是**主事务之前**已提交的独立 CAS 结果
   * （验收 6），`metadataDays`/`closureMeta` 保留本轮 plan 的清单；`closureMeta` 中未出现在
   * `metadata` 里的日，是主事务内随闭包一并提交的（不可提前发现）。
   */
  dailyMeta?: {
    metadataDays: Array<{ date: string; action: 'coverage' | 'bootstrap' }>;
    closureMeta: string[];
  } | null;
};

type DayArgs = {
  siteDate: string;
  siteTimezone: string;
  cutoff: Date;
  timezoneRevision: number;
  now: Date;
  /** 只统计 occurredAt ≤ 该时刻的事实；调度作业传业务时钟，未到时间的未来事件不提前计入。 */
  notAfter?: Date;
};

/**
 * 与 registry.isBudgetTimeoutError 同一判定（P2028 事务超时、57014 语句超时、55P03 锁等待超时）。
 * 本文件不能反向 import registry：registry 已 import 这里，会成环。
 */
function isBudgetFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === 'P2028') return true;
  const pgCode = (error as { meta?: { code?: unknown } }).meta?.code;
  return pgCode === '57014' || pgCode === '55P03';
}

/**
 * 并发写冲突：Prisma 把 PostgreSQL 的 40001（序列化失败）与 40P01（死锁）映射成 P2034；
 * 原始 SQL 错误也可能直接带 PostgreSQL 的 SQLSTATE。
 */
function isWriteConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === 'P2034') return true;
  const pgCode = (error as { meta?: { code?: unknown } }).meta?.code;
  return pgCode === '40001' || pgCode === '40P01';
}

/** 守卫失败统一成版本冲突：调用方必须终止事务，且不得继续后续批次或删除；预算错误原样保留。 */
function asVersionConflict(error: unknown): unknown {
  if (error instanceof AggregateVersionConflict) return error;
  if (isBudgetFailure(error)) return error;
  return isWriteConflict(error) ? new AggregateVersionConflict('write_conflict') : error;
}

/**
 * 前置校验阶段的错误分类（R5）：generation 读取与 settings 代次守卫同属“写前能否确认本轮权限”。
 * 只有这段里的未知错误才打 `AggregateGuardFailure` 标记；校验通过后的业务聚合错误不受影响。
 * 已带标记的错误原样透传，避免重复包装；deadline/预算/版本冲突保持原分类。
 */
function asPreflightStageError(error: unknown): unknown {
  if (error instanceof AggregateGuardFailure) return error;
  if (error instanceof AggregateDeadlineExceeded) return error;
  if (error instanceof AggregateVersionConflict) return error;
  if (isBudgetFailure(error)) return error;
  if (isWriteConflict(error)) return new AggregateVersionConflict('write_conflict');
  return new AggregateGuardFailure(error);
}

function asJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function requireCurrentRevision(value: unknown, expectedRevision: number): void {
  const parsed = StoredTimezoneRevisionSchema.safeParse(asJson(value));
  // 旧代次与损坏值都视为冲突：不能拿读不出/对不上的设置继续写。
  if (!parsed.success || parsed.data.timezoneRevision !== expectedRevision) {
    throw new AggregateVersionConflict('stale_timezone_revision');
  }
}

/**
 * D4：写事务内的时区代次守卫。每个会删除或聚合写入的事务在写入前原子复核当前 revision。
 *
 * 锁序保持 JobState → SiteSetting（调用方已先锁租约行）。这里**不是**「LOCK TABLE + 普通 SELECT」：
 * - 先拿表级 SHARE ROW EXCLUSIVE：缺行时行锁锁不住任何元组，表级锁与并发插入/更新冲突，
 *   核对与写出才能串行；
 * - 已有行 `SELECT ... FOR UPDATE`：RepeatableRead 旧快照里该行被并发更新后，PostgreSQL 抛
 *   40001 序列化失败（不会刷新快照返回新值）；本函数把它归一为 AggregateVersionConflict，
 *   事务必须回滚，不能继续下一批；
 * - 缺行沿用已有的并发安全初始化：`INSERT ... ON CONFLICT DO UPDATE SET value = 现值 RETURNING`，
 *   让并发插入的另一方读到已提交值并比较，而不是各写初始值。
 *
 * 锁等待/语句超时（55P03/57014）属于预算错误，原样抛出，不能归一成冲突或普通失败。
 */
export async function assertCurrentTimezoneRevision(
  tx: Prisma.TransactionClient,
  expectedRevision: number,
  now: Date,
): Promise<void> {
  try {
    await tx.$executeRaw`LOCK TABLE "SiteSetting" IN SHARE ROW EXCLUSIVE MODE`;
    const rows = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY} FOR UPDATE
    `;
    if (rows.length > 0) {
      requireCurrentRevision(rows[0]?.value, expectedRevision);
      return;
    }
    const initial = {
      version: 0,
      timezone: 'UTC',
      timezoneRevision: INITIAL_TIMEZONE_REVISION,
      changedAt: now.toISOString(),
      updatedBy: null,
    };
    // RR 旧快照看不到已插入的行；唯一冲突的写会让 PostgreSQL 拒绝整笔旧事务（40001），
    // 由下面的 catch 统一归一为版本冲突。
    const initialized = await tx.$queryRaw<{ value: unknown }[]>`
      INSERT INTO "SiteSetting" ("key", "value")
      VALUES (${ANALYTICS_SETTINGS_KEY}, ${JSON.stringify(initial)}::jsonb)
      ON CONFLICT ("key") DO UPDATE SET "value" = "SiteSetting"."value"
      RETURNING "value"
    `;
    requireCurrentRevision(initialized[0]?.value, expectedRevision);
  } catch (error) {
    if (isBudgetFailure(error)) throw error;
    if (error instanceof AggregateVersionConflict) throw error;
    if (isWriteConflict(error)) throw new AggregateVersionConflict('write_conflict');
    // 未能完成 revision 核对：打上阶段标记，让上层按「守卫失败」终止，
    // 而不是落进普通聚合失败 -> gap -> 继续删除。
    throw new AggregateGuardFailure(error);
  }
}

/**
 * 在一个**已开启**的 RepeatableRead 事务 `tx` 上处理一天的全部写入。
 * 不再自己 `$transaction`：调用方负责把整组目标日放进同一事务，实现整组原子替换。
 *
 * 步骤：按 cutoff 读事件 → DELETE 该日汇总 → 整组 INSERT → 带 WHERE 守卫 upsert watermark。
 * watermark 受影响行数为 0（旧代次/旧 watermark 试图覆盖）时抛错，让整组事务回滚。
 */
async function writeOneDayInTx(
  tx: Prisma.TransactionClient,
  args: DayArgs,
): Promise<AggregateDayResult> {
  const { siteDate, cutoff, timezoneRevision, now } = args;
  const bounds = siteDayUtcBounds(siteDate, args.siteTimezone);

  // 真读已存版本，旧时区代次不得写入（E-83）。
  const storedRevisionRows = await tx.$queryRaw<{ timezoneRevision: number }[]>`
    SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${siteDate}
  `;
  const storedRevision = storedRevisionRows[0] ? Number(storedRevisionRows[0].timezoneRevision) : null;
  if (storedRevision !== null && storedRevision > timezoneRevision) {
    throw new AggregateVersionConflict('stale_timezone_revision');
  }

  const events: RollupSourceEvent[] = await loadEventsAtSnapshot(tx, bounds, cutoff, {
    ...(args.notAfter ? { notAfter: args.notAfter } : {}),
  });
  const aggregated = aggregateSiteDay(events, bounds);

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
  const affected = await upsertWatermarkGuarded(tx, {
    siteDate: bounds.localDate,
    timezoneRevision,
    completedAt: now,
    eventCount: aggregated.eventCount,
    sourceMaxReceivedAt: sourceMax,
    now,
  });
  if (affected !== 1) throw new AggregateVersionConflict('watermark_regression');

  return {
    siteDate,
    written: true,
    eventCount: aggregated.eventCount,
    sourceMaxReceivedAt: sourceMax ? sourceMax.toISOString() : null,
    skippedReason: null,
  };
}

/**
 * 有预算的单日聚合：保留清理在删除前对「仍可整日重算」的到期日做一次 preflight，
 * 生产整组多日仍走 `runAggregateOnce`。
 *
 * 传入 `deadlineAt` 时按整轮剩余预算派生 `maxWaitMs/timeoutMs` 并交给
 * `runInRepeatableReadSnapshot`（等连接 + 执行不超过剩余预算），开事务前、
 * 写入前、写入后各查一次截止；到期即抛，Prisma 整笔回滚。
 * 不传时保持既有单日验证默认（15s/5s）。`occurredNotAfter` 与调度作业同一口径：
 * 只统计 `occurredAt <= 该时刻` 的事实，未来事件不提前计入。
 */
export async function aggregateOneDayInSnapshot(deps: {
  db: AggregateDb;
  siteDate: string;
  siteTimezone: string;
  cutoff: Date;
  timezoneRevision: number;
  generation: number;
  now: Date;
  /** 可选；生产 retention 必须传，按它派生事务预算。 */
  deadlineAt?: Date;
  /** 只统计 occurredAt <= 该时刻的事实；生产传业务 now。 */
  occurredNotAfter?: Date;
  /**
   * 写前时区代次守卫（D4）。保留清理的单日 preflight 传 true；
   * 共享聚合作业不传：它在同一事务结束前的 commit 钩子里已用租约结算的 FOR UPDATE
   * 核对 revision 并让整笔回滚，属等价原子守卫。
   */
  assertTimezoneRevision?: boolean;
}): Promise<AggregateDayResult> {
  const { db, generation } = deps;
  const deadlineMs = deps.deadlineAt?.getTime();
  const deadlineReached = () => deadlineMs !== undefined && Date.now() >= deadlineMs;

  const txOptions: { maxWaitMs?: number; timeoutMs?: number } = {};
  if (deadlineMs !== undefined) {
    const remaining = deadlineMs - Date.now();
    const maxWaitMs = Math.min(AGGREGATE_TX_MAX_WAIT_MS, Math.floor(remaining / 2));
    const timeoutMs = Math.floor(remaining - maxWaitMs);
    if (remaining < AGGREGATE_MIN_TX_MS || maxWaitMs < 1 || timeoutMs < AGGREGATE_MIN_TX_MS) {
      throw new AggregateDeadlineExceeded();
    }
    txOptions.maxWaitMs = maxWaitMs;
    txOptions.timeoutMs = timeoutMs;
  }
  if (deadlineReached()) throw new AggregateDeadlineExceeded();

  let enteredTransaction = false;
  try {
    return await runInRepeatableReadSnapshot(db, async (tx) => {
      enteredTransaction = true;
      // 写前前置：generation 与 settings 代次都必须能确认。这一段的任何未知错误都按守卫失败终止，
      // 不能落进“校验通过但业务聚合失败”的 gap 分支。
      try {
        if (deadlineReached()) throw new AggregateDeadlineExceeded();
        const lockedGeneration = await readLockedGeneration(tx);
        if (lockedGeneration !== null && lockedGeneration > generation) {
          throw new AggregateVersionConflict('stale_generation');
        }
        if (deps.assertTimezoneRevision) {
          await assertCurrentTimezoneRevision(tx, deps.timezoneRevision, deps.now);
        }
        if (deadlineReached()) throw new AggregateDeadlineExceeded();
      } catch (error) {
        throw asPreflightStageError(error);
      }
      const day = await writeOneDayInTx(tx, {
        siteDate: deps.siteDate,
        siteTimezone: deps.siteTimezone,
        cutoff: deps.cutoff,
        timezoneRevision: deps.timezoneRevision,
        now: deps.now,
        ...(deps.occurredNotAfter ? { notAfter: deps.occurredNotAfter } : {}),
      });
      // 写入完成但已到期：抛出让整笔回滚，不把半成品当成功提交。
      if (deadlineReached()) throw new AggregateDeadlineExceeded();
      return day;
    }, txOptions);
  } catch (error) {
    // 事务都没能开成：前置校验同样无法执行，按守卫阶段处理（预算错误原样保留）。
    if (!enteredTransaction) throw asPreflightStageError(error);
    // 旧快照下的并发写冲突（40001/P2034）必须当版本冲突上抛：调用方不能把它降级成普通失败后继续删除。
    throw asVersionConflict(error);
  }
}

/**
 * 整轮聚合：**一条** RepeatableRead 事务覆盖全部目标日。
 *
 * 事务开头做一次行锁 + generation 校验；随后对每个目标日用同一个 `tx`
 * 顺序执行 DELETE/INSERT/watermark。任一天失败或版本冲突 → 异常抛到事务外，
 * 整组回滚，一天都不写，上一轮完整结果保留（E-81 / 09 节 `:71`）。
 * 超范围的日不进事务，只在结果里标记 out_of_coverage。
 */
export async function runAggregateOnce(deps: {
  db: AggregateDb;
  now: Date;
  siteTimezone: string;
  currentDate: string;
  timezoneRevision: number;
  generation: number;
  /** 整轮预算的截止时刻；到期后不再开始新一天、也不提交，事务整笔回滚。 */
  deadlineAt?: Date;
  /** 只统计 occurredAt ≤ 该时刻的事实；调度作业传业务 now，保证未来事件到时间前不计入。 */
  occurredNotAfter?: Date;
  /** 防御性上限，单位是站点自然日（不是事件数）；超出即拒绝且不写库。 */
  maxBatchDays?: number;
  /** 时区切换后的重算起点（UTC 瞬时）；调用方已排除 absent/corrupt/stale/future。 */
  rebuildFrom?: string;
  /** 与整组聚合同一事务的提交钩子；抛错则整组回滚（用于原子完成作业租约）。 */
  commit?: AggregateCommitHook;
  /**
   * 写前时区代次守卫（D4）。保留清理的删后近期聚合传 true；
   * 共享聚合作业不传：它的 commit 钩子在同一个事务里调用租约结算（FOR UPDATE）核对 revision，
   * 不符即整组回滚，属等价原子守卫。
   */
  assertTimezoneRevision?: boolean;
  /**
   * 同一轮、同一 RR 事务内再跑一次无身份日聚合（M5-T12）。
   *
   * 日指标/state 与旧 rollup/水位在**同一事务**提交；任一日失败或 guard/budget 抛出即整笔回滚。
   * 目标站点日与旧链取并集后不得超过 `maxDays`（默认 500），共享同一个 `deadlineAt`。
   */
  daily?: {
    baseDates: readonly string[];
    maxDays?: number;
    notAfter?: Date;
    rawCutoff?: Date;
    leaseOwner: string;
    resolveProductSlugFromPath?: (normalizedPath: string, locale: string) => string | null;
  };
}): Promise<AggregateRunResult> {
  const deadlineMs = deps.deadlineAt?.getTime();
  const deadlineReached = () => deadlineMs !== undefined && Date.now() >= deadlineMs;
  if (deadlineReached()) throw new AggregateDeadlineExceeded();

  const plan: SnapshotPlan = planSnapshot({
    now: deps.now,
    siteTimezone: deps.siteTimezone,
    currentDate: deps.currentDate,
    ...(deps.rebuildFrom !== undefined ? { rebuildFrom: deps.rebuildFrom } : {}),
  });
  if (deps.maxBatchDays !== undefined && plan.siteDates.length > deps.maxBatchDays) {
    throw new AggregateBatchExceeded(deps.maxBatchDays);
  }

  // 事务预算：maxWait（等连接）与 timeout（执行）之和不超过**此刻**剩余预算。
  // 元数据阶段在前，会消耗时间，所以这里只在阶段之后再算一次；剩余不足时不开启事务，
  // 不用最小 timeout 反向扩大预算。
  let txOptions: { maxWaitMs?: number; timeoutMs?: number } = {};

  let days: AggregateDayResult[] = [];
  const dailyCapture: { value: DailyInTxResult | null } = { value: null };
  // 验收 6：覆盖/bootstrap 的独立 CAS 元数据事务排在主 RR **之前**。
  // 主 RR 已持 JobState 行锁，内插独立事务会自锁；`deps.commit` 之后租约已释放，写就不再受守卫。
  // 预算耗尽时本阶段直接跳过，不开任何 CAS/终态事务。
  let metadataHandled = new Set<string>();
  if (deps.daily) {
    const floor = scanFloorLocalDate(deps.currentDate);
    const phase = await writeDailyMetadataPhase(deps.db, {
      now: deps.now,
      cutoff: plan.cutoff,
      notAfter: deps.daily.notAfter ?? deps.now,
      timezone: deps.siteTimezone,
      revision: deps.timezoneRevision,
      floor,
      today: deps.currentDate,
      baseDates: new Set(deps.daily.baseDates.filter((date) => date >= floor)),
      generation: deps.generation,
      leaseOwner: deps.daily.leaseOwner,
      ...(deps.deadlineAt !== undefined ? { deadlineAt: deps.deadlineAt } : {}),
    });
    metadataHandled = phase.handled;
  }
  // 元数据阶段已经消耗的预算必须从主事务扣除：同一绝对 deadline 下重算 maxWait+timeout，
  // 不重置 55s，也不让主事务拿到阶段之前的旧配额。预算已耗尽就不开主事务。
  if (deadlineMs !== undefined) {
    const remaining = deadlineMs - Date.now();
    if (remaining < AGGREGATE_MIN_TX_MS) throw new AggregateDeadlineExceeded();
    const maxWaitMs = Math.min(AGGREGATE_TX_MAX_WAIT_MS, Math.floor(remaining / 2));
    const timeoutMs = Math.floor(remaining - maxWaitMs);
    if (maxWaitMs < 1 || timeoutMs < AGGREGATE_MIN_TX_MS) throw new AggregateDeadlineExceeded();
    txOptions = { maxWaitMs, timeoutMs };
  }

  // 整组事务：任一天失败或版本冲突都会把异常抛到这里，Prisma 整笔回滚，一天都不写。
  // 不 catch 成「部分成功」——09 节 `:71` 禁止留下部分天新、部分天旧的半成品。
  const runMain = async (tx: Prisma.TransactionClient): Promise<AggregateDayResult[]> => {
    // 整组只做一次行锁与代次校验；写前前置的未知错误按守卫失败终止，不混进业务聚合失败。
      try {
        const lockedGeneration = await readLockedGeneration(tx);
        if (lockedGeneration !== null && lockedGeneration > deps.generation) {
          throw new AggregateVersionConflict('stale_generation');
        }
        if (deps.assertTimezoneRevision) {
          await assertCurrentTimezoneRevision(tx, deps.timezoneRevision, deps.now);
        }
      } catch (error) {
        throw asPreflightStageError(error);
      }
      const written: AggregateDayResult[] = [];
      for (const siteDate of plan.siteDates) {
        if (deadlineReached()) throw new AggregateDeadlineExceeded();
        written.push(await writeOneDayInTx(tx, {
          siteDate,
          siteTimezone: deps.siteTimezone,
          cutoff: plan.cutoff,
          timezoneRevision: deps.timezoneRevision,
          now: deps.now,
          ...(deps.occurredNotAfter ? { notAfter: deps.occurredNotAfter } : {}),
        }));
      }
      if (deps.daily) {
        const daily = deps.daily;
        const floor = scanFloorLocalDate(deps.currentDate);
        dailyCapture.value = await runDailyInTx(tx, {
          now: deps.now,
          cutoff: plan.cutoff,
          notAfter: daily.notAfter ?? deps.now,
          rawCutoff: daily.rawCutoff ?? new Date(deps.now.getTime() - RAW_EVENT_RETENTION_MS),
          timezone: deps.siteTimezone,
          revision: deps.timezoneRevision,
          floor,
          today: deps.currentDate,
          maxDays: daily.maxDays ?? DAILY_AGGREGATE_MAX_DAYS,
          deadlineReached,
          generation: deps.generation,
          leaseOwner: daily.leaseOwner,
          baseDates: new Set(daily.baseDates.filter((date) => date >= floor)),
          reservedDays: new Set(plan.siteDates),
          metadataHandled,
          resolveProduct: daily.resolveProductSlugFromPath ?? defaultProductSlugFromPath,
        });
      }
      if (deps.commit) {
        let dataThrough: string | null = null;
        let sourceThrough: string | null = null;
        for (const day of written) {
          const end = siteDayUtcBounds(day.siteDate, deps.siteTimezone).endUtc;
          if (dataThrough === null || end > dataThrough) dataThrough = end;
          if (day.sourceMaxReceivedAt && (sourceThrough === null || day.sourceMaxReceivedAt > sourceThrough)) {
            sourceThrough = day.sourceMaxReceivedAt;
          }
        }
        if (deadlineReached()) throw new AggregateDeadlineExceeded();
        await deps.commit(tx, {
          writtenDays: written.length,
          dataThrough,
          sourceThrough,
          dailyCommitted: dailyCapture.value?.result.committed.length ?? 0,
        });
      }
      return written;
  };

  // 按**执行位置**判别，不看错误码：回调已进入后的任何非回调包装错误都是未知提交。
  let mainStarted = false;
  try {
    days = await runInRepeatableReadSnapshot(deps.db, async (tx) => {
      mainStarted = true;
      try {
        return await runMain(tx);
      } catch (error) {
        throw new AggregateCallbackFailure(error);
      }
    }, txOptions);
  } catch (error) {
    if (error instanceof AggregateCallbackFailure) {
      // 回调内失败＝Prisma 必回滚：旧快照下的并发写冲突仍按版本冲突上抛，不能降级成普通失败。
      throw asVersionConflict(error.original);
    }
    // 回调尚未进入（BEGIN 前失败，含预算/P2024/连接问题）：确认没有提交。
    if (!mainStarted) throw asVersionConflict(error);
    // COMMIT 答复未知（B7）：不得声称新旧指标或 JobState 必回滚，也不写补偿 gap/假 FAILED。
    throw new AggregateCommitUnknown(
      'metrics',
      unknownTargetsOf([...plan.siteDates, ...(deps.daily?.baseDates ?? [])], 'job_state'),
    );
  }

  for (const siteDate of plan.skippedDates) {
    // 超范围：不写库、不用残片替换旧完整值、不填 0（09 节 `:72`）。
    days.push({ siteDate, written: false, eventCount: 0, sourceMaxReceivedAt: null, skippedReason: 'out_of_coverage' });
  }

  return {
    status: 'ok',
    cutoff: plan.cutoff.toISOString(),
    coverage: plan.coverage,
    earliestRecomputableDate: plan.earliestRecomputableDate,
    days,
    skippedRange: plan.skippedRange,
    errorCode: null,
    daily: dailyCapture.value?.result ?? null,
    dailyMeta: dailyCapture.value === null
      ? null
      : {
          metadataDays: dailyCapture.value.metadataDays,
          closureMeta: dailyCapture.value.closureMeta,
        },
  };
}

export type { SiteDayBounds };

/* ------------------------------------------------------------------------- *
 * M5-T12 无身份日聚合（AnalyticsDaily / AnalyticsAggregateDayState / AnalyticsDayChange）
 *
 * 语义取自 r5r3 设计 §4–§10 与模型 `plan` / `recompute_day` / `commit` / `run_round`：
 * - plan：扫描域 = 当前 revision、`[今日−13自然月−2天, 今日)`；种子 = base window ∪
 *   live marker 映射日（±1）∪ 域内 day-state；marker 前进 / 可重试 gap / defer 到期才算脏。
 * - recompute：Q4 跨日倒置 guard → Q1 → Q3 → 计算行 → 未配对终态做 Q2 闭包 / Q5 可见倒置 /
 *   `late_unattributable` gap；defer = 最早未到时间的事实。
 * - commit：整组一个 RepeatableRead 事务，逐日 DELETE+INSERT 当前 revision 行并 CAS 写 state；
 *   任一 day 失败或 CAS 0 行整组回滚。guard/budget 先整体回滚，再用**独立** CAS 事务写 gap。
 * - 覆盖/bootstrap 是**主事务之前**的独立有界 CAS 元数据事务（验收 6）：消费 marker 置
 *   `raw_partial`/`not_backfilled`、保留旧指标行、不读原始事件；不随整组回滚。
 * ------------------------------------------------------------------------- */

/** 单轮目标日上限（站点日批次，不是事件数）。 */
export const DAILY_AGGREGATE_MAX_DAYS = 500;

/** 覆盖/bootstrap 元数据单轮上限：与目标日上限同口径。 */
const DAILY_METADATA_MAX_ROWS = 500;

export type DailyAggregateGapWrite = {
  localDate: string;
  gapKind: string;
  write: 'written' | 'cas_failed' | 'write_failed';
};

export type DailyAggregateMetadataWrite = {
  localDate: string;
  action: 'coverage' | 'bootstrap';
  result: 'inserted' | 'updated' | 'conflict_noop' | 'cas_failed';
};

/**
 * plan 阶段读到的 day-state 期望值（markers + updatedAt + defer）。
 *
 * 四类 state 写者（commit/gap/coverage/bootstrap）一律用**自己 plan 快照里的**期望值做 CAS，
 * 写前不再读当前行：读回再写等于「以最新值当期望」，会把并发提交的成功日降级成 gap/raw_partial。
 */
export type DailyStateExpectation = {
  markers: Record<string, string>;
  updatedAt: Date | null;
  deferUntil: Date | null;
};

/** `null`/缺行 → 「当时确认无该行」：expectedUpdatedAt=null，CAS 走插入分支。 */
function expectationOf(row: DayStateRow | null | undefined): DailyStateExpectation {
  return {
    markers: row?.markerVersions ?? {},
    updatedAt: row?.updatedAt ?? null,
    deferUntil: row?.deferUntil ?? null,
  };
}

/**
 * 候选日分账（纯函数）：base/脏日/闭包按「能否重算」分到指标目标日或覆盖元数据日。
 *
 * 同一个函数同时供「主事务前的独立元数据阶段」与「主事务内的指标 plan」使用，
 * 两处必须得到相同分账，否则元数据阶段会替主事务消费掉本该重算的 marker。
 */
export function splitDailyCandidates(args: {
  candidates: Iterable<string>;
  baseDates: ReadonlySet<string>;
  states: ReadonlyMap<string, DayStateRow>;
  live: ReadonlyMap<string, string>;
  siteRows: ReadonlySet<string>;
  timezone: string;
  earliestRecomputable: string;
  /** 本轮 cutoff：defer 到期判定与扫描一致，不随本轮推进的时钟改变。 */
  cutoff: Date;
}): { targets: string[]; coverageDays: string[]; bootstrapDays: string[] } {
  const targets: string[] = [];
  const coverageDays: string[] = [];
  const bootstrapDays: string[] = [];
  for (const date of [...args.candidates].sort()) {
    const bounds = siteDayUtcBounds(date, args.timezone);
    const mapped = utcDatesCovered(bounds);
    const state = args.states.get(date) ?? null;
    const recomputable = Date.parse(bounds.startUtc) >= Date.parse(args.earliestRecomputable);
    if (args.baseDates.has(date)) {
      if (recomputable) targets.push(date);
      else coverageDays.push(date);
      continue;
    }
    if (state === null) {
      if (args.siteRows.has(date)) continue;
      if (mapped.some((utcDate) => bigintOf(args.live.get(utcDate)) > 0n)) bootstrapDays.push(date);
      continue;
    }
    const markerAhead = mapped.some(
      (utcDate) => bigintOf(args.live.get(utcDate)) > bigintOf(state.markerVersions[utcDate]),
    );
    const retryGap = state.gapKind !== null && RETRY_GAPS.has(state.gapKind);
    const deferredDue = state.deferUntil !== null
      && args.cutoff.getTime() >= state.deferUntil.getTime()
      && (state.gapKind === null || RETRY_GAPS.has(state.gapKind));
    if (!markerAhead && !retryGap && !deferredDue) continue;
    if (recomputable) targets.push(date);
    else coverageDays.push(date);
  }
  return { targets, coverageDays, bootstrapDays };
}

/** COMMIT 答复未知时保留的最小对象集合与阶段；只有 `status === ''unknown''` 才会出现。 */
export type DailyCommitUnknownInfo = {
  phase: 'metadata' | 'metrics';
  /** 可能已落库的站点日（永不为空数组）。 */
  targets: string[];
};

export type DailyAggregateRoundResult = {
  /**
   * `partial`：闭包日的 coverage 元数据已独立落盘、指标整笔回滚（下一轮补齐）。
   * `unknown`：COMMIT 答复未知——既不能声称提交，也不能声称回滚。
   */
  status: 'ok' | 'guard' | 'budget' | 'partial' | 'failed' | 'unknown';
  cutoff: string;
  /** 本轮入队的目标日（含闭包并入日）。 */
  targets: string[];
  /**
   * 真正提交的日。`status===''unknown''` 时为 `null`：不允许用 `[]` 冒充“确认没写”，
   * 消费者必须先判空再取 `length`。
   */
  committed: string[] | null;
  /** 非 null 当且仅当 `status===''unknown''`。 */
  commitUnknown: DailyCommitUnknownInfo | null;
  /** 每个提交日的行数与 gap 分类（site 行 1 + 产品行）。 */
  days: Array<{ localDate: string; rows: number; gapKind: string | null }>;
  gaps: DailyAggregateGapWrite[];
  metadata: DailyAggregateMetadataWrite[];
  guard: { localDate: string; kind: 'day_guard' | 'filtered_start_inversion' } | null;
  budget: { localDate: string; reason: 'max_days_initial' | 'max_days' | 'deadline'; queued: number } | null;
  errorCode: string | null;
};

type DailyDayPlan = {
  localDate: string;
  bounds: SiteDayBounds;
  markers: Record<string, string>;
  site: DailyMetrics;
  products: Map<string, DailyMetrics>;
  gapKind: string | null;
  deferUntil: Date | null;
  /** 提交时用于合并「旧 defer（仍晚于 now 才保留）」；来自事务内读到的 day-state。 */
  previousDeferUntil: Date | null;
  closure: string[];
  expectedMarkers: Record<string, string>;
  expectedUpdatedAt: Date | null;
};

type DailyHalt =
  | { kind: 'guard'; localDate: string; guardKind: 'day_guard' | 'filtered_start_inversion' }
  | { kind: 'budget'; localDate: string; reason: 'max_days_initial' | 'max_days' | 'deadline'; queued: number }
  /** 闭包才发现不可重算日：整体回滚，用独立 CAS 事务补 coverage 元数据后诚实 PARTIAL。 */
  | { kind: 'coverage'; localDate: string; days: string[] };

/** 内部中止信号：整组事务回滚后由调用方用独立 meta 事务写 gap。 */
export class DailyRoundHalt extends Error {
  constructor(
    readonly halt: DailyHalt,
    /**
     * plan 阶段读到的该日 state 期望值；回滚后写 gap/元数据只按它做 CAS，
     * 不重读当前行（否则会把并发提交的成功日降级成 gap）。`null`＝当时确认无该行。
     */
    readonly planExpected: DailyStateExpectation | null = null,
    /** `kind:'coverage'` 时：闭包日的逐日期望值（回滚后独立 CAS 用）。 */
    readonly coveragePending: Array<{ date: string; expected: DailyStateExpectation }> = [],
  ) {
    super(`daily_aggregate_halt:${halt.kind}`);
    this.name = 'DailyRoundHalt';
  }
}

/** 默认产品路径映射：`/<locale>/products/<seg>`，`seg` 是目录内部 key 时直接采用。 */
export function defaultProductSlugFromPath(normalizedPath: string, locale: string): string | null {
  const parts = normalizedPath.split('/').filter((part) => part !== '');
  if (parts.length !== 3) return null;
  if (parts[0] !== locale || parts[1] !== 'products') return null;
  const segment = parts[2];
  return isListedCatalogKey(segment) ? segment : null;
}

function bigintOf(value: string | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return 0n;
  }
}

function minDate(values: Array<Date | null>): Date | null {
  let min: Date | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (min === null || value.getTime() < min.getTime()) min = value;
  }
  return min;
}

/**
 * 日聚合的提交点守卫（不可省略）：行锁 `JobState` 真读 generation，再原子复核时区代次。
 *
 * 供「独立日轮事务」与「作业内同一 RR 事务（由 runAggregateOnce 在末尾 repo.complete 再核一次）」
 * 共用；租约过期判断不在这里用轮首 now——那由调用方在提交点用 repo.renew / repo.complete
 * 的真实时钟完成（见 ADDENDUM-1 §3）。
 */
export async function assertDailyAggregateGuards(
  tx: Prisma.TransactionClient,
  args: {
    timezoneRevision: number;
    now: Date;
    /** 作业租约代次（必填，fail-closed）。 */
    generation: number;
    /** 租约 owner（必填）；与 JobState 行不一致即拒绝。 */
    leaseOwner: string;
  },
): Promise<void> {
  const rows = await tx.$queryRaw<{
    generation: number;
    leaseOwner: string | null;
    lockedUntil: string | null;
  }[]>`
    SELECT "generation", "leaseOwner",
           to_char("lockedUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lockedUntil"
    FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY} FOR UPDATE
  `;
  const row = rows[0];
  // fail-closed：无租约行、代次不符、owner 不符、租约已过期都拒绝；不看传入 now。
  if (row === undefined) throw new AggregateVersionConflict('stale_generation');
  if (Number(row.generation) !== args.generation) throw new AggregateVersionConflict('stale_generation');
  if (row.leaseOwner !== args.leaseOwner) throw new AggregateVersionConflict('stale_generation');
  const lockedUntil = row.lockedUntil === null ? Number.NaN : Date.parse(row.lockedUntil);
  if (!Number.isFinite(lockedUntil) || lockedUntil <= Date.now()) {
    throw new AggregateVersionConflict('stale_generation');
  }
  await assertCurrentTimezoneRevision(tx, args.timezoneRevision, args.now);
}

/**
 * 跑一轮无身份日聚合。调用方负责租约、预算与业务时钟；本函数不读请求、不读环境变量。
 *
 * `notAfter` 默认等于 `now`：只统计已到发生时间的事实，未来事实并入 defer。
 * `rawCutoff` 默认 `now − 30d`：与 raw 保留同一条线，保证 Q1/Q3 只读仍完整的窗口。
 */
/** 同 RR 事务内可复用的日轮参数；由 `runDailyAggregateRound` 或 `runAggregateOnce` 传入。 */
export type DailyInTxArgs = {
  now: Date;
  cutoff: Date;
  notAfter: Date;
  rawCutoff: Date;
  timezone: string;
  revision: number;
  floor: string;
  today: string;
  maxDays: number;
  deadlineReached: () => boolean;
  generation: number;
  leaseOwner: string;
  baseDates: ReadonlySet<string>;
  /** 同一轮旧链已占用的站点日：与日轮目标日取并集后不得超过 maxDays。 */
  reservedDays?: ReadonlySet<string>;
  /** 主事务前独立元数据阶段已写过的覆盖/bootstrap 日：闭包写不得重复 CAS 它们。 */
  metadataHandled?: ReadonlySet<string>;
  resolveProduct: (normalizedPath: string, locale: string) => string | null;
};

/** `runDailyInTx` 只在事务内跑：它永远不知道 COMMIT 结果，因此对外只能返回确认形态。 */
export type DailyInTxRound = DailyAggregateRoundResult & {
  status: 'ok';
  committed: string[];
  commitUnknown: null;
};

export type DailyInTxResult = {
  result: DailyInTxRound;
  /** 本轮 plan 认出的覆盖/bootstrap 日；实际写入由主事务前的独立阶段完成（验收 6）。 */
  metadataDays: Array<{ date: string; action: 'coverage' | 'bootstrap' }>;
  /** 闭包并入但不可重算的 start 日：只能在重算目标日时发现，随本次指标同事务提交。 */
  closureMeta: string[];
};

function emptyDailyResult(cutoff: Date): DailyAggregateRoundResult {
  return {
    status: 'failed',
    cutoff: cutoff.toISOString(),
    targets: [],
    committed: [],
    commitUnknown: null,
    days: [],
    gaps: [],
    metadata: [],
    guard: null,
    budget: null,
    errorCode: null,
  };
}

/**
 * 日轮的事务内主体：守卫 → 同快照 plan → 目标日重算/闭包 → 逐日提交。
 *
 * 不自己开事务、不写 gap、不写元数据：
 * - 与旧 rollup 同事务时由 `runAggregateOnce` 调用，抛 `DailyRoundHalt` 即整笔回滚；
 * - 独立运行时由 `runDailyAggregateRound` 调用，回滚后再用独立 CAS 事务写 gap/元数据。
 */
export async function runDailyInTx(
  tx: Prisma.TransactionClient,
  args: DailyInTxArgs,
): Promise<DailyInTxResult> {
  const { now, cutoff, timezone, revision, floor, today, maxDays } = args;
  const result: DailyInTxRound = { ...emptyDailyResult(cutoff), status: 'ok', committed: [], commitUnknown: null };

  await assertDailyAggregateGuards(tx, {
    timezoneRevision: revision,
    now,
    generation: args.generation,
    leaseOwner: args.leaseOwner,
  });

  // ---- plan（同一快照）----------------------------------------------------
  const states = await readDayStatesInDomain(tx, revision, floor, today);
  const live = await readLiveMarkerVersions(tx);
  const siteRows = await readSiteRowDatesInDomain(tx, revision, floor, today);
  const earliestRecomputable = recomputableFrom(now, timezone);

  const candidates = new Set<string>();
  for (const date of args.baseDates) candidates.add(date);
  for (const utcDate of live.keys()) {
    for (const delta of [-1, 0, 1]) {
      const date = shiftLocalDate(utcDate, delta);
      if (date >= floor && date < today) candidates.add(date);
    }
  }
  for (const date of states.keys()) {
    if (date >= floor && date < today) candidates.add(date);
  }

  const targets: string[] = [];
  const coverageDays: string[] = [];
  const bootstrapDays: string[] = [];
  {
    const split = splitDailyCandidates({
      candidates,
      baseDates: args.baseDates,
      states,
      live,
      siteRows,
      timezone,
      earliestRecomputable,
      cutoff,
    });
    targets.push(...split.targets);
    coverageDays.push(...split.coverageDays);
    bootstrapDays.push(...split.bootstrapDays);
  }

  // union(distinct 站点日) ≤ maxDays：与旧链共享上限，不按两条链各算一次。
  const reserved = args.reservedDays ?? new Set<string>();
  const unionSize = new Set<string>([...reserved, ...targets]).size;
  if (unionSize > maxDays) {
    const halted = targets[0] ?? [...reserved][0] ?? today;
    throw new DailyRoundHalt({
      kind: 'budget',
      localDate: halted,
      reason: 'max_days_initial',
      queued: unionSize,
    }, expectationOf(states.get(halted) ?? null));
  }

  const closureMeta: string[] = [];
  const queue = [...targets];
  const queued = new Set(queue);
  const plans: DailyDayPlan[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const date = queue[index]!;
    if (seen.has(date)) continue;
    seen.add(date);
    if (args.deadlineReached()) {
      throw new DailyRoundHalt(
        { kind: 'budget', localDate: date, reason: 'deadline', queued: queued.size },
        expectationOf(states.get(date) ?? null),
      );
    }
    const plan = await recomputeDailyDay(tx, {
      localDate: date,
      timezone,
      revision,
      cutoff,
      notAfter: args.notAfter,
      rawCutoff: args.rawCutoff,
      floor,
      today,
      live,
      resolveProduct: args.resolveProduct,
    });
    if (plan.kind === 'halt') {
      throw new DailyRoundHalt(plan.halt, expectationOf(states.get(plan.halt.localDate) ?? null));
    }
    const day = plan.plan;
    for (const closureDate of day.closure) {
      if (seen.has(closureDate) || queued.has(closureDate)) continue;
      const closureBounds = siteDayUtcBounds(closureDate, timezone);
      if (Date.parse(closureBounds.startUtc) < Date.parse(earliestRecomputable)) {
        if (!closureMeta.includes(closureDate)) closureMeta.push(closureDate);
        continue;
      }
      if (new Set<string>([...reserved, ...queued, closureDate]).size > maxDays) {
        throw new DailyRoundHalt(
          { kind: 'budget', localDate: date, reason: 'max_days', queued: queued.size },
          expectationOf(states.get(date) ?? null),
        );
      }
      queued.add(closureDate);
      queue.push(closureDate);
    }
    plans.push(day);
  }
  if (args.deadlineReached()) {
    const halted = queue[0] ?? today;
    throw new DailyRoundHalt(
      { kind: 'budget', localDate: halted, reason: 'deadline', queued: queued.size },
      expectationOf(states.get(halted) ?? null),
    );
  }
  for (const day of plans) {
    const rows = await commitDailyDay(tx, { day, now, notAfter: args.notAfter, revision, timezone });
    result.days.push({ localDate: day.localDate, rows, gapKind: day.gapKind });
    result.committed.push(day.localDate);
  }

  result.status = 'ok';
  result.targets = [...queued];
  const metadataDays: Array<{ date: string; action: 'coverage' | 'bootstrap' }> = [
    ...coverageDays.map((date) => ({ date, action: 'coverage' as const })),
    ...bootstrapDays.map((date) => ({ date, action: 'bootstrap' as const })),
  ].slice(0, DAILY_METADATA_MAX_ROWS);
  // 覆盖/bootstrap 已由**主事务之前**的独立 CAS 事务写过（验收 6，见 `writeDailyMetadataPhase`）。
  // 闭包日只有重算目标日时才发现、无法提前到独立事务：这里**不写**，而是整笔回滚，
  // 交给调用方用本次 plan 的原 expected 在剩余预算内做独立 CAS，再诚实 PARTIAL。
  // 下一轮该日已是 raw_partial（`metadataHandled` 覆盖），不会再触发重入。
  const pendingClosure = closureMeta.filter((date) => args.metadataHandled?.has(date) !== true);
  if (pendingClosure.length > 0) {
    const entries = pendingClosure.map((date) => ({
      date,
      expected: expectationOf(states.get(date) ?? null),
    }));
    throw new DailyRoundHalt(
      { kind: 'coverage', localDate: pendingClosure[0]!, days: pendingClosure },
      entries[0]?.expected ?? null,
      entries,
    );
  }
  return { result, metadataDays, closureMeta };
}

/**
 * 独立运行的一轮日聚合：自己开事务，顺序与作业路径一致——
 * 独立 CAS 元数据阶段 → 主 RR（指标）→ 回滚后用独立 CAS 事务写 gap。
 *
 * 与作业同事务的路径（`runAggregateOnce`）不经过这里：它在同一事务里直接调 `runDailyInTx`，
 * 任一 day 失败即整笔回滚（含旧 rollup/水位/backlog/JobState）。
 */
export async function runDailyAggregateRound(deps: {
  db: AggregateDb;
  now: Date;
  siteTimezone: string;
  timezoneRevision: number;
  /** 今日站点本地日；扫描域上界（不含）。 */
  currentDate: string;
  /** base window 的重算日（48h 迟到窗口 + 今日）；缺省为空。 */
  baseDates?: readonly string[];
  maxDays?: number;
  deadlineAt?: Date;
  notAfter?: Date;
  rawCutoff?: Date;
  /** 作业租约代次与 owner（必填，fail-closed）。 */
  generation: number;
  leaseOwner: string;
  resolveProductSlugFromPath?: (normalizedPath: string, locale: string) => string | null;
}): Promise<DailyAggregateRoundResult> {
  const now = deps.now;
  const cutoff = now;
  const notAfter = deps.notAfter ?? now;
  const rawCutoff = deps.rawCutoff ?? new Date(now.getTime() - RAW_EVENT_RETENTION_MS);
  const timezone = deps.siteTimezone;
  const revision = deps.timezoneRevision;
  const maxDays = deps.maxDays ?? DAILY_AGGREGATE_MAX_DAYS;
  const deadlineMs = deps.deadlineAt?.getTime();
  const deadlineReached = () => deadlineMs !== undefined && Date.now() >= deadlineMs;
  const floor = scanFloorLocalDate(deps.currentDate);
  const today = deps.currentDate;
  const resolveProduct = deps.resolveProductSlugFromPath ?? defaultProductSlugFromPath;
  const baseDates = new Set((deps.baseDates ?? []).filter((date) => date >= floor));

  const result = emptyDailyResult(cutoff);
  if (deadlineReached()) {
    result.status = 'budget';
    result.budget = { localDate: today, reason: 'deadline', queued: 0 };
    return result;
  }

  // 阶段顺序与作业路径一致：独立 CAS 元数据 → 主 RR（指标）→ 回滚后独立 gap。
  let metadataHandled = new Set<string>();
  let metadataWrites: DailyAggregateMetadataWrite[] = [];
  try {
    const phase = await writeDailyMetadataPhase(deps.db, {
      now,
      cutoff,
      notAfter,
      timezone,
      revision,
      floor,
      today,
      baseDates,
      generation: deps.generation,
      leaseOwner: deps.leaseOwner,
      ...(deps.deadlineAt !== undefined ? { deadlineAt: deps.deadlineAt } : {}),
    });
    metadataWrites = phase.written;
    metadataHandled = phase.handled;
  } catch (error) {
    // 元数据阶段 COMMIT 答复未知：主指标阶段不得继续；已确认的先前阶段结果仍如实保留。
    if (error instanceof AggregateCommitUnknown) {
      // COMMIT 答复未知：内层已确认的阶段结果如实保留，但提交列表必须是 null，不能冒充 0。
      result.status = 'unknown';
      result.errorCode = 'commit_unknown';
      result.committed = null;
      result.commitUnknown = { phase: error.phase, targets: [...error.unknownTargets] };
      return result;
    }
    const mapped = asVersionConflict(error);
    if (mapped instanceof AggregateDeadlineExceeded) {
      result.status = 'budget';
      result.budget = { localDate: today, reason: 'deadline', queued: 0 };
      return result;
    }
    if (mapped instanceof AggregateVersionConflict) {
      result.status = 'failed';
      result.errorCode = 'version_conflict';
      return result;
    }
    throw mapped;
  }
  result.metadata.push(...metadataWrites);

  try {
    const inTx = await runInRepeatableReadSnapshot(deps.db, async (tx) => {
      try {
        return await runDailyInTx(tx, {
          now,
          cutoff,
          notAfter,
          rawCutoff,
          timezone,
          revision,
          floor,
          today,
          maxDays,
          deadlineReached,
          generation: deps.generation,
          leaseOwner: deps.leaseOwner,
          baseDates,
          metadataHandled,
          resolveProduct,
        });
      } catch (error) {
        throw new AggregateCallbackFailure(error);
      }
    }, txOptionsFor(deadlineMs));
    Object.assign(result, inTx.result);
    result.metadata.push(...metadataWrites);
  } catch (error) {
    // 主事务 COMMIT 答复未知：不得声称指标/旧链/JobState 必回滚，不写补偿 gap。
    const commitUnknown = error instanceof AggregateCommitUnknown
      ? error
      : (error instanceof AggregateCallbackFailure && error.original instanceof AggregateCommitUnknown
        ? error.original
        : null);
    if (commitUnknown !== null) {
      // 主事务 COMMIT 答复未知：不得声称指标/旧链/JobState 必回滚，也不写补偿 gap。
      result.status = 'unknown';
      result.errorCode = 'commit_unknown';
      result.committed = null;
      result.commitUnknown = { phase: commitUnknown.phase, targets: [...commitUnknown.unknownTargets] };
      return result;
    }
    // 回调已经返回、$transaction 才抛：COMMIT 答复未知（与作业路径同一判别）。
    if (!(error instanceof AggregateCallbackFailure)
      && !isPreCommitFailure(error)
      && !isBudgetFailure(error)
      && !(error instanceof AggregateDeadlineExceeded)) {
      result.status = 'unknown';
      result.committed = null;
      result.commitUnknown = {
        phase: 'metrics',
        targets: unknownTargetsOf([...baseDates, ...result.targets], 'job_state'),
      };
      return result;
    }
    const unwrapped = error instanceof AggregateCallbackFailure ? error.original : error;
    const haltError = unwrapped instanceof DailyRoundHalt ? unwrapped : null;
    const halted = haltOf(unwrapped, today, 0);
    if (halted !== null) {
      if (halted.kind === 'coverage') {
        // 闭包日不可重算：指标整笔已回滚，用本次原 expected 在剩余预算内独立 CAS 补 coverage。
        const writes = deadlineReached()
          ? []
          : await writeDailyCoverageMetadata(deps.db, {
              entries: haltError?.coveragePending ?? [],
              timezone,
              revision,
              now,
              cutoff,
              notAfter,
              generation: deps.generation,
              leaseOwner: deps.leaseOwner,
              ...(deps.deadlineAt !== undefined ? { deadlineAt: deps.deadlineAt } : {}),
            });
        result.metadata.push(...writes);
        result.status = 'partial';
        return result;
      }
      const gapKind = halted.kind === 'guard' ? 'clock_inversion' : 'budget';
      // 预算已耗尽时不再为 PARTIAL/gap 开新事务。
      const write = deadlineReached() ? 'write_failed' as const
        : await writeDailyGap(deps.db, {
            halt: halted,
            timezone,
            revision,
            now,
            cutoff,
            notAfter,
            generation: deps.generation,
            leaseOwner: deps.leaseOwner,
            expected: haltError?.planExpected ?? null,
          });
      result.gaps.push({ localDate: halted.localDate, gapKind, write });
      result.status = halted.kind === 'guard' ? 'guard' : 'budget';
      if (halted.kind === 'guard') result.guard = { localDate: halted.localDate, kind: halted.guardKind };
      else result.budget = { localDate: halted.localDate, reason: halted.reason, queued: halted.queued };
    } else {
      const mapped = asVersionConflict(error);
      if (!(mapped instanceof AggregateVersionConflict)) throw mapped;
      result.status = 'failed';
      result.errorCode = 'version_conflict';
    }
  }

  return result;
}

/** 把整组事务里抛出的错误归一成「可写 gap 的中止」或 null。 */
function haltOf(error: unknown, localDate: string, queued: number): DailyHalt | null {
  if (error instanceof DailyRoundHalt) return error.halt;
  if (error instanceof AggregateDeadlineExceeded || isBudgetFailure(error)) {
    return { kind: 'budget', localDate, reason: 'deadline', queued };
  }
  return null;
}

/** 与整组事务同一预算：maxWait 与 timeout 之和不超过剩余时间。 */
function txOptionsFor(deadlineMs: number | undefined): { maxWaitMs?: number; timeoutMs?: number } {
  if (deadlineMs === undefined) return {};
  const remaining = deadlineMs - Date.now();
  const maxWaitMs = Math.min(AGGREGATE_TX_MAX_WAIT_MS, Math.floor(remaining / 2));
  const timeoutMs = Math.floor(remaining - maxWaitMs);
  if (remaining < AGGREGATE_MIN_TX_MS) throw new AggregateDeadlineExceeded();
  return { maxWaitMs: Math.max(1, maxWaitMs), timeoutMs: Math.max(1, timeoutMs) };
}

/**
 * 单日重算（只读）：Q4 guard → Q1 → Q3 → 指标 → 未配对终态的 Q2/Q5/gap。
 * 返回日计划或整体中止信号；本函数不写任何行。
 */
async function recomputeDailyDay(
  tx: Prisma.TransactionClient,
  args: {
    localDate: string;
    timezone: string;
    revision: number;
    cutoff: Date;
    notAfter: Date;
    rawCutoff: Date;
    floor: string;
    today: string;
    live: Map<string, string>;
    resolveProduct: (normalizedPath: string, locale: string) => string | null;
  },
): Promise<{ kind: 'day'; plan: DailyDayPlan } | { kind: 'halt'; halt: DailyHalt }> {
  const bounds = siteDayUtcBounds(args.localDate, args.timezone);
  const readOptions = { cutoff: args.cutoff, eventCutoff: args.rawCutoff };

  const inversion = await probeCrossDayInversion(tx, bounds, readOptions);
  if (inversion !== null) {
    return { kind: 'halt', halt: { kind: 'guard', localDate: args.localDate, guardKind: 'day_guard' } };
  }

  const facts = await loadDailyDayFacts(tx, bounds, readOptions);
  const counted = facts.filter((fact) => fact.occurredAt.getTime() <= args.notAfter.getTime());
  const deferredFacts = facts.filter((fact) => fact.occurredAt.getTime() > args.notAfter.getTime());

  const startKeys = counted
    .filter((fact) => fact.kind === 'model_view_start' && fact.viewId !== null)
    .map((fact) => ({ browserHash: fact.browserHash, viewId: fact.viewId as string }));
  const paired = startKeys.length > 0 ? await loadPairedTerminals(tx, startKeys, readOptions) : [];

  const computed = computeDailyMetrics(counted as AnalyticsFact[], paired as AnalyticsFact[], {
    localDate: args.localDate,
    notAfter: args.notAfter,
    resolveProductSlugFromPath: args.resolveProduct,
  });

  let gapKind: string | null = null;
  const closure: string[] = [];
  for (const terminal of computed.unattributableInDayTerminals) {
    const key = factKey(terminal);
    if (key === null) {
      gapKind = gapKind ?? 'late_unattributable';
      continue;
    }
    const hit = await findEarliestStart(tx, {
      browserHash: terminal.browserHash,
      viewId: terminal.viewId as string,
      ...readOptions,
    });
    if (hit !== null) {
      const startDate = siteLocalDate(hit.occurredAt, args.timezone);
      if (startDate >= args.floor && startDate < args.today) {
        if (!closure.includes(startDate)) closure.push(startDate);
      } else {
        gapKind = gapKind ?? 'late_unattributable';
      }
      continue;
    }
    const filteredStart = await probeFilteredStartInversion(tx, {
      browserHash: terminal.browserHash,
      viewId: terminal.viewId as string,
      ...readOptions,
    });
    if (filteredStart !== null) {
      return { kind: 'halt', halt: { kind: 'guard', localDate: args.localDate, guardKind: 'filtered_start_inversion' } };
    }
    gapKind = gapKind ?? 'late_unattributable';
  }

  const mapped = utcDatesCovered(bounds);
  const markers: Record<string, string> = {};
  for (const utcDate of mapped) markers[utcDate] = liveVersionOf(args.live, utcDate);
  // CAS 的期望值必须来自**本事务内**读到的 state，不能用 plan 阶段的旧快照。
  const state = await readDayState(tx, { localDate: args.localDate, timezoneRevision: args.revision });
  const deferUntil = minDate([
    ...deferredFacts.map((fact) => fact.occurredAt),
    ...paired.filter((terminal) => terminal.occurredAt.getTime() > args.notAfter.getTime()).map((t) => t.occurredAt),
  ]);

  return {
    kind: 'day',
    plan: {
      localDate: args.localDate,
      bounds,
      markers,
      site: computed.site,
      products: computed.products,
      gapKind,
      deferUntil,
      previousDeferUntil: state?.deferUntil ?? null,
      closure,
      expectedMarkers: state?.markerVersions ?? {},
      expectedUpdatedAt: state?.updatedAt ?? null,
    },
  };
}

function liveVersionOf(live: Map<string, string>, utcDate: string): string {
  return live.get(utcDate) ?? '0';
}

/** 单日提交：DELETE+INSERT 当前 revision 行 → CAS 写 state。任一步失败整组回滚。 */
async function commitDailyDay(
  tx: Prisma.TransactionClient,
  args: { day: DailyDayPlan; now: Date; notAfter: Date; revision: number; timezone: string },
): Promise<number> {
  const { day, now, revision, timezone } = args;
  await tx.$executeRaw`
    DELETE FROM "AnalyticsDaily"
    WHERE "localDate" = ${day.localDate} AND "timezoneRevision" = ${revision}
  `;
  const expiresAt = dailyExpiresAt(day.localDate, timezone);
  const rows: DailyMetrics[] = [day.site, ...day.products.values()];
  const values = rows.map((row) => Prisma.sql`(
    ${day.localDate},
    ${revision},
    ${timezone},
    ${row.dimension},
    ${row.visitors},
    ${row.pageViews === null ? Prisma.sql`NULL` : row.pageViews},
    ${row.productViews},
    ${row.modelStarts},
    ${row.modelSuccesses},
    ${row.modelFailures},
    ${row.chatStarts},
    ${row.durationMsSum.toString()}::bigint,
    ${row.loadDurationSamples},
    ${row.sourceThrough === null ? Prisma.sql`NULL` : utc(row.sourceThrough)},
    ${utc(now)},
    ${utc(expiresAt)}
  )`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsDaily" (
      "localDate", "timezoneRevision", "timezone", "dimension", "visitors",
      "pageViews", "productViews", "modelStarts", "modelSuccesses", "modelFailures",
      "chatStarts", "durationMsSum", "loadDurationSamples", "sourceThrough",
      "aggregatedAt", "expiresAt"
    ) VALUES ${Prisma.join(values)}
  `);

  const deferUntil = mergeDeferUntil(day.previousDeferUntil, day.deferUntil, args.notAfter);
  const affected = await casWriteDayState(tx, {
    localDate: day.localDate,
    timezoneRevision: revision,
    timezone,
    markerVersions: day.markers,
    deferUntil,
    gapKind: day.gapKind,
    gapSince: day.gapKind === null ? null : now,
    expectedMarkers: day.expectedMarkers,
    expectedUpdatedAt: day.expectedUpdatedAt,
    now,
  });
  if (affected !== 1) throw new AggregateVersionConflict('write_conflict');
  return rows.length;
}

/**
 * 覆盖/bootstrap 的**前置独立 CAS 元数据阶段**（验收 6「不可重算→独立CAS元数据事务」）。
 *
 * 位置固定在主 RR 事务**之前**：主事务已持 `JobState` 行锁，内插独立事务会自锁；
 * `repo.complete` 之后租约已释放，再写就不再受代次守卫。两个窗口都不可用，所以只能前置。
 *
 * 本阶段只写元数据：消费 marker、置 `raw_partial`/`not_backfilled`，保留旧指标行、
 * 不读原始事件、不改任何指标。期望值一律取自本阶段自己的 plan 快照（不写前重读）。
 */
export async function writeDailyMetadataPhase(
  db: AggregateDb,
  args: {
    now: Date;
    cutoff: Date;
    timezone: string;
    revision: number;
    floor: string;
    today: string;
    baseDates: ReadonlySet<string>;
    generation: number;
    leaseOwner: string;
    /** 本轮计入上界；defer 合并按 `previous > notAfter` 保留。 */
    notAfter: Date;
    deadlineAt?: Date;
  },
): Promise<{
  skipped: boolean;
  written: DailyAggregateMetadataWrite[];
  /** 本阶段成功写过的站点日：主事务的闭包写不得重复 CAS。 */
  handled: Set<string>;
}> {
  const deadlineMs = args.deadlineAt?.getTime();
  const deadlineReached = () => deadlineMs !== undefined && Date.now() >= deadlineMs;
  // 预算耗尽不新开任何 CAS/终态事务。
  if (deadlineReached()) return { skipped: true, written: [], handled: new Set<string>() };

  const planned: string[] = [];
  const runPhase = async (tx: Prisma.TransactionClient): Promise<DailyAggregateMetadataWrite[]> => {
    // 守卫先于任何写：租约仍由本次持有（commit 钩子尚未执行），代次与时区 revision 未变。
    await assertDailyAggregateGuards(tx, {
      timezoneRevision: args.revision,
      now: args.now,
      generation: args.generation,
      leaseOwner: args.leaseOwner,
    });
    const states = await readDayStatesInDomain(tx, args.revision, args.floor, args.today);
    const live = await readLiveMarkerVersions(tx);
    const siteRows = await readSiteRowDatesInDomain(tx, args.revision, args.floor, args.today);
    const earliestRecomputable = recomputableFrom(args.now, args.timezone);
    const candidates = new Set<string>();
    for (const date of args.baseDates) candidates.add(date);
    for (const utcDate of live.keys()) {
      for (const delta of [-1, 0, 1]) {
        const date = shiftLocalDate(utcDate, delta);
        if (date >= args.floor && date < args.today) candidates.add(date);
      }
    }
    for (const date of states.keys()) {
      if (date >= args.floor && date < args.today) candidates.add(date);
    }
    const split = splitDailyCandidates({
      candidates,
      baseDates: args.baseDates,
      states,
      live,
      siteRows,
      timezone: args.timezone,
      earliestRecomputable,
      cutoff: args.cutoff,
    });
    const metadataDays: Array<{ date: string; action: 'coverage' | 'bootstrap' }> = [
      ...split.coverageDays.map((date) => ({ date, action: 'coverage' as const })),
      ...split.bootstrapDays.map((date) => ({ date, action: 'bootstrap' as const })),
    ].slice(0, DAILY_METADATA_MAX_ROWS);

    const out: DailyAggregateMetadataWrite[] = [];
    for (const item of metadataDays) {
      // 阶段内也要有界：剩余预算不足就停在这里，已写的保持已提交（元数据独立于指标）。
      if (deadlineReached()) break;
      planned.push(item.date);
      const result = await writeDailyMetadataInTx(tx, {
        date: item.date,
        action: item.action,
        timezone: args.timezone,
        revision: args.revision,
        now: args.now,
        cutoff: args.cutoff,
        notAfter: args.notAfter,
        expected: expectationOf(states.get(item.date) ?? null),
      });
      out.push({ localDate: item.date, action: item.action, result });
    }
    return out;
  };

  let written: DailyAggregateMetadataWrite[];
  let phaseStarted = false;
  try {
    written = await runInRepeatableReadSnapshot(db, async (tx) => {
      phaseStarted = true;
      try {
        return await runPhase(tx);
      } catch (error) {
        throw new AggregateCallbackFailure(error);
      }
    }, txOptionsFor(deadlineMs));
  } catch (error) {
    if (error instanceof AggregateCallbackFailure) throw error.original;
    // 回调尚未进入（预算/连接/P2024/版本冲突）：确认无提交，不算 unknown。
    if (!phaseStarted) throw error;
    throw new AggregateCommitUnknown('metadata', unknownTargetsOf(planned, 'metadata'));
  }

  // CAS 0 行＝期间有别的写者推进了该行。绝不重读后强写；但要区分「并发成功已保存」与
  // 「仍需重算」：前者是正常 no-op，后者必须让本轮不宣称成功（抛版本冲突，下一轮重新 plan）。
  await resolveCoverageConflicts(db, written, args.revision, args.timezone);

  return {
    skipped: false,
    written,
    handled: new Set(written.filter((item) => item.result !== 'cas_failed').map((item) => item.localDate)),
  };
}

/**
 * 闭包日的 coverage 元数据：主事务回滚后的**独立 CAS 事务**（同样只能在主事务之外调用）。
 * 期望值来自触发回滚那一次的 plan，不重读当前行；CAS 0 行按同一规则分类。
 */
export async function writeDailyCoverageMetadata(
  db: AggregateDb,
  args: {
    entries: Array<{ date: string; expected: DailyStateExpectation }>;
    timezone: string;
    revision: number;
    now: Date;
    cutoff: Date;
    notAfter: Date;
    generation: number;
    leaseOwner: string;
    deadlineAt?: Date;
  },
): Promise<DailyAggregateMetadataWrite[]> {
  const deadlineMs = args.deadlineAt?.getTime();
  const deadlineReached = () => deadlineMs !== undefined && Date.now() >= deadlineMs;
  if (args.entries.length === 0 || deadlineReached()) return [];
  const written = await runInRepeatableReadSnapshot(db, async (tx) => {
    await assertDailyAggregateGuards(tx, {
      timezoneRevision: args.revision,
      now: args.now,
      generation: args.generation,
      leaseOwner: args.leaseOwner,
    });
    const out: DailyAggregateMetadataWrite[] = [];
    for (const entry of args.entries) {
      if (deadlineReached()) break;
      out.push({
        localDate: entry.date,
        action: 'coverage',
        result: await writeDailyMetadataInTx(tx, {
          date: entry.date,
          action: 'coverage',
          timezone: args.timezone,
          revision: args.revision,
          now: args.now,
          cutoff: args.cutoff,
          notAfter: args.notAfter,
          expected: entry.expected,
        }),
      });
    }
    return out;
  }, txOptionsFor(deadlineMs));
  await resolveCoverageConflicts(db, written, args.revision, args.timezone);
  return written;
}

async function resolveCoverageConflicts(
  db: AggregateDb,
  written: DailyAggregateMetadataWrite[],
  revision: number,
  timezone: string,
): Promise<void> {
  const conflicts = written.filter((item) => item.result === 'cas_failed' && item.action === 'coverage');
  if (conflicts.length === 0) return;
  const liveNow = await readLiveMarkerVersions(db);
  const needsRecompute: string[] = [];
  for (const item of conflicts) {
    const row = await readDayState(db, { localDate: item.localDate, timezoneRevision: revision });
    const saved = row !== null && (
      TERMINAL_GAPS.has(row.gapKind ?? '')
      || (row.gapKind === null
        && utcDatesCovered(siteDayUtcBounds(item.localDate, timezone))
          .every((utcDate) => bigintOf(row.markerVersions[utcDate]) >= bigintOf(liveNow.get(utcDate))))
    );
    if (saved) item.result = 'conflict_noop';
    else needsRecompute.push(item.localDate);
  }
  if (needsRecompute.length > 0) throw new AggregateVersionConflict('write_conflict');
}

async function writeDailyMetadataInTx(
  tx: Prisma.TransactionClient,
  args: {
    date: string;
    action: 'coverage' | 'bootstrap';
    timezone: string;
    revision: number;
    now: Date;
    cutoff: Date;
    /** 本轮计入上界；defer 合并的「仍晚于」判定用它，不用墙钟 now。 */
    notAfter: Date;
    /** plan 阶段读到的期望值（必填）；写前不再读当前行。 */
    expected: DailyStateExpectation;
  },
): Promise<'inserted' | 'updated' | 'conflict_noop' | 'cas_failed'> {
  const bounds = siteDayUtcBounds(args.date, args.timezone);
  const markers: Record<string, string> = {};
  const liveRows = await readLiveMarkerVersions(tx);
  for (const utcDate of utcDatesCovered(bounds)) markers[utcDate] = liveVersionOf(liveRows, utcDate);
  const gapKind = args.action === 'coverage' ? 'raw_partial' : 'not_backfilled';

  if (args.action === 'bootstrap') {
    const affected = await insertDayStateIfAbsent(tx, {
      localDate: args.date,
      timezoneRevision: args.revision,
      timezone: args.timezone,
      markerVersions: markers,
      deferUntil: null,
      gapKind,
      gapSince: args.now,
      now: args.now,
    });
    return affected === 1 ? 'inserted' : 'conflict_noop';
  }

  // coverage 不重算该日，因此**保留**已有 future defer：仍按「旧 defer 仅 > now 才保留」，
  // 不能因为拿到了 expected 就写 null 清空。
  const affected = await casWriteDayState(tx, {
    localDate: args.date,
    timezoneRevision: args.revision,
    timezone: args.timezone,
    markerVersions: markers,
    deferUntil: mergeDeferUntil(args.expected.deferUntil, null, args.notAfter),
    gapKind,
    gapSince: args.now,
    expectedMarkers: args.expected.markers,
    expectedUpdatedAt: args.expected.updatedAt,
    now: args.now,
  });
  if (affected !== 1) return 'cas_failed';
  return args.expected.updatedAt === null ? 'inserted' : 'updated';
}

/**
 * guard/budget 的 gap：整组回滚后用**独立 CAS 事务**写，且只按**原 plan expected** 比较。
 *
 * 写前不重读当前行：读回再写＝把并发提交的成功日降级成 gap。CAS 0 行就是 0 行，
 * 不重试、不强写、不假报已落地。
 */
export async function writeDailyGap(
  db: AggregateDb,
  args: {
    halt: DailyHalt;
    timezone: string;
    revision: number;
    now: Date;
    cutoff: Date;
    /** 本轮计入上界；defer 合并按 `previous > notAfter` 保留。 */
    notAfter: Date;
    /** 作业租约代次与 owner（必填，fail-closed）：gap 也是写 state，必须同受守卫。 */
    generation: number;
    leaseOwner: string;
    /** plan 阶段读到的该日期望值；`null`＝当时确认无该行。 */
    expected: DailyStateExpectation | null;
  },
): Promise<'written' | 'cas_failed' | 'write_failed'> {
  const gapKind = args.halt.kind === 'guard' ? 'clock_inversion' : 'budget';
  const expected = args.expected ?? { markers: {}, updatedAt: null, deferUntil: null };
  try {
    return await db.$transaction(async (tx) => {
      await assertDailyAggregateGuards(tx, {
        timezoneRevision: args.revision,
        now: args.now,
        generation: args.generation,
        leaseOwner: args.leaseOwner,
      });
      if (expected.updatedAt === null) {
        // 「当时确认无该行」才走插入；否则说明期望值本身不可用，不写。
        if (Object.keys(expected.markers).length > 0) return 'cas_failed';
        const affected = await insertDayStateIfAbsent(tx, {
          localDate: args.halt.localDate,
          timezoneRevision: args.revision,
          timezone: args.timezone,
          markerVersions: {},
          deferUntil: null,
          gapKind,
          gapSince: args.now,
          now: args.now,
        });
        return affected === 1 ? 'written' : 'cas_failed';
      }
      const affected = await casWriteDayState(tx, {
        localDate: args.halt.localDate,
        timezoneRevision: args.revision,
        timezone: args.timezone,
        markerVersions: expected.markers,
        deferUntil: mergeDeferUntil(expected.deferUntil, null, args.notAfter),
        gapKind,
        gapSince: args.now,
        expectedMarkers: expected.markers,
        expectedUpdatedAt: expected.updatedAt,
        now: args.now,
      });
      return affected === 1 ? 'written' : 'cas_failed';
    }, { maxWait: 2_000, timeout: 10_000 });
  } catch {
    return 'write_failed';
  }
}
