import { Prisma, type PrismaClient } from '@prisma/client';
import { products } from '../../../data/products';

/** 目录产品的内部 key，与分析事件使用同一份来源；这些 slug 直接算已发布上下文。 */
const CATALOG_PRODUCT_SLUGS: ReadonlySet<string> = new Set(products.map((product) => product.slug));

/**
 * 聊天写入的数据库原语。全部方法接收调用方已经开启的事务 `tx`，
 * 由服务层把「会话 + 首消息 + seq + 通知」放进同一个事务，仓储自己不提交。
 */
export type ChatTx = Prisma.TransactionClient;
export type ChatWriteDb = Pick<PrismaClient, '$transaction'>;

/** 与 event-repo / rollup / aggregate-repo 相同：ISO 字符串再按 UTC 写入 timestamp，避免会话时区平移。 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

export type ChatConversationRow = {
  id: string;
  visitorSessionId: string;
  clientConversationId: string;
  createPayloadHash: string;
  status: 'OPEN' | 'CLOSED';
  lastSeq: number;
};

export type ChatMessageRow = {
  id: string;
  conversationId: string;
  seq: number;
  sender: 'VISITOR' | 'OPERATOR';
  clientMessageId: string;
  payloadHash: string;
  bodyText: string;
  createdAt: Date;
};

/** PostgreSQL 唯一约束冲突。Prisma 对 `$executeRaw` 报 P2010 + SQLSTATE 23505，对模型调用报 P2002。 */
export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return true;
    if (error.code === 'P2010') {
      const meta = error.meta as { code?: string } | undefined;
      return meta?.code === '23505';
    }
  }
  const shaped = error as { code?: unknown; meta?: { code?: unknown } } | null;
  return shaped?.code === 'P2002' || (shaped?.code === 'P2010' && shaped?.meta?.code === '23505');
}

