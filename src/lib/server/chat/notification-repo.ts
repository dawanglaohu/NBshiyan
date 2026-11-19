import { Prisma, type PrismaClient } from '@prisma/client';
import { runWithinBudget, type JobBudget } from '../jobs/registry';
import {
  CHAT_NOTIFICATION_LEASE_MS, CHAT_NOTIFICATION_MAINTENANCE_LIMIT,
  CHAT_NOTIFICATION_MAX_ATTEMPTS, CHAT_ROW_CLAIM_MAX_MS, CHAT_ROW_START_MAX_MS,
  CHAT_ROW_FINISH_MAX_MS, NotificationBudgetExceeded, notificationBackoffMs,
  notificationErrorCode, type NotificationEnv, type NotificationOutcome,
} from './notification-policy';

type Status = 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN' | 'DISABLED';
export type NotificationRow = {
  id: string; conversationId: string; messageId: string; stableMessageId: string;
  status: Status; attempts: number; availableAt: Date; leaseVersion: number;
  leaseOwner: string | null; lockedUntil: Date | null; requestStartedAt: Date | null;
  lastErrorCode: string | null; providerMessageId: string | null; sentAt: Date | null;
  createdAt: Date; updatedAt: Date;
};
export type NotificationToken = { id: string; owner: string; leaseVersion: number };
export type NotificationDb = Pick<PrismaClient, '$transaction' | 'chatMessage'>;
export type NotificationContent = { conversationId: string; locale: string; receivedAt: Date };
const view = Prisma.sql`"id", "conversationId", "messageId", "stableMessageId", "status"::text AS "status",
  "attempts", "availableAt", "leaseVersion", "leaseOwner", "lockedUntil", "requestStartedAt",
  "lastErrorCode", "providerMessageId", "sentAt", "createdAt", "updatedAt"`;

