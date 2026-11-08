import { randomUUID } from 'node:crypto';
import type { ChatMessageDTO, ConversationCreateRequest, ConversationReceivedDTO } from '../../contracts/chat';
import {
  chatRetainUntil,
  conversationCreatePayloadHash,
  firstMessagePayloadHash,
  stableNotificationMessageId,
} from '../../chat/rules';
import { createChatRepo, isUniqueViolation, type ChatMessageRow, type ChatRepo, type ChatWriteDb } from './repo';

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

export type ConversationService = {  /**
   * 保存一次咨询的会话与首消息。
   *
   * 一个事务里做四件事：建会话（lastSeq=0）、在会话行上递增分配 seq、插入访客消息、
   * 插入 messageId 唯一的通知出箱。任何一步失败都整笔回滚，不会留下半个会话或没有出箱的消息。
   *
   * 幂等：同 visitorSessionId + clientConversationId 命中既有会话时，比对创建载荷哈希；
   * 相同则返回原会话与原消息（duplicate=true），不同抛 ChatIdempotencyConflict。
   * 并发同名请求由唯一约束兜底：先到的提交，后到的撞约束后在新事务里重读，返回同样结果。
   */
  createFirstMessage(input: {
    visitorSessionId: string;
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
    tx: Parameters<ChatRepo['findConversation']>[0],
    visitorSessionId: string,
    payload: ConversationCreateRequest,
    createHash: string,
    messageHash: string,
  ): Promise<ConversationReceivedDTO | null> {
    const conversation = await repo.findConversation(tx, visitorSessionId, payload.clientConversationId);
    if (!conversation) return null;
    if (conversation.createPayloadHash !== createHash) {
      throw new ChatIdempotencyConflict('clientConversationId');
    }
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
    async createFirstMessage({ visitorSessionId, payload }) {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('chat clock');
      const createHash = conversationCreatePayloadHash(payload);
      const messageHash = firstMessagePayloadHash(payload);

      let lastUniqueError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await deps.db.$transaction(async (tx) => {
            const existing = await readExisting(tx, visitorSessionId, payload, createHash, messageHash);
            if (existing) return existing;

            if (payload.productSlug && !(await repo.isPublishedProduct(tx, payload.productSlug))) {
              throw new ChatUnpublishedProduct();
            }

            const conversationId = newId();
            const retainUntil = chatRetainUntil(now);
            await repo.insertConversation(tx, {
              id: conversationId,
              visitorSessionId,
              clientConversationId: payload.clientConversationId,
              createPayloadHash: createHash,
              locale: payload.locale,
              productSlug: payload.productSlug ?? null,
              sourcePath: payload.sourcePath ?? null,
              email: payload.email ?? null,
              now,
              retainUntil,
            });

            const seq = await repo.allocateSeq(tx, { conversationId, now, retainUntil });
            const messageId = newId();
            await repo.insertMessage(tx, {
              id: messageId,
              conversationId,
              seq,
              clientMessageId: payload.clientMessageId,
              payloadHash: messageHash,
              bodyText: payload.bodyText,
              createdAt: now,
            });
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
          });
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
