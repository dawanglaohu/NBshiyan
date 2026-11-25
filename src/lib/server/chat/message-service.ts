import { randomUUID, timingSafeEqual } from 'node:crypto';
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

type WriteBudget = () => Promise<void>;

export function createChatWriteTransaction(db: ChatWriteDb) {
  const repo = createChatRepo(db);
  return function write<T>(run: (tx: ChatTx, arm: WriteBudget) => Promise<T>) {
    return db.$transaction(async (tx) => {
      const startedAt = performance.now();
      const arm = async () => {
        const remainingMs = Math.floor(CHAT_TX_BUDGET_MS - CHAT_TX_RESERVE_MS - (performance.now() - startedAt));
        if (remainingMs < CHAT_TX_MIN_MS) throw new ChatTransactionBudgetExceeded();
        await repo.setWriteTimeouts(tx, remainingMs);
      };
      return run(tx, arm);
    }, { isolationLevel: 'ReadCommitted', timeout: CHAT_TX_BUDGET_MS, maxWait: CHAT_TX_MAX_WAIT_MS });
  };
}

type MessageIdentity = {
  conversationId: string;
  sender: MessageReceivedDTO['message']['sender'];
  clientMessageId: string;
};

function messageRows(tx: ChatTx) {
  return {
    find: (identity: MessageIdentity) => tx.chatMessage.findUnique({
      where: { conversationId_sender_clientMessageId: identity },
    }),
    insert: (data: MessageIdentity & {
      id: string;
      seq: number;
      authorId: string | null;
      payloadHash: string;
      bodyText: string;
      createdAt: Date;
    }) => tx.chatMessage.create({ data }),
  };
}

export function assertConversationOpen(conversation: { status: 'OPEN' | 'CLOSED'; anonymizedAt: Date | null }) {
  if (conversation.anonymizedAt) throw new AppError('conversation_anonymized');
  if (conversation.status !== 'OPEN') throw new AppError('conversation_closed');
}

export function createMessageAppender(db: ChatWriteDb, clock: () => Date) {
  const repo = createChatRepo(db);

  /** Call with the conversation row locked after verifying that writes are allowed. */
  return async function appendMessage(tx: ChatTx, arm: WriteBudget, input: {
    conversationId: string;
    payload: ChatMessageRequest;
    payloadHash: string;
    authorId: string | null;
  }): Promise<MessageReceivedDTO> {
    const { conversationId, payload, payloadHash, authorId } = input;
    const sender = authorId === null ? 'VISITOR' : 'OPERATOR';
    const identity = { conversationId, sender, clientMessageId: payload.clientMessageId } as const;
    const rows = messageRows(tx);

    await arm();
    const existing = await rows.find(identity);
    if (existing) {
      const expected = Buffer.from(payloadHash, 'hex');
      const stored = Buffer.from(existing.payloadHash, 'hex');
      if (existing.authorId !== authorId || stored.length !== expected.length || !timingSafeEqual(stored, expected)) {
        throw new AppError('idempotency_conflict', {
          fieldErrors: { clientMessageId: 'This identifier was used for different content.' },
        });
      }
    }

    async function persistMessage() {
      const now = clock();
      await arm();
      const seq = await repo.allocateSeq(tx, { conversationId, now, retainUntil: chatRetainUntil(now) });
      await arm();
      const message = await rows.insert({
        ...identity, id: randomUUID(), seq, authorId, payloadHash, bodyText: payload.bodyText, createdAt: now,
      });
      if (sender === 'VISITOR') {
        await arm();
        await repo.insertNotification(tx, {
          id: randomUUID(), conversationId, messageId: message.id,
          stableMessageId: stableNotificationMessageId(message.id), availableAt: now, now,
        });
      }
      return message;
    }

    const stored = existing ?? await persistMessage();
    const receivedAt = stored.createdAt.toISOString();
    return {
      message: { id: stored.id, seq: stored.seq, sender, bodyText: stored.bodyText, createdAt: receivedAt },
      receivedAt,
      duplicate: existing !== null,
    };
  };
}

export function createMessageService({ db, clock = () => new Date() }: {
  db: ChatWriteDb;
  clock?: () => Date;
}): MessageService {
  const repo = createChatRepo(db);
  const write = createChatWriteTransaction(db);
  const append = createMessageAppender(db, clock);

  return {
    appendVisitorMessage({ session, conversationId, payload }) {
      return write(async (tx, arm) => {
        // Match the ownership check to the same row lock as sequence allocation and closure.
        await arm();
        const conversation = await repo.lockVisitorConversation(tx, conversationId, session.id);
        const sessionGuard = () => ({ tokenHash: session.tokenHash, now: clock(), idleMs: CHAT_VISITOR_POLICY.idleMs });
        await arm();
        await repo.assertSessionActive(tx, sessionGuard());
        if (!conversation) throw new AppError('not_found');
        assertConversationOpen(conversation);

        const payloadHash = firstMessagePayloadHash({
          ...payload,
          clientConversationId: conversation.clientConversationId,
          locale: conversation.locale,
        });
        const received = await append(tx, arm, { conversationId, payload, payloadHash, authorId: null });

        await arm();
        if (!(await repo.touchSession(tx, sessionGuard()))) throw new ChatSessionNoLongerValid();
        return received;
      });
    },
  };
}