function utc(date: Date): Prisma.Sql {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('chat_notification_clock_invalid');
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/** Notification locks never share a transaction with JobState/SiteSetting or SMTP. */
export function createNotificationRepo(deps: {
  db: NotificationDb; clock?: () => Date; budget?: JobBudget; env?: NotificationEnv;
}) {
  const clock = deps.clock ?? (() => new Date());
  const env = deps.env ?? process.env;
  const readCommittedDb = {
    $transaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number }) =>
      deps.db.$transaction(work, { ...options, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
  } as Pick<PrismaClient, '$transaction'>;

  async function transaction<T>(cap: number, work: (tx: Prisma.TransactionClient) => Promise<T>, within?: JobBudget): Promise<T> {
    const deadline = Math.min(deps.budget?.deadlineAt.getTime() ?? Infinity, within?.deadlineAt.getTime() ?? Infinity, Date.now() + cap);
    const budget: JobBudget = { deadlineAt: new Date(deadline), signal: deps.budget?.signal ?? within?.signal ?? new AbortController().signal };
    const result = await runWithinBudget(readCommittedDb, budget, work);
    if (result.kind === 'budget') throw new NotificationBudgetExceeded();
    if (result.kind === 'error') throw result.error;
    return result.value;
  }
  async function locked(tx: Prisma.TransactionClient, id: string): Promise<NotificationRow | null> {
    const rows = await tx.$queryRaw<NotificationRow[]>`
      SELECT ${view} FROM "ChatNotification" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  }
  function valid(row: NotificationRow, token: NotificationToken, now: Date): boolean {
    return row.status === 'SENDING' && row.leaseOwner === token.owner && row.leaseVersion === token.leaseVersion
      && row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime();
  }

  return {
    async claimDue(owner: string): Promise<NotificationRow | null> {
      if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(owner)) throw new Error('chat_notification_owner_invalid');
      const discoveredAt = clock();
      return transaction(CHAT_ROW_CLAIM_MAX_MS, async (tx) => {
        const rows = await tx.$queryRaw<NotificationRow[]>`
          SELECT ${view} FROM "ChatNotification"
          WHERE "status" = 'QUEUED'::"ChatNotificationStatus" AND "attempts" < ${CHAT_NOTIFICATION_MAX_ATTEMPTS}
            AND "availableAt" <= ${utc(discoveredAt)}
          ORDER BY "id" LIMIT 1 FOR UPDATE
        `;
        if (rows.length === 0) return null;
        const now = clock();
        const updated = await tx.$queryRaw<NotificationRow[]>`
          UPDATE "ChatNotification" SET "status" = 'SENDING'::"ChatNotificationStatus",
            "leaseOwner" = ${owner}, "leaseVersion" = "leaseVersion" + 1,
            "lockedUntil" = ${utc(new Date(now.getTime() + CHAT_NOTIFICATION_LEASE_MS))},
            "requestStartedAt" = NULL, "updatedAt" = ${utc(now)}
          WHERE "id" = ${rows[0].id} AND "status" = 'QUEUED'::"ChatNotificationStatus"
            AND "attempts" < ${CHAT_NOTIFICATION_MAX_ATTEMPTS} AND "availableAt" <= ${utc(now)}
          RETURNING ${view}
        `;
        return updated[0] ?? null;
      });
    },

    async startAttempt(token: NotificationToken, within?: JobBudget): Promise<NotificationRow | null> {
      return transaction(CHAT_ROW_START_MAX_MS, async (tx) => {
        const row = await locked(tx, token.id);
        if (!row) return null;
        const now = clock();
        const updated = await tx.$queryRaw<NotificationRow[]>`
          UPDATE "ChatNotification" SET "requestStartedAt" = ${utc(now)},
            "attempts" = "attempts" + 1, "updatedAt" = ${utc(now)}
          WHERE "id" = ${token.id} AND "status" = 'SENDING'::"ChatNotificationStatus"
            AND "leaseOwner" = ${token.owner} AND "leaseVersion" = ${token.leaseVersion}
            AND "lockedUntil" > ${utc(now)} AND "requestStartedAt" IS NULL
            AND "attempts" < ${CHAT_NOTIFICATION_MAX_ATTEMPTS}
          RETURNING ${view}
        `;
        return updated[0] ?? null;
      }, within);
    },

    async finish(token: NotificationToken, outcome: NotificationOutcome): Promise<boolean> {
      return transaction(CHAT_ROW_FINISH_MAX_MS, async (tx) => {
        const row = await locked(tx, token.id);
        if (!row) return false;
        const now = clock();
        if (!valid(row, token, now) || row.requestStartedAt === null) return false;
        const cap = row.attempts >= CHAT_NOTIFICATION_MAX_ATTEMPTS;
        const status: Status = outcome.kind === 'sent' ? 'SENT'
          : outcome.kind === 'unknown' ? 'UNKNOWN'
            : outcome.kind === 'failed' || cap ? 'FAILED' : 'QUEUED';
        const reschedule = !cap && (status === 'QUEUED' || status === 'UNKNOWN');
        const available = reschedule ? Prisma.sql`"availableAt" = ${utc(new Date(now.getTime() + notificationBackoffMs(row.attempts, env)))},` : Prisma.empty;
        const error = outcome.kind === 'sent' ? null : notificationErrorCode(outcome.code);
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "ChatNotification" SET "status" = ${status}::"ChatNotificationStatus",
            ${available} "lastErrorCode" = ${error}, "providerMessageId" = NULL,
            "sentAt" = ${outcome.kind === 'sent' ? utc(now) : Prisma.sql`NULL`},
            "leaseOwner" = NULL, "lockedUntil" = NULL, "updatedAt" = ${utc(now)}
          WHERE "id" = ${token.id} AND "status" = 'SENDING'::"ChatNotificationStatus"
            AND "leaseOwner" = ${token.owner} AND "leaseVersion" = ${token.leaseVersion}
            AND "lockedUntil" > ${utc(now)} AND "requestStartedAt" IS NOT NULL
          RETURNING "id"
        `;
        return updated.length === 1;
      });
    },

    async recoverExpiredLease(discoveryAt: Date): Promise<number> {
      return transaction(CHAT_ROW_FINISH_MAX_MS, async (tx) => {
        const rows = await tx.$queryRaw<NotificationRow[]>`
          SELECT ${view} FROM "ChatNotification" WHERE "status" = 'SENDING'::"ChatNotificationStatus"
            AND "lockedUntil" <= ${utc(discoveryAt)}
          ORDER BY "id" LIMIT ${CHAT_NOTIFICATION_MAINTENANCE_LIMIT} FOR UPDATE
        `;
        if (rows.length === 0) return 0;
        const now = clock();
        let count = 0;
        for (const row of rows) {
          const started = row.requestStartedAt !== null;
          const cap = row.attempts >= CHAT_NOTIFICATION_MAX_ATTEMPTS;
          const status: Status = started ? 'UNKNOWN' : 'QUEUED';
          const next = !started ? now : cap ? null : new Date(now.getTime() + notificationBackoffMs(row.attempts, env));
          const available = next ? Prisma.sql`"availableAt" = ${utc(next)},` : Prisma.empty;
          count += await tx.$executeRaw`
            UPDATE "ChatNotification" SET "status" = ${status}::"ChatNotificationStatus",
              ${available} "leaseOwner" = NULL, "lockedUntil" = NULL,
              "lastErrorCode" = ${started ? 'CHAT_WORKER_UNKNOWN' : row.lastErrorCode}, "updatedAt" = ${utc(now)}
            WHERE "id" = ${row.id} AND "status" = 'SENDING'::"ChatNotificationStatus" AND "lockedUntil" <= ${utc(now)}
          `;
        }
        return count;
      });
    },

    async promoteUnknown(discoveryAt: Date): Promise<number> {
      return transaction(CHAT_ROW_FINISH_MAX_MS, async (tx) => {
        const ids = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "ChatNotification" WHERE "status" = 'UNKNOWN'::"ChatNotificationStatus"
            AND "attempts" < ${CHAT_NOTIFICATION_MAX_ATTEMPTS} AND "availableAt" <= ${utc(discoveryAt)}
          ORDER BY "id" LIMIT ${CHAT_NOTIFICATION_MAINTENANCE_LIMIT} FOR UPDATE
        `;
        if (ids.length === 0) return 0;
        const now = clock();
        return tx.$executeRaw`
          UPDATE "ChatNotification" SET "status" = 'QUEUED'::"ChatNotificationStatus", "updatedAt" = ${utc(now)}
          WHERE "id" IN (${Prisma.join(ids.map((x) => x.id))}) AND "status" = 'UNKNOWN'::"ChatNotificationStatus"
            AND "attempts" < ${CHAT_NOTIFICATION_MAX_ATTEMPTS} AND "availableAt" <= ${utc(now)}
        `;
      });
    },

    async disableNeverStartedQueued(): Promise<number> {
      return transaction(CHAT_ROW_FINISH_MAX_MS, async (tx) => {
        const ids = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "ChatNotification" WHERE "status" = 'QUEUED'::"ChatNotificationStatus"
            AND "attempts" = 0 AND "requestStartedAt" IS NULL
          ORDER BY "id" LIMIT ${CHAT_NOTIFICATION_MAINTENANCE_LIMIT} FOR UPDATE
        `;
        if (ids.length === 0) return 0;
        const now = clock();
        return tx.$executeRaw`
          UPDATE "ChatNotification" SET "status" = 'DISABLED'::"ChatNotificationStatus", "updatedAt" = ${utc(now)}
          WHERE "id" IN (${Prisma.join(ids.map((x) => x.id))}) AND "status" = 'QUEUED'::"ChatNotificationStatus"
            AND "attempts" = 0 AND "requestStartedAt" IS NULL
        `;
      });
    },

    /** Unlocked projection after pre-send; notification content never includes visitor body/email/token. */
    async loadContent(row: NotificationRow, within?: JobBudget): Promise<NotificationContent | null> {
      return transaction(CHAT_ROW_START_MAX_MS, async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const message = await tx.chatMessage.findUnique({
          where: { id: row.messageId },
          select: { conversationId: true, redactedAt: true, createdAt: true,
            conversation: { select: { id: true, locale: true, anonymizedAt: true } } },
        });
        if (!message || message.redactedAt !== null || message.conversation.anonymizedAt !== null
          || message.conversationId !== row.conversationId) return null;
        return { conversationId: message.conversation.id, locale: message.conversation.locale, receivedAt: message.createdAt };
      }, within);
    },
  };
}
export type NotificationRepo = ReturnType<typeof createNotificationRepo>;
export function notificationToken(row: NotificationRow): NotificationToken {
  if (!row.leaseOwner) throw new Error('chat_notification_token_invalid');
  return { id: row.id, owner: row.leaseOwner, leaseVersion: row.leaseVersion };
}
