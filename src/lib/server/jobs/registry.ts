import type { Prisma, PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { JobCountsDTO, JobKey, JobResultStatus } from '../../contracts/ops';
import { OperationsRequestSchema } from '../../contracts/ops';
import type { AppErrorCode } from '../../contracts/errors';
import { siteLocalDate } from '../../analytics/day-boundaries';
import { secretMatches } from '../uploads';
import { AggregateBatchExceeded, AggregateDeadlineExceeded, AggregateVersionConflict, runAggregateOnce } from '../analytics/aggregate';
import { readAnalyticsSiteClock } from '../analytics/rollup';
import { createJobLeaseRepo } from './lease-repo';

/** 单轮作业最多处理的条目数；超过即拒绝，避免一次调度把进程拖住。 */
export const JOB_MAX_BATCH = 500;

/** 单轮作业的运行上限。cron 调用的 HTTP 超时也按这个值设置。 */
export const JOB_DEADLINE_MS = 55_000;

/** 事务等待连接的上限；与事务执行时间合计不得超过整轮剩余预算。 */
const JOB_TX_MAX_WAIT_MS = 2_000;

/** 剩余预算低于此值就不再开启任何事务：不足时不许用最小值反向扩大预算。 */
const JOB_MIN_TX_MS = 250;

/** 预算内工作结束后留给响应序列化的余量；写入必须在这之前完成。 */
const JOB_RESPONSE_RESERVE_MS = 250;

/** 聚合作业在固定 registry 里的 key 与租约 owner。 */
export const ANALYTICS_AGGREGATE_KEY = 'analytics-aggregate';
const ANALYTICS_AGGREGATE_OWNER = 'analytics-job-runtime';

export type JobRunContext = {
  now: Date;
  deadlineAt: Date;
  signal: AbortSignal;
  /**
   * 请求是否要求 dry-run。只有契约允许带 dryRun 的作业（分析/聊天保留）会收到它；
   * 缺省视为 dry-run，作业必须把「缺省」当关闭真实写入处理，不能把 undefined 当作启用。
   */
  dryRun?: boolean;
};

export type JobRunOutcome =
  | { kind: 'ran'; status: JobResultStatus; counts: JobCountsDTO }
  | { kind: 'busy' }
  /** 整轮预算在写终态前耗尽：不写 JobState，租约到期后由下一次调度接管。 */
  | { kind: 'timeout' }
  /** 终态没有写进数据库：调用方不能对外宣称 FAILED/SUCCEEDED 已持久化。 */
  | { kind: 'finish_failed' };

export type RegisteredJob = {
  key: JobKey;
  run(context: JobRunContext): Promise<JobRunOutcome>;
};

export type JobRegistry = {
  has(key: string): boolean;
  keys(): JobKey[];
  run(key: string, context: JobRunContext): Promise<JobRunOutcome>;
};

/**
 * 固定作业注册表：只接受已实现并接线的作业，重复 key 直接拒绝。
 * 不做动态注册、不接受任意脚本；生产组合点只按已交付模块逐个追加。
 */
export function createJobRegistry(jobs: RegisteredJob[]): JobRegistry {
  const registered = new Map<string, RegisteredJob>();
  for (const job of jobs) {
    if (registered.has(job.key)) throw new Error(`duplicate_job:${job.key}`);
    registered.set(job.key, job);
  }
  return {
    has: (key) => registered.has(key),
    keys: () => [...registered.keys()] as JobKey[],
    run: async (key, context) => {
      const job = registered.get(key);
      if (!job) throw new Error(`unknown_job:${key}`);
      return job.run(context);
    },
  };
}

function errorCodeOf(error: unknown): AppErrorCode {
  if (error instanceof JobDeadlineExceeded || error instanceof AggregateDeadlineExceeded) return 'service_unavailable';
  if (error instanceof AggregateBatchExceeded) return 'invalid';
  if (error instanceof AggregateVersionConflict) return 'version_conflict';
  return 'internal_error';
}

/** 预算在领取租约前就已不足：不产生任何写入，响应明确是超时而不是作业失败。 */
export class JobDeadlineExceeded extends Error {
  constructor() {
    super('job_deadline_exceeded');
    this.name = 'JobDeadlineExceeded';
  }
}

/** 单轮预算：业务时钟由 context.now 决定，执行预算只看真实墙钟与中止信号。 */
export type JobBudget = {
  /** 预算内工作必须结束的时刻（已扣除响应余量）。 */
  deadlineAt: Date;
  signal: AbortSignal;
};

export type BudgetedResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'budget' }
  | { kind: 'error'; error: unknown };

