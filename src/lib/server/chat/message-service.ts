import { randomUUID } from 'node:crypto';
import type { ChatMessageRequest, MessageReceivedDTO } from '../../contracts/chat';
import {
  CHAT_TX_BUDGET_MS,
  CHAT_TX_MAX_WAIT_MS,
  CHAT_TX_MIN_MS,
  CHAT_TX_RESERVE_MS,
  chatRetainUntil,
  firstMessagePayloadHash,
  stableNotificationMessageId,
} from '../../chat/rules';
import { CHAT_VISITOR_POLICY } from '../config';
import { AppError } from '../http/errors';
import {
  ChatSessionNoLongerValid,
  ChatTransactionBudgetExceeded,
  createChatRepo,
  type ChatTx,
  type ChatWriteDb,
} from './repo';
import type { ValidatedSession } from './visitor-session';

export type MessageService = {
  /** Returns the committed visitor receipt. Replays can refresh session activity but never renew consultation retention. */
  appendVisitorMessage(input: {
    session: ValidatedSession;
    conversationId: string;
    payload: ChatMessageRequest;
  }): Promise<MessageReceivedDTO>;
};

export function createMessageService({ db, clock = () => new Date() }: {
  db: ChatWriteDb;
  clock?: () => Date;
}): MessageService {
  const repo = createChatRepo(db);

  return {
    appendVisitorMessage({ session, conversationId, payload }) {
      return db.$transaction(async (tx) => {
        const startedAt = performance.now();
        const arm = async () => {
          const remainingMs = Math.floor(CHAT_TX_BUDGET_MS - CHAT_TX_RESERVE_MS - (performance.now() - startedAt));
          if (remainingMs < CHAT_TX_MIN_MS) throw new ChatTransactionBudgetExceeded();
          await repo.setWriteTimeouts(tx, remainingMs);
        };

        // Check ownership and state under the same lock used by sequence allocation and status writes.
        await arm();
        const conversation = await repo.lockVisitorConversation(tx, conversationId, session.id);
        const sessionGuard = () => ({ tokenHash: session.tokenHash, now: clock(), idleMs: CHAT_VISITOR_POLICY.idleMs });
        await arm();
        await repo.assertSessionActive(tx, sessionGuard());
        if (!conversation) throw new AppError('not_found');
        if (conversation.anonymizedAt) throw new AppError('conversation_anonymized');
        if (conversation.status !== 'OPEN') throw new AppError('conversation_closed');

        const payloadHash = firstMessagePayloadHash({
          ...payload,
          clientConversationId: conversation.clientConversationId,
          locale: conversation.locale,
        });
        await arm();
        const existing = await repo.findVisitorMessage(tx, conversationId, payload.clientMessageId);
        if (existing && existing.payloadHash !== payloadHash) {
          throw new AppError('idempotency_conflict', {
            fieldErrors: { clientMessageId: 'This identifier was used for different content.' },
          });
        }

        async function persistMessage(tx: ChatTx) {
          const now = clock();
          await arm();
          const seq = await repo.allocateSeq(tx, { conversationId, now, retainUntil: chatRetainUntil(now) });
          const message = {
            id: randomUUID(), conversationId, seq, clientMessageId: payload.clientMessageId,
            payloadHash, bodyText: payload.bodyText, createdAt: now,
          };
          await arm();
          await repo.insertMessage(tx, message);
          await arm();
          await repo.insertNotification(tx, {
            id: randomUUID(), conversationId, messageId: message.id,
            stableMessageId: stableNotificationMessageId(message.id), availableAt: now, now,
          });
          return message;
        }

        const stored = existing ?? await persistMessage(tx);
        await arm();
        if (!(await repo.touchSession(tx, sessionGuard()))) throw new ChatSessionNoLongerValid();

        const receivedAt = stored.createdAt.toISOString();
        return {
          message: { id: stored.id, seq: stored.seq, sender: 'VISITOR', bodyText: stored.bodyText, createdAt: receivedAt },
          receivedAt,
          duplicate: existing !== null,
        };
      }, { isolationLevel: 'ReadCommitted', timeout: CHAT_TX_BUDGET_MS, maxWait: CHAT_TX_MAX_WAIT_MS });
    },
  };
}
