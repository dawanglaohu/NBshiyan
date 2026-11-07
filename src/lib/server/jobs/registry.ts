import type { PrismaClient } from '@prisma/client';
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

/** 聚合作业在固定 registry 里的 key 与租约 owner。 */
export const ANALYTICS_AGGREGATE_KEY = 'analytics-aggregate';
const ANALYTICS_AGGREGATE_OWNER = 'analytics-job-runtime';

export type JobRunContext = {
  now: Date;
  deadlineAt: Date;
  signal: AbortSignal;
};

export type JobRunOutcome =
  | { kind: 'ran'; status: JobResultStatus; counts: JobCountsDTO }
  | { kind: 'busy' };

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

/**
 * 已实现的 analytics-aggregate 作业：领取固定租约 → 按站点时区重算一次。
 *
 * 聚合与作业完成在**同一条 RepeatableRead 事务**里提交：`repo.complete` 在事务内
 * 重锁 SiteSetting 核时区代次、核租约 owner/generation/有效期，任一不符整组回滚，
 * watermark 与 JobState 一起不写。55s 预算传进聚合事务作为事务超时，超时由数据库
 * 整笔回滚；失败/超时不得再宣称 SUCCEEDED。
 */
export function createAnalyticsAggregateJob(deps: {
  db: PrismaClient;
  clock?: () => Date;
}): RegisteredJob {
  const clock = deps.clock ?? (() => new Date());
  return {
    key: ANALYTICS_AGGREGATE_KEY,
    async run(context) {
      const now = context.now;
      // 提交与状态写入需要余量；剩余不足时不开任何写事务。
      if (context.deadlineAt.getTime() - Date.now() <= 2_000) throw new JobDeadlineExceeded();

      const repo = createJobLeaseRepo({ db: deps.db, clock });
      const claim = await repo.claim({ key: ANALYTICS_AGGREGATE_KEY, owner: ANALYTICS_AGGREGATE_OWNER });
      if (!claim.acquired) {
        if (claim.reason === 'busy') return { kind: 'busy' };
        throw new Error(`claim_${claim.reason}`);
      }

      const finish = async (
        status: JobResultStatus,
        errorCode: AppErrorCode | null,
        counts: JobCountsDTO,
      ): Promise<boolean> => {
        try {
          await deps.db.$transaction(async (tx) => {
            await repo.complete({
              key: ANALYTICS_AGGREGATE_KEY,
              owner: ANALYTICS_AGGREGATE_OWNER,
              generation: claim.generation,
              status,
              summary: {
                counts,
                times: { aggregatedAt: now.toISOString() },
                versions: { timezoneRevision: claim.timezoneRevision },
              },
              errorCode,
              timezoneRevision: claim.timezoneRevision,
            }, tx);
          }, { maxWait: 5_000, timeout: 10_000 });
          return true;
        } catch {
          console.error('[cron] analytics aggregate lease finish failed', { status });
          return false;
        }
      };

      let settings: Awaited<ReturnType<typeof readAnalyticsSiteClock>>;
      try {
        settings = await readAnalyticsSiteClock(deps.db);
      } catch {
        const counts: JobCountsDTO = { candidateCount: 0 };
        await finish('FAILED', 'service_unavailable', counts);
        return { kind: 'ran', status: 'FAILED', counts };
      }
      if (settings === 'corrupt' || settings.timezoneRevision !== claim.timezoneRevision) {
        const counts: JobCountsDTO = { candidateCount: 0 };
        await finish('FAILED', 'service_unavailable', counts);
        return { kind: 'ran', status: 'FAILED', counts };
      }

      if (context.deadlineAt.getTime() - Date.now() <= 2_000) {
        const counts: JobCountsDTO = { candidateCount: 0 };
        await finish('FAILED', 'service_unavailable', counts);
        return { kind: 'ran', status: 'FAILED', counts };
      }

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
          deadlineAt: context.deadlineAt,
          maxBatchDays: JOB_MAX_BATCH,
          commit: async (tx, summary) => {
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
        await finish('FAILED', errorCodeOf(error), counts);
        return { kind: 'ran', status: 'FAILED', counts };
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
    const { jobKey } = parsed.data;
    if (!deps.services.has(jobKey)) return reply({ error: 'unknown_job' }, 400);

    const now = clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return reply({ error: 'service_unavailable' }, 503);
    }
    // 业务 cutoff 用注入时钟；预算用真实墙钟，两者不能混用。
    const deadlineAt = new Date(Date.now() + JOB_DEADLINE_MS);
    const controller = new AbortController();

    let outcome: JobRunOutcome | 'deadline';
    try {
      outcome = await runWithDeadline(
        deps.services.run(jobKey, { now, deadlineAt, signal: controller.signal }),
        JOB_DEADLINE_MS,
      );
    } catch (error) {
      if (error instanceof JobDeadlineExceeded) {
        console.error('[cron] operations job deadline before start', { jobKey });
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

    return reply({
      jobKey,
      status: outcome.status,
      counts: outcome.counts,
      finishedAt: clock().toISOString(),
    });
  };
}
