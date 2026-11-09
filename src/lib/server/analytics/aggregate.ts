import { Prisma, type PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, type SiteDayBounds } from '../../analytics/day-boundaries';
import { aggregateSiteDay, type RollupSourceEvent } from '../../analytics/rollup-plan';
import { planSnapshot, type CoverageState, type SnapshotPlan } from '../../analytics/aggregate-plan';
import { ANALYTICS_SETTINGS_KEY, INITIAL_TIMEZONE_REVISION, StoredTimezoneRevisionSchema } from '../jobs/types';
import {
  loadEventsAtSnapshot,
  readLockedGeneration,
  runInRepeatableReadSnapshot,
  upsertWatermarkGuarded,
} from './aggregate-repo';

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

/** 事务等待连接的上限；与执行时间合计不得超过本轮剩余预算。 */
const AGGREGATE_TX_MAX_WAIT_MS = 2_000;

/** 剩余预算低于此值就不再开启聚合事务。 */
const AGGREGATE_MIN_TX_MS = 250;

/** 事务内提交前的回调：与聚合整组写入同事务，任一失败整组回滚。 */
export type AggregateCommitHook = (
  tx: Prisma.TransactionClient,
  summary: { writtenDays: number; dataThrough: string | null; sourceThrough: string | null },
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
  errorCode: string | null;
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
  /** 与整组聚合同一事务的提交钩子；抛错则整组回滚（用于原子完成作业租约）。 */
  commit?: AggregateCommitHook;
  /**
   * 写前时区代次守卫（D4）。保留清理的删后近期聚合传 true；
   * 共享聚合作业不传：它的 commit 钩子在同一个事务里调用租约结算（FOR UPDATE）核对 revision，
   * 不符即整组回滚，属等价原子守卫。
   */
  assertTimezoneRevision?: boolean;
}): Promise<AggregateRunResult> {
  const deadlineMs = deps.deadlineAt?.getTime();
  const deadlineReached = () => deadlineMs !== undefined && Date.now() >= deadlineMs;
  if (deadlineReached()) throw new AggregateDeadlineExceeded();

  const plan: SnapshotPlan = planSnapshot({
    now: deps.now,
    siteTimezone: deps.siteTimezone,
    currentDate: deps.currentDate,
  });
  if (deps.maxBatchDays !== undefined && plan.siteDates.length > deps.maxBatchDays) {
    throw new AggregateBatchExceeded(deps.maxBatchDays);
  }

  // 事务预算：maxWait（等连接）与 timeout（执行）之和不超过剩余预算。
  // 剩余不足时直接不开启事务，不用最小 timeout 反向扩大预算。
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

  let days: AggregateDayResult[] = [];
  // 整组事务：任一天失败或版本冲突都会把异常抛到这里，Prisma 整笔回滚，一天都不写。
  // 不 catch 成「部分成功」——09 节 `:71` 禁止留下部分天新、部分天旧的半成品。
  try {
    days = await runInRepeatableReadSnapshot(deps.db, async (tx) => {
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
        await deps.commit(tx, { writtenDays: written.length, dataThrough, sourceThrough });
      }
      return written;
    }, txOptions);
  } catch (error) {
    // 旧快照下的并发写冲突（40001/P2034）必须当版本冲突上抛，不能降级成普通失败。
    throw asVersionConflict(error);
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
    errorCode: null,
  };
}

export type { SiteDayBounds };
