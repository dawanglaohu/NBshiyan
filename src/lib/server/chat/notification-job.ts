import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { JobCountsDTO } from '../../contracts/ops';
import { createJobLeaseRepo } from '../jobs/lease-repo';
import { createJobBudget, runWithinBudget, type RegisteredJob } from '../jobs/registry';
import { createNotificationRepo } from './notification-repo';
import { createNotificationMailer, notificationMailConfig, type NotificationMailer } from './notification-mailer';
import { processChatNotifications } from './notification-service';
import { CHAT_JOB_FINISH_RESERVE_MS, CHAT_NOTIFICATION_JOB_KEY, NotificationBudgetExceeded, type NotificationEnv } from './notification-policy';

export function createChatNotificationJob(deps: {
  db: PrismaClient;
  clock?: () => Date;
  env?: NotificationEnv;
  getMailer?: () => Promise<NotificationMailer | null>;
  limit?: number;
}): RegisteredJob {
  const clock = deps.clock ?? (() => new Date());
  const env = deps.env ?? process.env;
  return {
    key: CHAT_NOTIFICATION_JOB_KEY,
    async run(context) {
      const budget = createJobBudget(context);
      const owner = `chat-notification:${randomUUID()}`;
      const lease = createJobLeaseRepo({ db: deps.db, clock });
      const claimed = await runWithinBudget(deps.db, budget, (tx) =>
        createJobLeaseRepo({ db: tx, clock }).claim({ key: CHAT_NOTIFICATION_JOB_KEY, owner }));
      if (claimed.kind === 'budget') return { kind: 'timeout' };
      if (claimed.kind === 'error') throw claimed.error;
      if (!claimed.value.acquired) {
        if (claimed.value.reason === 'busy') return { kind: 'busy' };
        throw new Error('chat_notification_job_claim_failed');
      }
      const claim = claimed.value;
      let counts: JobCountsDTO | undefined;
      let failed = false;
      try {
        counts = await processChatNotifications({
          repo: createNotificationRepo({ db: deps.db, clock, budget, env }), owner, env,
          ...(deps.limit !== undefined ? { limit: deps.limit } : {}),
          getMailer: deps.getMailer ?? (async () => {
            const config = notificationMailConfig(env);
            return config ? createNotificationMailer(config) : null;
          }),
        }, { now: context.now, budget });
      } catch (error) {
        if (error instanceof NotificationBudgetExceeded) return { kind: 'timeout' };
        failed = true;
      }
      // All notification transactions have ended before JobState may lock SiteSetting.
      const terminalBudget = { ...budget, deadlineAt: new Date(Math.min(budget.deadlineAt.getTime(), Date.now() + CHAT_JOB_FINISH_RESERVE_MS)) };
      const completed = await runWithinBudget(deps.db, terminalBudget, (tx) => lease.complete({
        key: CHAT_NOTIFICATION_JOB_KEY, owner, generation: claim.generation,
        status: failed ? 'FAILED' : 'SUCCEEDED', summary: { counts: counts ?? {}, times: { measuredAt: clock().toISOString() } },
        errorCode: failed ? 'internal_error' : null, timezoneRevision: claim.timezoneRevision,
      }, tx));
      if (completed.kind === 'budget') return { kind: 'timeout' };
      if (completed.kind === 'error' || !completed.value.committed) return { kind: 'finish_failed' };
      if (failed || !counts) throw new Error('chat_notification_job_failed');
      return { kind: 'ran', status: 'SUCCEEDED', counts };
    },
  };
}
