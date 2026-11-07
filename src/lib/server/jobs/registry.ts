import type { PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { JobCountsDTO, JobKey, JobResultStatus } from '../../contracts/ops';
import { OperationsRequestSchema } from '../../contracts/ops';
import type { AppErrorCode } from '../../contracts/errors';
import { siteLocalDate } from '../../analytics/day-boundaries';
import { secretMatches } from '../uploads';
import { AggregateVersionConflict, runAggregateOnce } from '../analytics/aggregate';
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
  return error instanceof AggregateVersionConflict ? 'version_conflict' : 'internal_error';
}

/**
 * 已实现的 analytics-aggregate 作业：领取固定租约 → 按站点时区重算一次 →
 * 在独立事务里完成租约并写受白名单约束的 summary。
 *
 * 聚合本身在 M5-T3 的整组事务里完成（快照、水位守卫、旧代次拒绝都不在这里重写）；
 * 失败时聚合事务回滚，上一次成功的 watermark 保留，只有 JobState 被标为 FAILED。
 */
export function createAnalyticsAggregateJob(deps: {
  db: PrismaClient;
  clock?: () => Date;
}): RegisteredJob {
  const clock = deps.clock ?? (() => new Date());
  return {
    key: ANALYTICS_AGGREGATE_KEY,
    async run(context) {
      const repo = createJobLeaseRepo({ db: deps.db, clock });
      const claim = await repo.claim({ key: ANALYTICS_AGGREGATE_KEY, owner: ANALYTICS_AGGREGATE_OWNER });
      if (!claim.acquired) {
        if (claim.reason === 'busy') return { kind: 'busy' };
        throw new Error(`claim_${claim.reason}`);
      }

      const now = context.now;
      const finish = async (status: JobResultStatus, errorCode: AppErrorCode | null, counts: JobCountsDTO) => {
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
        }, { maxWait: 5_000, timeout: 15_000 });
      };

      const settings = await readAnalyticsSiteClock(deps.db);
      if (settings === 'corrupt' || settings.timezoneRevision !== claim.timezoneRevision) {
        const counts: JobCountsDTO = { candidateCount: 0 };
        await finish('FAILED', 'service_unavailable', counts);
        return { kind: 'ran', status: 'FAILED', counts };
      }

      const currentDate = siteLocalDate(now, settings.timezone);
      try {
        const result = await runAggregateOnce({
          db: deps.db,
          now,
          siteTimezone: settings.timezone,
          currentDate,
          timezoneRevision: claim.timezoneRevision,
          generation: claim.generation,
        });
        const written = result.days.filter((day) => day.written).length;
        if (written > JOB_MAX_BATCH) throw new Error('batch_too_large');
        const counts: JobCountsDTO = { candidateCount: written };
        await finish('SUCCEEDED', null, counts);
        return { kind: 'ran', status: 'SUCCEEDED', counts };
      } catch (error) {
        const counts: JobCountsDTO = { candidateCount: 0 };
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
    const deadlineAt = new Date(now.getTime() + JOB_DEADLINE_MS);
    const controller = new AbortController();

    let outcome: JobRunOutcome | 'deadline';
    try {
      outcome = await runWithDeadline(
        deps.services.run(jobKey, { now, deadlineAt, signal: controller.signal }),
        JOB_DEADLINE_MS,
      );
    } catch {
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
