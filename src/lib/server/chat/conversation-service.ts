import { randomUUID } from 'node:crypto';
import type { ChatMessageDTO, ConversationCreateRequest, ConversationReceivedDTO } from '../../contracts/chat';
import {
  CHAT_TX_BUDGET_MS,
  CHAT_TX_MAX_WAIT_MS,
  CHAT_TX_MIN_MS,
  CHAT_TX_RESERVE_MS,
  chatRetainUntil,
  conversationCreatePayloadHash,
  firstMessagePayloadHash,
  stableNotificationMessageId,
} from '../../chat/rules';
import { CHAT_VISITOR_POLICY } from '../config';
import {
  ChatSessionNoLongerValid,
  ChatTransactionBudgetExceeded,
  createChatRepo,
  isUniqueViolation,
  type ChatMessageRow,
  type ChatRepo,
  type ChatWriteDb,
  type ChatTx,
} from './repo';
import type { ValidatedSession } from './visitor-session';

export { ChatSessionNoLongerValid, ChatTransactionBudgetExceeded };

/** 同一个幂等键配了不同载荷。路由层翻成 409 idempotency_conflict + fieldErrors。 */
export class ChatIdempotencyConflict extends Error {
  readonly field: 'clientConversationId' | 'clientMessageId';

  constructor(field: 'clientConversationId' | 'clientMessageId') {
    super('idempotency_conflict');
    this.name = 'ChatIdempotencyConflict';
    this.field = field;
  }
}

/** productSlug 不是已发布的产品上下文。路由层翻成 400 invalid + fieldErrors.productSlug。 */
export class ChatUnpublishedProduct extends Error {
  constructor() {
    super('unpublished_product');
    this.name = 'ChatUnpublishedProduct';
  }
}

/** 事务内按剩余预算重设语句/锁等待上限；每条可阻塞 SQL 前调用。 */
type Arm = () => Promise<void>;

export type ConversationService = {
  /**
   * 保存一次咨询的会话与首消息。
   *
   * 会话必须是 `resolve()` 产出的 ValidatedSession（必填、没有默认 no-op）；
   * 事务内先用同一份 tokenHash 再做一次新鲜度守卫（重放分支也经过它），
   * 写入或读到原结果后，用**同一事务**里的条件 touch 收尾：0 行 → 整笔回滚 → 401。
   * 因此不存在「提交后才 touch」的窗口，失败请求也不会推进闲置期限（C3 / Jev C）。
   */
  createFirstMessage(input: {
    session: ValidatedSession;
    payload: ConversationCreateRequest;
  }): Promise<ConversationReceivedDTO>;
};

