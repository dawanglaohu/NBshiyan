import { Prisma, type AdminDeviceSession, type User } from '@prisma/client';
import type { ChatSummaryQuery } from '../../contracts/chat';

type QueryDb = Pick<Prisma.TransactionClient, '$queryRaw' | 'chatConversation' | 'chatMessage'>;

const conversationFields = {
  id: true,
  locale: true,
  productSlug: true,
  sourcePath: true,
  email: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  lastActivityAt: true,
  retainUntil: true,
  anonymizedAt: true,
  lastSeq: true,
} as const satisfies Prisma.ChatConversationSelect;

type ConversationRow = Prisma.ChatConversationGetPayload<{ select: typeof conversationFields }>;
export type InboxRow = ConversationRow & { lastReadSeq: number };
export type InboxKey = { updatedAt: Date; id: string };

function timestamp(date: Date) {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

export function createInboxRepo(db: QueryDb) {
  return {
    list: (userId: string, now: Date, query: ChatSummaryQuery, cursor?: InboxKey) =>
      db.$queryRaw<InboxRow[]>(Prisma.sql`
        SELECT c.id, c.locale, c."productSlug", c."sourcePath", c.email, c.status, c.version,
               c."createdAt", c."updatedAt", c."lastActivityAt", c."retainUntil", c."anonymizedAt",
               c."lastSeq", COALESCE(r."lastReadSeq", 0) AS "lastReadSeq"
        FROM "ChatConversation" c
        LEFT JOIN "ChatReadCursor" r ON r."conversationId" = c.id AND r."userId" = ${userId}
        WHERE c."anonymizedAt" IS NULL AND c."retainUntil" > ${timestamp(now)}
          ${query.status ? Prisma.sql`AND c.status = ${query.status}::"ChatConversationStatus"` : Prisma.empty}
          ${query.unreadOnly ? Prisma.sql`AND c."lastSeq" > COALESCE(r."lastReadSeq", 0)` : Prisma.empty}
          ${cursor ? Prisma.sql`AND (c."updatedAt", c.id) < (${timestamp(cursor.updatedAt)}, ${cursor.id})` : Prisma.empty}
        ORDER BY c."updatedAt" DESC, c.id DESC
        LIMIT ${query.limit + 1}
      `),

    async unreadTotal(userId: string, now: Date): Promise<number> {
      const [row] = await db.$queryRaw<{ total: number }[]>`
        SELECT COALESCE(SUM(c."lastSeq" - COALESCE(r."lastReadSeq", 0)), 0)::int AS total
        FROM "ChatConversation" c
        LEFT JOIN "ChatReadCursor" r ON r."conversationId" = c.id AND r."userId" = ${userId}
        WHERE c."anonymizedAt" IS NULL AND c."retainUntil" > ${timestamp(now)}
          AND c."lastSeq" > COALESCE(r."lastReadSeq", 0)
      `;
      return row!.total;
    },

    conversation: (id: string, userId: string, now: Date) => db.chatConversation.findFirst({
      where: { id, anonymizedAt: null, retainUntil: { gt: now } },
      select: {
        ...conversationFields,
        readCursors: { where: { userId }, select: { lastReadSeq: true } },
      },
    }),

    messages: (conversationId: string, afterSeq: number, lastSeq: number, limit: number) => db.chatMessage.findMany({
      where: { conversationId, seq: { gt: afterSeq, lte: lastSeq }, redactedAt: null },
      orderBy: { seq: 'asc' },
      take: limit,
      select: {
        id: true,
        seq: true,
        sender: true,
        bodyText: true,
        createdAt: true,
        notification: { select: { status: true } },
      },
    }),

    async lockOperator(userId: string, deviceId: string) {
      const [user] = await db.$queryRaw<User[]>`SELECT * FROM "User" WHERE id = ${userId} FOR SHARE`;
      const [device] = await db.$queryRaw<AdminDeviceSession[]>`
        SELECT * FROM "AdminDeviceSession" WHERE id = ${deviceId} FOR SHARE
      `;
      return { user: user ?? null, device: device ?? null };
    },

    async advanceRead(conversationId: string, userId: string, requested: number, now: Date) {
      const [row] = await db.$queryRaw<{ lastReadSeq: number }[]>`
        WITH retained AS (
          SELECT id, "lastSeq" FROM "ChatConversation"
          WHERE id = ${conversationId} AND "anonymizedAt" IS NULL AND "retainUntil" > ${timestamp(now)}
          FOR SHARE
        )
        INSERT INTO "ChatReadCursor" AS r ("conversationId", "userId", "lastReadSeq", "updatedAt")
        SELECT id, ${userId}, LEAST(${requested}::int, "lastSeq"), ${timestamp(now)} FROM retained
        ON CONFLICT ("conversationId", "userId") DO UPDATE
        SET "lastReadSeq" = GREATEST(r."lastReadSeq", EXCLUDED."lastReadSeq"),
            "updatedAt" = CASE WHEN EXCLUDED."lastReadSeq" > r."lastReadSeq"
                               THEN EXCLUDED."updatedAt" ELSE r."updatedAt" END
        RETURNING r."lastReadSeq"
      `;
      return row ?? null;
    },
  };
}