export function createChatRepo(db: ChatWriteDb) {
  return {
    /** 同一个访客会话 + 客户端会话 UUID 是否已经建过。唯一键 (visitorSessionId, clientConversationId)。 */
    async findConversation(
      tx: ChatTx,
      visitorSessionId: string,
      clientConversationId: string,
    ): Promise<ChatConversationRow | null> {
      const rows = await tx.$queryRaw<ChatConversationRow[]>`
        SELECT "id", "visitorSessionId", "clientConversationId", "createPayloadHash",
               "status"::text AS "status", "lastSeq"
        FROM "ChatConversation"
        WHERE "visitorSessionId" = ${visitorSessionId}
          AND "clientConversationId" = ${clientConversationId}
      `;
      return rows[0] ?? null;
    },

    async insertConversation(tx: ChatTx, row: {
      id: string;
      visitorSessionId: string;
      clientConversationId: string;
      createPayloadHash: string;
      locale: string;
      productSlug: string | null;
      sourcePath: string | null;
      email: string | null;
      now: Date;
      retainUntil: Date;
    }): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO "ChatConversation" (
          "id", "visitorSessionId", "clientConversationId", "createPayloadHash", "locale",
          "productSlug", "sourcePath", "email", "status", "version", "lastSeq", "visitorReadSeq",
          "createdAt", "updatedAt", "lastActivityAt", "retainUntil", "anonymizedAt"
        ) VALUES (
          ${row.id},
          ${row.visitorSessionId},
          ${row.clientConversationId},
          ${row.createPayloadHash},
          ${row.locale},
          ${row.productSlug},
          ${row.sourcePath},
          ${row.email},
          ${'OPEN'}::"ChatConversationStatus",
          ${0},
          ${0},
          ${0},
          ${utc(row.now)},
          ${utc(row.now)},
          ${utc(row.now)},
          ${utc(row.retainUntil)},
          ${null}
        )
      `;
    },

    /**
     * 在会话行上递增 lastSeq 并同时推进活动时间与保留截止，返回本次分配的 seq。
     * 单条 UPDATE 拿行锁，同一会话的并发写入在这里串行。
     */
    async allocateSeq(tx: ChatTx, args: {
      conversationId: string;
      now: Date;
      retainUntil: Date;
    }): Promise<number> {
      const rows = await tx.$queryRaw<{ lastSeq: number }[]>`
        UPDATE "ChatConversation"
        SET "lastSeq" = "lastSeq" + 1,
            "updatedAt" = ${utc(args.now)},
            "lastActivityAt" = ${utc(args.now)},
            "retainUntil" = ${utc(args.retainUntil)}
        WHERE "id" = ${args.conversationId}
        RETURNING "lastSeq"
      `;
      const seq = rows[0]?.lastSeq;
      if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
        throw new Error('chat conversation missing');
      }
      return seq;
    },

    async findVisitorMessage(
      tx: ChatTx,
      conversationId: string,
      clientMessageId: string,
    ): Promise<ChatMessageRow | null> {
      const rows = await tx.$queryRaw<ChatMessageRow[]>`
        SELECT "id", "conversationId", "seq", "sender"::text AS "sender", "clientMessageId",
               "payloadHash", "bodyText", "createdAt"
        FROM "ChatMessage"
        WHERE "conversationId" = ${conversationId}
          AND "sender" = ${'VISITOR'}::"ChatSender"
          AND "clientMessageId" = ${clientMessageId}
      `;
      return rows[0] ?? null;
    },

    async insertMessage(tx: ChatTx, row: {
      id: string;
      conversationId: string;
      seq: number;
      clientMessageId: string;
      payloadHash: string;
      bodyText: string;
      createdAt: Date;
    }): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO "ChatMessage" (
          "id", "conversationId", "seq", "sender", "authorId", "clientMessageId",
          "payloadHash", "bodyText", "createdAt", "redactedAt"
        ) VALUES (
          ${row.id},
          ${row.conversationId},
          ${row.seq},
          ${'VISITOR'}::"ChatSender",
          ${null},
          ${row.clientMessageId},
          ${row.payloadHash},
          ${row.bodyText},
          ${utc(row.createdAt)},
          ${null}
        )
      `;
    },

    /**
     * 出箱记录与消息同事务写入。messageId 上的唯一约束保证消息幂等命中不会出现第二条通知；
     * 通知行只放投递状态与稳定 Message-ID，不复制正文、email 或 token。
     */
    async insertNotification(tx: ChatTx, row: {
      id: string;
      conversationId: string;
      messageId: string;
      stableMessageId: string;
      availableAt: Date;
      now: Date;
    }): Promise<void> {
      await tx.$executeRaw`
        INSERT INTO "ChatNotification" (
          "id", "conversationId", "messageId", "status", "attempts", "availableAt",
          "leaseVersion", "leaseOwner", "stableMessageId", "lockedUntil", "requestStartedAt",
          "lastErrorCode", "providerMessageId", "sentAt", "createdAt", "updatedAt"
        ) VALUES (
          ${row.id},
          ${row.conversationId},
          ${row.messageId},
          ${'QUEUED'}::"ChatNotificationStatus",
          ${0},
          ${utc(row.availableAt)},
          ${0},
          ${null},
          ${row.stableMessageId},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${utc(row.now)},
          ${utc(row.now)}
        )
      `;
    },

    /**
     * productSlug 必须指向已发布的产品上下文（10 节：不允许从未发布模型推产品成功）。
     * 目录内部 key 直接放行；其余须是已发布且 READY 的 Model3D 目录项。
     */
    async isPublishedProduct(tx: ChatTx, slug: string): Promise<boolean> {
      if (CATALOG_PRODUCT_SLUGS.has(slug)) return true;
      const rows = await tx.$queryRaw<{ category: string }[]>`
        SELECT "category" FROM "Model3D"
        WHERE "category" = ${slug} AND "published" = true AND "status" = ${'READY'}::"ModelStatus"
        LIMIT 1
      `;
      return rows.length > 0;
    },

    async countNotifications(tx: ChatTx, messageId: string): Promise<number> {
      const rows = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS "count" FROM "ChatNotification" WHERE "messageId" = ${messageId}
      `;
      return Number(rows[0]?.count ?? 0);
    },
  };
}

export type ChatRepo = ReturnType<typeof createChatRepo>;