function messageDto(row: Pick<ChatMessageRow, 'id' | 'seq' | 'sender' | 'bodyText' | 'createdAt'>): ChatMessageDTO {
  return {
    id: row.id,
    seq: row.seq,
    sender: row.sender,
    bodyText: row.bodyText,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createConversationService(deps: {
  db: ChatWriteDb;
  clock?: () => Date;
  newId?: () => string;
  repo?: ChatRepo;
}): ConversationService {
  const clock = deps.clock ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const repo = deps.repo ?? createChatRepo(deps.db);

  async function readExisting(
    tx: ChatTx,
    visitorSessionId: string,
    payload: ConversationCreateRequest,
    createHash: string,
    messageHash: string,
    arm: Arm,
  ): Promise<ConversationReceivedDTO | null> {
    await arm();
    const conversation = await repo.findConversation(tx, visitorSessionId, payload.clientConversationId);
    if (!conversation) return null;
    if (conversation.createPayloadHash !== createHash) {
      throw new ChatIdempotencyConflict('clientConversationId');
    }
    await arm();
    const message = await repo.findVisitorMessage(tx, conversation.id, payload.clientMessageId);
    if (!message) {
      // 会话已存在但没有这条首消息：同一 clientConversationId 下换了 clientMessageId，按冲突处理，
      // 不静默追加第二条「首消息」。
      throw new ChatIdempotencyConflict('clientMessageId');
    }
    if (message.payloadHash !== messageHash) {
      throw new ChatIdempotencyConflict('clientMessageId');
    }
    return {
      conversationId: conversation.id,
      message: messageDto(message),
      receivedAt: message.createdAt.toISOString(),
      duplicate: true,
    };
  }

  return {
    async createFirstMessage({ session, payload }) {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('chat clock');
      const createHash = conversationCreatePayloadHash(payload);
      const messageHash = firstMessagePayloadHash(payload);

      let lastUniqueError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await deps.db.$transaction(
            async (tx) => {
              const startedAt = performance.now();
              // 剩余预算按单调时钟计算；reserve 留给回滚与响应，绝不放宽 5s 契约。
              const arm: Arm = async () => {
                const remaining = CHAT_TX_BUDGET_MS - (performance.now() - startedAt) - CHAT_TX_RESERVE_MS;
                const ms = Math.floor(remaining);
                if (ms < CHAT_TX_MIN_MS) throw new ChatTransactionBudgetExceeded();
                await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
                await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${ms}`);
              };
              const fresh = () => clock();

              // 守卫在 readExisting 之前：幂等重放也必须通过，且用调用时刻的新鲜时间。
              await arm();
              await repo.assertSessionActive(tx, {
                tokenHash: session.tokenHash,
                now: fresh(),
                idleMs: CHAT_VISITOR_POLICY.idleMs,
              });

              const existing = await readExisting(tx, session.id, payload, createHash, messageHash, arm);
              const outcome = existing ?? (await (async (): Promise<ConversationReceivedDTO> => {
                if (payload.productSlug) {
                  await arm();
                  if (!(await repo.isPublishedProduct(tx, payload.productSlug))) throw new ChatUnpublishedProduct();
                }

                const conversationId = newId();
                const retainUntil = chatRetainUntil(now);
                await arm();
                await repo.insertConversation(tx, {
                  id: conversationId,
                  visitorSessionId: session.id,
                  clientConversationId: payload.clientConversationId,
                  createPayloadHash: createHash,
                  locale: payload.locale,
                  productSlug: payload.productSlug ?? null,
                  sourcePath: payload.sourcePath ?? null,
                  email: payload.email ?? null,
                  now,
                  retainUntil,
                });

                await arm();
                const seq = await repo.allocateSeq(tx, { conversationId, now, retainUntil });
                const messageId = newId();
                await arm();
                await repo.insertMessage(tx, {
                  id: messageId,
                  conversationId,
                  seq,
                  clientMessageId: payload.clientMessageId,
                  payloadHash: messageHash,
                  bodyText: payload.bodyText,
                  createdAt: now,
                });
                await arm();
                await repo.insertNotification(tx, {
                  id: newId(),
                  conversationId,
                  messageId,
                  stableMessageId: stableNotificationMessageId(messageId),
                  availableAt: now,
                  now,
                });

                return {
                  conversationId,
                  message: messageDto({ id: messageId, seq, sender: 'VISITOR', bodyText: payload.bodyText, createdAt: now }),
                  receivedAt: now.toISOString(),
                  duplicate: false,
                };
              })());

              // 同一事务里的最终条件 touch：新建与重放都走；0 行 → 整笔回滚 → 401。
              await arm();
              const touched = await repo.touchSession(tx, {
                tokenHash: session.tokenHash,
                now: fresh(),
                idleMs: CHAT_VISITOR_POLICY.idleMs,
              });
              if (!touched) throw new ChatSessionNoLongerValid();

              return outcome;
            },
            { timeout: CHAT_TX_BUDGET_MS, maxWait: CHAT_TX_MAX_WAIT_MS },
          );
        } catch (error) {
          if (error instanceof ChatIdempotencyConflict) throw error;
          // 唯一约束说明并发的同名请求先提交了；开新事务重读，返回它的结果。
          if (attempt === 0 && isUniqueViolation(error)) {
            lastUniqueError = error;
            continue;
          }
          throw error;
        }
      }
      throw lastUniqueError instanceof Error ? lastUniqueError : new Error('chat conversation conflict');
    },
  };
}
