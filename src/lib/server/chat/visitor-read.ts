import type { ChatConversationDTO, ChatSyncDTO, ReadDTO } from '../../contracts/chat';
import { ChatSequenceGap, consecutivePage, nextVisitorReadSeq, pageStartSeq } from './read-cursor';
import { createChatReadRepo, type ChatConversationViewRow, type ChatReadDb, type ChatReadRepo } from './repo';
import type { ValidatedSession } from './visitor-session';

/**
 * 10 节:121 同步桶：每访客 cookie 60 次/分钟。GET 轮询与 read 共用这一桶，
 * 与「聊天写 20 条/分钟」分开计数，避免轮询挤掉发消息的配额。
 */
export const CHAT_SYNC_COOKIE_LIMIT = 60;
export const CHAT_SYNC_WINDOW_MS = 60_000;
export const CHAT_SYNC_RETRY_AFTER_SECONDS = 60;
export const CHAT_SYNC_RATE_PREFIX = 'chat:sync:cookie:';

export type VisitorReadOutcome<T> = { kind: 'ok'; value: T } | { kind: 'not_found' };

export type VisitorReadService = {
  /**
   * 读取本人会话的一页消息。
   *
   * 只读：不 touch 访客会话（闲置期限不被轮询续命）、不推进访客读位置
   * （E-79：轮询只更新已确认收件游标，不冒充用户已读）。
   */
  getSync(input: {
    session: ValidatedSession;
    conversationId: string;
    afterSeq: number;
    limit: number;
  }): Promise<VisitorReadOutcome<ChatSyncDTO>>;

  /** 单调推进本人访客读位置；MAX + 夹到 lastSeq，乱序/重试不回退、不越界。 */
  markRead(input: {
    session: ValidatedSession;
    conversationId: string;
    lastReadSeq: number;
  }): Promise<VisitorReadOutcome<ReadDTO>>;
};

function conversationDto(row: ChatConversationViewRow): ChatConversationDTO {
  return {
    id: row.id,
    // 库里只有已发布 locale；DTO 的枚举收窄在这里显式对齐，避免把数据库字符串原样透出。
    locale: row.locale as ChatConversationDTO['locale'],
    productSlug: row.productSlug,
    sourcePath: row.sourcePath,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    retainUntil: row.retainUntil.toISOString(),
    anonymizedAt: row.anonymizedAt ? row.anonymizedAt.toISOString() : null,
  };
}

export function createVisitorReadService(deps: { db?: ChatReadDb; repo?: ChatReadRepo }): VisitorReadService {
  const repo = deps.repo ?? (deps.db ? createChatReadRepo(deps.db) : null);
  if (!repo) throw new Error('chat read repo');

  return {
    async getSync({ session, conversationId, afterSeq, limit }) {
      const conversation = await repo.findOwnedConversation(conversationId, session.id);
      if (!conversation) return { kind: 'not_found' };

      const start = pageStartSeq(afterSeq, conversation.lastSeq);
      const rows = await repo.listMessages(conversationId, start, limit);
      // seq 由会话行锁连续分配；这里读到空页但 lastSeq 还在前面，说明数据缺号。
      // 宁可整体失败，也不返回「已收齐」或跳过缺号（E-77 / E-79）。
      if (rows.length === 0 && start < conversation.lastSeq) throw new ChatSequenceGap();

      const page = consecutivePage(rows, start, conversation.lastSeq);
      return {
        kind: 'ok',
        value: {
          conversation: conversationDto(conversation),
          messages: page.messages.map((message) => ({
            id: message.id,
            seq: message.seq,
            sender: message.sender,
            bodyText: message.bodyText,
            createdAt: message.createdAt.toISOString(),
          })),
          lastSeq: conversation.lastSeq,
          nextAfterSeq: page.nextAfterSeq,
          hasMore: page.hasMore,
          read: { lastReadSeq: Math.min(conversation.visitorReadSeq, conversation.lastSeq) },
        },
      };
    },

    async markRead({ session, conversationId, lastReadSeq }) {
      const conversation = await repo.findOwnedConversation(conversationId, session.id);
      if (!conversation) return { kind: 'not_found' };

      const target = nextVisitorReadSeq(conversation.visitorReadSeq, lastReadSeq, conversation.lastSeq);
      // 已经在前方或正好相等时不写库：read 是幂等的，不需要为同一位置制造一次 UPDATE。
      if (target === conversation.visitorReadSeq) return { kind: 'ok', value: { lastReadSeq: target } };

      const stored = await repo.advanceVisitorRead(conversationId, session.id, lastReadSeq);
      if (stored === null) return { kind: 'not_found' };
      return { kind: 'ok', value: { lastReadSeq: stored } };
    },
  };
}
