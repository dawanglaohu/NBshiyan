import { createHmac } from 'node:crypto';
import type { ChatMessageRequest, ChatStatusDTO, ChatStatusRequest } from '../../contracts/chat';
import { decideAdminAccess, type BoundAccess } from '../admin/device-session';
import { ADMIN_SESSION_POLICY } from '../config';
import { AppError } from '../http/errors';
import { createInboxRepo } from './inbox-repo';
import { assertConversationOpen, createChatWriteTransaction, createMessageAppender } from './message-service';
import { CHAT_OPERATOR_ROLES } from './operator-read';
import { createChatRepo, type ChatTx, type ChatWriteDb, type OperatorConversationForWrite } from './repo';

type OperatorAccess = Pick<Extract<BoundAccess, { ok: true }>, 'user' | 'device'>;

export function createOperatorWriteService({ db, clock, replyHashSecret }: {
  db: ChatWriteDb;
  clock: () => Date;
  replyHashSecret: Buffer | null;
}) {
  const repo = createChatRepo(db);
  const write = createChatWriteTransaction(db);
  const append = createMessageAppender(db, clock);
  const hashKey = replyHashSecret && createHmac('sha256', replyHashSecret).update('chat:operator-reply:v1').digest();

  function writeConversation<T>(
    operator: OperatorAccess,
    id: string,
    run: (input: {
      tx: ChatTx;
      arm: () => Promise<void>;
      conversation: OperatorConversationForWrite;
      authorId: string;
      now: Date;
    }) => Promise<T>,
  ) {
    return write(async (tx, arm) => {
      // Keep User → Device → Conversation order with the operator read-cursor transaction.
      await arm();
      const { user, device } = await createInboxRepo(tx).lockOperator(operator.user.id, operator.device.id);
      await arm();
      const conversation = await repo.lockOperatorConversation(tx, id);

      const now = clock();
      const access = decideAdminAccess({
        userId: operator.user.id,
        sid: operator.device.id,
        sessionVersion: operator.user.sessionVersion,
        user,
        device,
        roles: CHAT_OPERATOR_ROLES,
        now,
        policy: ADMIN_SESSION_POLICY,
      });
      if (!access.ok) {
        if (access.reason === 'disabled') throw new AppError('account_disabled');
        throw new AppError(access.reason === 'forbidden' ? 'forbidden' : 'unauthorized');
      }
      if (!conversation) throw new AppError('not_found');
      if (conversation.anonymizedAt) throw new AppError('conversation_anonymized');
      if (conversation.retainUntil <= now) throw new AppError('not_found');

      const result = await run({ tx, arm, conversation, authorId: access.user.id, now });
      if (clock() >= access.bounds.effectiveExpiresAt) throw new AppError('unauthorized');
      return result;
    });
  }

  return {
    reply(operator: OperatorAccess, conversationId: string, payload: ChatMessageRequest) {
      return writeConversation(operator, conversationId, async ({ tx, arm, conversation, authorId }) => {
        assertConversationOpen(conversation);
        if (!hashKey) throw new AppError('service_unavailable');
        const payloadHash = createHmac('sha256', hashKey)
          .update(JSON.stringify([conversationId, authorId, payload.clientMessageId, payload.bodyText]))
          .digest('hex');
        return append(tx, arm, { conversationId, payload, payloadHash, authorId });
      });
    },

    close(operator: OperatorAccess, id: string, { status, expectedVersion }: ChatStatusRequest): Promise<ChatStatusDTO> {
      return writeConversation(operator, id, async ({ tx, arm, conversation, now }) => {
        if (conversation.version !== expectedVersion) throw new AppError('version_conflict');
        assertConversationOpen(conversation);
        await arm();
        const { count } = await repo.closeConversation(tx, id, expectedVersion, now);
        if (count !== 1) throw new AppError('version_conflict');
        return { status, version: expectedVersion + 1, updatedAt: now.toISOString() };
      });
    },
  };
}

export type OperatorWriteService = ReturnType<typeof createOperatorWriteService>;
