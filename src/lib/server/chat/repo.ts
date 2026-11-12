import { Prisma, type PrismaClient } from '@prisma/client';
import { products } from '../../../data/products';
import { visitorSessionTouchSql } from './visitor-session-repo';

/** 会话在事务内已经不满足期限/撤销条件：整笔回滚，路由返回 401。 */
export class ChatSessionNoLongerValid extends Error {
  constructor() {
    super('chat_session_invalid');
    this.name = 'ChatSessionNoLongerValid';
  }
}

/** 事务剩余预算不足，主动放弃而不是让慢语句拖过 5s。路由返回 503。 */
export class ChatTransactionBudgetExceeded extends Error {
  constructor() {
    super('chat_transaction_budget_exceeded');
    this.name = 'ChatTransactionBudgetExceeded';
  }
}

/**
 * 「数据库不可用或超时」的保守分类，只认确定的类别：
 * - 连接初始化/不可达/连接池超时：PrismaClientInitializationError/RustPanicError 与 P1001/P1002/P1008/P1017/P2024；
 * - 事务超时 P2028；
 * - 服务端 statement_timeout 取消语句：P2010 + SQLSTATE 57014；
 * - 明确的网络错误码（连接被拒/重置/超时/解析失败）。
 *
 * 不按 message 关键词匹配，也不把全部 P2010 归进来——触发器 RAISE EXCEPTION 等数据层错误
 * 仍是未知失败（500），不是 503。这里刻意不 import designs（它会在模块加载时创建 Prisma 客户端，
 * 测试需要在设置 DATABASE_URL 之后再导入路由）。
 */
const DB_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);
const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const shaped = error as { name?: unknown; code?: unknown; errorCode?: unknown; meta?: { code?: unknown }; cause?: unknown };
  if (shaped.name === 'PrismaClientInitializationError' || shaped.name === 'PrismaClientRustPanicError') return true;
  for (const code of [shaped.code, shaped.errorCode]) {
    if (typeof code === 'string' && (DB_UNAVAILABLE_CODES.has(code) || NET_CODES.has(code))) return true;
  }
  if (shaped.code === 'P2010' && shaped.meta?.code === '57014') return true;
  return shaped.cause !== error && isDatabaseUnavailable(shaped.cause);
}

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

    /**
     * 事务内的会话守卫（在 readExisting 之前执行，重放路径也不能绕过）。
     * 用调用时的新鲜 now 比较期限，不看事务开始时间。
     */
    async assertSessionActive(tx: ChatTx, args: {
      tokenHash: string;
      now: Date;
      idleMs: number;
    }): Promise<void> {
      const cutoff = new Date(args.now.getTime() - args.idleMs);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ChatVisitorSession"
        WHERE "tokenHash" = ${args.tokenHash}
          AND "revokedAt" IS NULL
          AND "absoluteExpiresAt" > ${utc(args.now)}
          AND "lastActivityAt" > ${utc(cutoff)}
      `;
      if (rows.length !== 1) throw new ChatSessionNoLongerValid();
    },

    /**
     * 事务内最后一次条件 touch：与写入同提交，0 行即整笔回滚（Jev C）。
     * 时间取调用时刻，不把事务开始时间当最终有效性检查时间。
     */
    async touchSession(tx: ChatTx, args: {
      tokenHash: string;
      now: Date;
      idleMs: number;
    }): Promise<boolean> {
      const rows = await tx.$queryRaw<{ id: string }[]>(
        visitorSessionTouchSql(args.tokenHash, args.now, args.idleMs),
      );
      return Array.isArray(rows) && rows.length === 1;
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

// ---------------------------------------------------------------------------
// 访客读取面（M4-T2）
//
// GET 同步与 read 都只按访客 cookie 范围读/写自己那张会话，走独立只读库面：
// GET 不产生任何写操作（不 touch 会话、不推进读位置），read 只有一条夹逼 UPDATE。
// ---------------------------------------------------------------------------

/** 读取面只用到会话/消息模型与一条带 RETURNING 的原生 UPDATE。 */
export type ChatReadDb = Pick<PrismaClient, 'chatConversation' | 'chatMessage' | '$queryRaw'>;

export type ChatConversationViewRow = {
  id: string;
  locale: string;
  productSlug: string | null;
  sourcePath: string | null;
  status: 'OPEN' | 'CLOSED';
  version: number;
  lastSeq: number;
  visitorReadSeq: number;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  retainUntil: Date;
  anonymizedAt: Date | null;
};

export type ChatMessagePageRow = Pick<ChatMessageRow, 'id' | 'seq' | 'sender' | 'bodyText' | 'createdAt'>;

export function createChatReadRepo(db: ChatReadDb) {
  return {
    /** 只按 (conversationId, visitorSessionId) 取；不属于本 cookie 的会话一律查不到（E-19）。 */
    async findOwnedConversation(
      conversationId: string,
      visitorSessionId: string,
    ): Promise<ChatConversationViewRow | null> {
      return db.chatConversation.findFirst({
        where: { id: conversationId, visitorSessionId },
        select: {
          id: true,
          locale: true,
          productSlug: true,
          sourcePath: true,
          status: true,
          version: true,
          lastSeq: true,
          visitorReadSeq: true,
          createdAt: true,
          updatedAt: true,
          lastActivityAt: true,
          retainUntil: true,
          anonymizedAt: true,
        },
      });
    },

    async listMessages(
      conversationId: string,
      afterSeq: number,
      take: number,
    ): Promise<ChatMessagePageRow[]> {
      return db.chatMessage.findMany({
        where: { conversationId, seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
        take,
        select: { id: true, seq: true, sender: true, bodyText: true, createdAt: true },
      });
    },

    /**
     * read 采用 MAX：单条 UPDATE 内 GREATEST 保证不回退、LEAST 保证不越过 lastSeq。
     * 行锁让并发/乱序请求串行到同一结果；返回最终落库的 visitorReadSeq，0 行说明会话已不在本 cookie 范围。
     */
    async advanceVisitorRead(
      conversationId: string,
      visitorSessionId: string,
      requested: number,
    ): Promise<number | null> {
      const rows = await db.$queryRaw<{ visitorReadSeq: number }[]>`
        UPDATE "ChatConversation"
        SET "visitorReadSeq" = LEAST(GREATEST("visitorReadSeq", ${requested}), "lastSeq")
        WHERE "id" = ${conversationId} AND "visitorSessionId" = ${visitorSessionId}
        RETURNING "visitorReadSeq"
      `;
      const value = rows[0]?.visitorReadSeq;
      return typeof value === 'number' && Number.isInteger(value) ? value : null;
    },
  };
}

export type ChatReadRepo = ReturnType<typeof createChatReadRepo>;