export function createJobBudget(context: JobRunContext): JobBudget {
  return {
    deadlineAt: new Date(context.deadlineAt.getTime() - JOB_RESPONSE_RESERVE_MS),
    signal: context.signal,
  };
}

export function remainingBudgetMs(budget: JobBudget): number {
  return budget.deadlineAt.getTime() - Date.now();
}

export function budgetExhausted(budget: JobBudget): boolean {
  return budget.signal.aborted || remainingBudgetMs(budget) <= 0;
}

/**
 * Prisma/PostgreSQL 的预算类错误：客户端事务超时（P2028）、
 * statement_timeout（57014）、lock_timeout（55P03）。
 * 三类都表示本轮没能在截止前完成，数据库已回滚，不能当作业务失败。
 */
export function isBudgetTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code === 'P2028') return true;
  const pgCode = (error as { meta?: { code?: unknown } }).meta?.code;
  return pgCode === '57014' || pgCode === '55P03';
}

/**
 * 在整轮剩余预算内跑一条事务：`maxWait`（等连接）与 `timeout`（事务执行）
 * 之和不超过剩余预算，并在数据库侧再设 statement_timeout / lock_timeout，
 * 使单句 SQL 和行锁等待也不会跨过截止后继续执行。
 * 预算不足时不开事务；超时类错误同样归为预算耗尽，由调用方决定是否还能写终态。
 *
 * 分析聚合作业与分析保留作业共用这一原语：保留清理的每批删除都单独成事务，
 * 因此每批开始时重新按剩余预算计算，而不是只在整轮开始时算一次。
 */
export async function runWithinBudget<T>(
  db: Pick<PrismaClient, '$transaction'>,
  budget: JobBudget,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<BudgetedResult<T>> {
  const remaining = remainingBudgetMs(budget);
  if (budget.signal.aborted || remaining < JOB_MIN_TX_MS) return { kind: 'budget' };
  const maxWait = Math.min(JOB_TX_MAX_WAIT_MS, Math.floor(remaining / 2));
  const timeout = Math.floor(remaining - maxWait);
  if (maxWait < 1 || timeout < 1) return { kind: 'budget' };
  try {
    const value = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeout}`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${timeout}`);
      return work(tx);
    }, { maxWait, timeout });
    return { kind: 'ok', value };
  } catch (error) {
    if (isBudgetTimeoutError(error) || budgetExhausted(budget)) return { kind: 'budget' };
    return { kind: 'error', error };
  }
}

type SiteClockRead = Awaited<ReturnType<typeof readAnalyticsSiteClock>>;
type ClockReader = (db: Prisma.TransactionClient) => Promise<SiteClockRead>;

/**
 * 已实现的 analytics-aggregate 作业：领取固定租约 → 读取站点时钟 → 按站点时区重算一次。
 *
 * **整轮共用一个预算**：claim、设置读取、聚合事务与失败收尾都从同一剩余预算里扣；
 * 每条事务的 `maxWait`（等连接）与 `timeout`（执行）之和不超过剩余预算，
 * 数据库侧再设 statement_timeout / lock_timeout，行锁等待也跨不过截止。
 *
 * 聚合与作业完成在**同一条 RepeatableRead 事务**里提交：`repo.complete` 在事务内
 * 重锁 SiteSetting 核时区代次、核租约 owner/generation/有效期，任一不符整组回滚，
 * watermark 与 JobState 一起不写。预算耗尽后不再新开失败写事务，也不晚写 JobState：
 * 已领取的租约保持 RUNNING，90s 租约到期后由下一次调度接管，上次成功时间不变。
 */
