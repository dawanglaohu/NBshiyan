import type { PrismaClient } from '@prisma/client';
import type { JobCountsDTO } from '../../contracts/ops';
import type { AppErrorCode } from '../../contracts/errors';
import {
  budgetExhausted,
  createJobBudget,
  isBudgetTimeoutError,
  JobDeadlineExceeded,
  runWithinBudget,
  type JobRunOutcome,
  type RegisteredJob,
} from '../jobs/registry';
import { createJobLeaseRepo } from '../jobs/lease-repo';
import type { MailSendAdapter } from './adapter';
import { mailLog } from './adapter';
import {
  MAIL_CLOSE_WINDOW_MS,
  processMailQueue,
  type AlertFn,
  type AuditFn,
  type AuditInTxFn,
  type MailCloseWindow,
} from './send';

export const MAIL_QUEUE_KEY = 'mail-queue' as const;
const MAIL_QUEUE_OWNER = 'mail-queue-runtime';
const EMPTY_COUNTS: JobCountsDTO = { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 };
const DEFAULT_LIMIT = 50;

/**
 * 既有邮件队列的固定作业包装：领取 JobState 租约 → 受整轮预算约束地消费 QUEUED/延迟信 →
 * 预算内写一次摘要。业务时间只用注入时钟，执行预算只看真实墙钟。
 *
 * 收尾窗（终态写 / D 回退）从 budget.deadlineAt（HTTP 55s − 250ms = 54.75s）起算绝对 2s；
 * SMTP 在窗后返回时不再写、不计数，由下一轮 stale 处理。
 */
export function createMailQueueJob(deps: {
  db: PrismaClient;
  clock?: () => Date;
  getAdapter: () => Promise<MailSendAdapter | null>;
  alert?: AlertFn;
  audit?: AuditFn;
  auditInTx?: AuditInTxFn;
  limit?: number;
  env?: Record<string, string | undefined>;
}): RegisteredJob {
  const clock = deps.clock ?? (() => new Date());
  const repo = createJobLeaseRepo({ db: deps.db, clock });
  const limit = deps.limit ?? DEFAULT_LIMIT;

  return {
    key: MAIL_QUEUE_KEY,
    async run(context) {
      const now = context.now;
      const budget = createJobBudget(context);

      const claimed = await runWithinBudget(deps.db, budget, (tx) =>
        createJobLeaseRepo({ db: tx, clock }).claim({ key: MAIL_QUEUE_KEY, owner: MAIL_QUEUE_OWNER }));
      if (claimed.kind === 'budget') throw new JobDeadlineExceeded();
      if (claimed.kind === 'error') throw claimed.error;
      const claim = claimed.value;
      if (!claim.acquired) {
        if (claim.reason === 'busy') return { kind: 'busy' };
        // invalid / revision_unreadable：不能当 busy 静默跳过，交给 executeJobRequest 映射 failed。
        throw new Error(`claim_${claim.reason}`);
      }

      const fail = async (errorCode: AppErrorCode): Promise<'persisted' | 'budget' | 'unpersisted'> => {
        const result = await runWithinBudget(deps.db, budget, async (tx) => {
          await repo.complete({
            key: MAIL_QUEUE_KEY,
            owner: MAIL_QUEUE_OWNER,
            generation: claim.generation,
            status: 'FAILED',
            summary: { counts: EMPTY_COUNTS, times: { measuredAt: now.toISOString() } },
            errorCode,
            timezoneRevision: claim.timezoneRevision,
          }, tx);
        });
        if (result.kind === 'ok') return 'persisted';
        if (result.kind === 'budget') return 'budget';
        return 'unpersisted';
      };
      const failedOutcome = (persisted: 'persisted' | 'budget' | 'unpersisted'): JobRunOutcome =>
        persisted === 'persisted'
          ? { kind: 'ran', status: 'FAILED', counts: EMPTY_COUNTS }
          : persisted === 'budget' ? { kind: 'timeout' } : { kind: 'finish_failed' };

      const complete = async (counts: JobCountsDTO): Promise<JobRunOutcome> => {
        const result = await runWithinBudget(deps.db, budget, async (tx) => {
          await repo.complete({
            key: MAIL_QUEUE_KEY,
            owner: MAIL_QUEUE_OWNER,
            generation: claim.generation,
            status: 'SUCCEEDED',
            summary: { counts, times: { measuredAt: now.toISOString() } },
            errorCode: null,
            timezoneRevision: claim.timezoneRevision,
          }, tx);
        });
        if (result.kind === 'ok') return { kind: 'ran', status: 'SUCCEEDED', counts };
        if (result.kind === 'budget') return { kind: 'timeout' };
        return { kind: 'finish_failed' };
      };

      let adapter: MailSendAdapter | null;
      try {
        adapter = await deps.getAdapter();
      } catch {
        return failedOutcome(await fail('service_unavailable'));
      }
      if (!adapter) {
        mailLog('info', 'mail.queue_disabled', { status: 'sending_disabled' });
        return complete(EMPTY_COUNTS);
      }

      const close: MailCloseWindow = {
        used: false,
        deadlineAt: new Date(budget.deadlineAt.getTime() + MAIL_CLOSE_WINDOW_MS),
      };
      let counts: JobCountsDTO;
      try {
        counts = await processMailQueue({
          db: deps.db,
          adapter,
          ...(deps.env ? { env: deps.env } : {}),
          now: clock,
          ...(deps.alert ? { alert: deps.alert } : {}),
          ...(deps.audit ? { audit: deps.audit } : {}),
          ...(deps.auditInTx ? { auditInTx: deps.auditInTx } : {}),
        }, { limit, budget, close });
      } catch (error) {
        if (isBudgetTimeoutError(error) || budgetExhausted(budget)) return { kind: 'timeout' };
        // P2-A：非预算失败先尝试一次预算内失败登记；未确认不宣称已写 FAILED、不重试。
        // 然后传播原失败，由 executeJobRequest 映射 500 job_failed；不得返回 ran/FAILED 变 200。
        const failed = await fail('internal_error');
        if (failed === 'budget') return { kind: 'timeout' };
        throw error;
      }
      return complete(counts);
    },
  };
}
