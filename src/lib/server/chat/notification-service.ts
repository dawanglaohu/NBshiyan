import type { JobCountsDTO } from '../../contracts/ops';
import { remainingBudgetMs, type JobBudget } from '../jobs/registry';
import { notificationToken, type NotificationRepo, type NotificationRow } from './notification-repo';
import { notificationMail, type NotificationMailer } from './notification-mailer';
import {
  CHAT_NOTIFICATION_DEFAULT_LIMIT, CHAT_NOTIFICATION_STOP_RESERVE_MS, CHAT_ROW_START_MAX_MS,
  CHAT_SMTP_DEADLINE_MS, CHAT_ROW_FINISH_MAX_MS, CHAT_NOTIFICATION_MAX_ATTEMPTS,
  notificationTestHooks, pauseAfterNotificationAcceptance,
  type NotificationEnv, type NotificationOutcome,
} from './notification-policy';

/** A typed DI failure before adapter entry; arbitrary exceptions remain UNKNOWN. */
export class NotificationPreSendFailure extends Error {
  constructor() { super('chat_notification_before_adapter'); this.name = 'NotificationPreSendFailure'; }
}

export async function processChatNotifications(deps: {
  repo: NotificationRepo;
  getMailer: () => Promise<NotificationMailer | null>;
  owner: string;
  env?: NotificationEnv;
  limit?: number;
  beforeSend?: (row: NotificationRow) => Promise<void>;
  afterAccepted?: (row: NotificationRow) => Promise<void>;
  log?: (event: { status: NotificationOutcome['kind']; code: string | null }) => void;
}, context: { now: Date; budget: JobBudget }): Promise<JobCountsDTO> {
  const { repo } = deps;
  const env = deps.env ?? process.env;
  const limit = deps.limit ?? CHAT_NOTIFICATION_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('chat_notification_limit_invalid');
  const counts = { candidateCount: 0, sent: 0, failed: 0, deferred: 0, dropped: 0, stale: 0 };
  counts.stale = await repo.recoverExpiredLease(context.now);
  const mailer = await deps.getMailer();
  if (!mailer) {
    counts.dropped = await repo.disableNeverStartedQueued();
    return counts;
  }
  await repo.promoteUnknown(context.now);
  for (let i = 0; i < limit; i++) {
    if (context.budget.signal.aborted || remainingBudgetMs(context.budget) < CHAT_NOTIFICATION_STOP_RESERVE_MS) break;
    const claimed = await repo.claimDue(deps.owner);
    if (!claimed) break;
    counts.candidateCount++;
    const token = notificationToken(claimed);
    // pre-send and its independent, unlocked content read share the same 3s phase envelope.
    const startBudget: JobBudget = {
      deadlineAt: new Date(Math.min(context.budget.deadlineAt.getTime(), Date.now() + CHAT_ROW_START_MAX_MS)),
      signal: context.budget.signal,
    };
    const row = await repo.startAttempt(token, startBudget);
    if (!row) { counts.stale++; continue; }
    let outcome: NotificationOutcome;
    // A failed DB read does not prove that content is permanently absent.
    const content = await repo.loadContent(row, startBudget).catch(() => undefined);
    if (content === undefined) outcome = { kind: 'unknown', code: 'CHAT_WORKER_UNKNOWN' };
    else if (content === null) outcome = { kind: 'failed', code: 'CHAT_LOCAL_INVALID' };
    else {
      let enteredAdapter = false;
      try {
        await deps.beforeSend?.(row);
        if (context.budget.signal.aborted || remainingBudgetMs(context.budget) < CHAT_SMTP_DEADLINE_MS + CHAT_ROW_FINISH_MAX_MS) {
          outcome = { kind: 'retry', code: 'CHAT_PRE_SEND_BUDGET' };
        } else {
          enteredAdapter = true;
          outcome = await mailer.send(notificationMail(row, content), context.budget.signal);
          if (outcome.kind === 'sent') {
            if (notificationTestHooks(env).pauseAfterAccept) await pauseAfterNotificationAcceptance(context.budget.signal);
            await deps.afterAccepted?.(row);
          }
        }
      } catch (error) {
        outcome = !enteredAdapter && error instanceof NotificationPreSendFailure
          ? { kind: 'retry', code: 'CHAT_PRE_SEND_FAULT' }
          : { kind: 'unknown', code: 'CHAT_WORKER_UNKNOWN' };
      }
    }
    const committed = await repo.finish(token, outcome);
    if (!committed) counts.stale++;
    else if (outcome.kind === 'sent') counts.sent++;
    else if (outcome.kind === 'failed' || (outcome.kind === 'retry' && row.attempts >= CHAT_NOTIFICATION_MAX_ATTEMPTS)) counts.failed++;
    else counts.deferred++;
    deps.log?.({ status: outcome.kind, code: outcome.kind === 'sent' ? null : outcome.code });
  }
  return counts;
}