export function createAnalyticsAggregateJob(deps: {
  db: PrismaClient;
  clock?: () => Date;
  /** 读取站点时钟；默认读 SiteSetting，测试可注入抛错以覆盖 claim 成功后的读取失败分支。 */
  settingsReader?: ClockReader;
}): RegisteredJob {
  const clock = deps.clock ?? (() => new Date());
  const readSettings: ClockReader = deps.settingsReader ?? ((db) => readAnalyticsSiteClock(db));
  const repo = createJobLeaseRepo({ db: deps.db, clock });
  const EMPTY_COUNTS: JobCountsDTO = { candidateCount: 0 };

  return {
    key: ANALYTICS_AGGREGATE_KEY,
    async run(context) {
      const now = context.now;
      const budget = createJobBudget(context);

      // 1. 领取租约：并发事务持有 JobState 行锁时，claim 的 upsert 会排队；
      //    事务预算内的 lock_timeout/statement_timeout 保证排队不会越过本轮截止。
      const claimed = await runWithinBudget(deps.db, budget, (tx) =>
        createJobLeaseRepo({ db: tx, clock }).claim({
          key: ANALYTICS_AGGREGATE_KEY,
          owner: ANALYTICS_AGGREGATE_OWNER,
        }));
      if (claimed.kind === 'budget') throw new JobDeadlineExceeded();
      if (claimed.kind === 'error') throw claimed.error;
      const claim = claimed.value;
      if (!claim.acquired) {
        if (claim.reason === 'busy') return { kind: 'busy' };
        throw new Error(`claim_${claim.reason}`);
      }

      /** 只有真写进数据库才能对外说 FAILED；预算不够就不写，其他失败说明没落库。 */
      const failedOutcome = (persisted: 'persisted' | 'budget' | 'unpersisted', counts: JobCountsDTO): JobRunOutcome =>
        persisted === 'persisted'
          ? { kind: 'ran', status: 'FAILED', counts }
          : persisted === 'budget' ? { kind: 'timeout' } : { kind: 'finish_failed' };

      const fail = async (errorCode: AppErrorCode): Promise<'persisted' | 'budget' | 'unpersisted'> => {
        const result = await runWithinBudget(deps.db, budget, async (tx) => {
          await repo.complete({
            key: ANALYTICS_AGGREGATE_KEY,
            owner: ANALYTICS_AGGREGATE_OWNER,
            generation: claim.generation,
            status: 'FAILED',
            summary: {
              counts: EMPTY_COUNTS,
              times: { aggregatedAt: now.toISOString() },
              versions: { timezoneRevision: claim.timezoneRevision },
            },
            errorCode,
            timezoneRevision: claim.timezoneRevision,
          }, tx);
        });
        if (result.kind === 'ok') return 'persisted';
        if (result.kind === 'budget') return 'budget';
        console.error('[cron] analytics aggregate lease finish failed', { status: 'FAILED' });
        return 'unpersisted';
      };

      // 2. 站点时钟：同样在预算内读；读取抛错或内容损坏都走安全失败，不留下水位。
      const settingsResult = await runWithinBudget(deps.db, budget, (tx) => readSettings(tx));
      if (settingsResult.kind === 'budget') return { kind: 'timeout' };
      if (settingsResult.kind === 'error') return failedOutcome(await fail('service_unavailable'), EMPTY_COUNTS);
      const settings = settingsResult.value;
      if (settings === 'corrupt' || settings.timezoneRevision !== claim.timezoneRevision) {
        return failedOutcome(await fail('service_unavailable'), EMPTY_COUNTS);
      }

      // 3. 聚合：事务预算在真正开始时按剩余预算重算；成功时与 JobState 同事务提交。
      const counts: JobCountsDTO = { candidateCount: 0 };
      const currentDate = siteLocalDate(now, settings.timezone);
      try {
        const result = await runAggregateOnce({
          db: deps.db,
          now,
          siteTimezone: settings.timezone,
          currentDate,
          timezoneRevision: claim.timezoneRevision,
          generation: claim.generation,
          deadlineAt: budget.deadlineAt,
          // 只计已发生的事实：准入窗口内 occurredAt 最多领先 now+5min 的未来事件，
          // 到其 occurredAt 前不得提前计入（E-60）。
          occurredNotAfter: now,
          maxBatchDays: JOB_MAX_BATCH,
          commit: async (tx, summary) => {
            if (budgetExhausted(budget)) throw new AggregateDeadlineExceeded();
            await repo.complete({
              key: ANALYTICS_AGGREGATE_KEY,
              owner: ANALYTICS_AGGREGATE_OWNER,
              generation: claim.generation,
              status: 'SUCCEEDED',
              summary: {
                counts: { candidateCount: summary.writtenDays },
                times: {
                  aggregatedAt: now.toISOString(),
                  ...(summary.sourceThrough ? { sourceThrough: summary.sourceThrough } : {}),
                  ...(summary.dataThrough ? { dataThrough: summary.dataThrough } : {}),
                },
                versions: { timezoneRevision: claim.timezoneRevision },
              },
              errorCode: null,
              timezoneRevision: claim.timezoneRevision,
            }, tx);
          },
        });
        const written = result.days.filter((day) => day.written).length;
        return { kind: 'ran', status: 'SUCCEEDED', counts: { candidateCount: written } };
      } catch (error) {
        // 预算耗尽（含事务/语句/锁等待超时）：不新开失败写事务，也不晚写 JobState；
        // 保留原成功水位，租约到期后由下一次调度接管。
        if (error instanceof AggregateDeadlineExceeded || isBudgetTimeoutError(error) || budgetExhausted(budget)) {
          return { kind: 'timeout' };
        }
        return failedOutcome(await fail(errorCodeOf(error)), counts);
      }
    },
  };
}

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** 单轮作业超过期限就返回超时；正在跑的租约到期后自然可被下一次调度领取。 */
async function runWithDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type OperationsHandlerDeps = {
  services: JobRegistry;
  clock?: () => Date;
  secret?: string;
  /** 单轮预算；默认 JOB_DEADLINE_MS。 */
  deadlineMs?: number;
};

/**
 * POST /api/admin/cron/operations 的处理器：固定 jobKey 白名单 + Bearer
 * CRON_SECRET（常量时间比较）。只执行 registry 里已注册的实现，不接受任意脚本、
 * 路径或浏览器 session；未注册的 key 一律拒绝。
 */
export function createOperationsHandler(deps: OperationsHandlerDeps) {
  const clock = deps.clock ?? (() => new Date());
  return async function handle(req: Request): Promise<Response> {
    const auth = req.headers.get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!secretMatches(token, deps.secret)) return reply({ error: 'unauthorized' }, 401);

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return reply({ error: 'invalid' }, 400);
    }
    const parsed = OperationsRequestSchema.safeParse(payload);
    if (!parsed.success) return reply({ error: 'invalid' }, 400);
    const request = parsed.data;
    const { jobKey } = request;
    if (!deps.services.has(jobKey)) return reply({ error: 'unknown_job' }, 400);

    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return reply({ error: 'service_unavailable' }, 503);
    }
    // 业务 cutoff 用注入时钟；预算用真实墙钟，两者不能混用。
    const deadlineMs = deps.deadlineMs ?? JOB_DEADLINE_MS;
    const deadlineAt = new Date(Date.now() + deadlineMs);
    const controller = new AbortController();

    // 只有契约里带 dryRun 的作业会收到这个字段；其余作业的请求体里没有它。
    const context: JobRunContext = {
      now,
      deadlineAt,
      signal: controller.signal,
      ...('dryRun' in request ? { dryRun: request.dryRun } : {}),
    };
    let outcome: JobRunOutcome | 'deadline';
    try {
      outcome = await runWithDeadline(
        deps.services.run(jobKey, context),
        deadlineMs,
      );
    } catch (error) {
      if (error instanceof JobDeadlineExceeded) {
        console.error('[cron] operations job deadline before claim', { jobKey });
        return reply({ error: 'job_timeout' }, 503);
      }
      console.error('[cron] operations job failed', { jobKey });
      return reply({ error: 'job_failed' }, 500);
    }
    if (outcome === 'deadline') {
      controller.abort();
      console.error('[cron] operations job deadline', { jobKey });
      return reply({ error: 'job_timeout' }, 503);
    }
    if (outcome.kind === 'busy') return reply({ error: 'job_busy' }, 409);
    if (outcome.kind === 'timeout') {
      // 预算耗尽：本轮没有写终态，JobState 保持已领取的 RUNNING，租约到期后由下一次调度接管。
      console.error('[cron] operations job budget exhausted', { jobKey });
      return reply({ error: 'job_timeout' }, 503);
    }
    if (outcome.kind === 'finish_failed') {
      console.error('[cron] operations job result not persisted', { jobKey });
      return reply({ error: 'job_failed' }, 500);
    }

    return reply({
      jobKey,
      status: outcome.status,
      counts: outcome.counts,
      finishedAt: clock().toISOString(),
    });
  };
}
