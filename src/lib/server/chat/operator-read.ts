import type { PrismaClient, Role } from '@prisma/client';
import {
  type AdminChatConversationDTO,
  type AdminChatSyncDTO,
  type ChatMessagesQuery,
  type ChatSummaryPageDTO,
  type ChatSummaryQuery,
  type ReadDTO,
} from '../../contracts/chat';
import { decideAdminAccess, type BoundAccess } from '../admin/device-session';
import { ADMIN_SESSION_POLICY } from '../config';
import { AppError } from '../http/errors';
import { createInboxRepo, type InboxRow } from './inbox-repo';
import { ChatSequenceGap, consecutivePage, pageStartSeq } from './read-cursor';

export const CHAT_OPERATOR_ROLES: Role[] = ['ADMIN', 'SALES'];

type OperatorAccess = Pick<Extract<BoundAccess, { ok: true }>, 'user' | 'device'>;

function conversationDto(row: Omit<InboxRow, 'lastReadSeq'>): AdminChatConversationDTO {
  return {
    id: row.id,
    locale: row.locale as AdminChatConversationDTO['locale'],
    productSlug: row.productSlug,
    sourcePath: row.sourcePath,
    email: row.email,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    retainUntil: row.retainUntil.toISOString(),
    anonymizedAt: row.anonymizedAt?.toISOString() ?? null,
  };
}

export function createOperatorReadService(deps: { db: Pick<PrismaClient, '$transaction'>; clock: () => Date }) {
  const { db, clock } = deps;
  return {
    async list(userId: string, query: ChatSummaryQuery): Promise<ChatSummaryPageDTO> {
      const cursor = query.cursor
        ? JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { updatedAt: string; id: string }
        : undefined;
      return db.$transaction(async (tx) => {
        const now = clock();
        const repo = createInboxRepo(tx);
        const rows = await repo.list(userId, now, query, cursor && {
          updatedAt: new Date(cursor.updatedAt),
          id: cursor.id,
        });
        const unreadTotal = await repo.unreadTotal(userId, now);
        const items = rows.slice(0, query.limit).map((row) => ({
          ...conversationDto(row),
          lastSeq: row.lastSeq,
          lastReadSeq: row.lastReadSeq,
        }));
        const hasMore = rows.length > query.limit;
        const last = items.at(-1);
        const nextCursor = hasMore && last
          ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url')
          : null;
        return { items, hasMore, nextCursor, unreadTotal };
      }, { isolationLevel: 'RepeatableRead' });
    },

    async getSync(userId: string, conversationId: string, query: ChatMessagesQuery): Promise<AdminChatSyncDTO> {
      return db.$transaction(async (tx) => {
        const repo = createInboxRepo(tx);
        const conversation = await repo.conversation(conversationId, userId, clock());
        if (!conversation) throw new AppError('not_found');

        const { lastSeq } = conversation;
        const start = pageStartSeq(query.afterSeq, lastSeq);
        const rows = await repo.messages(conversationId, start, lastSeq, query.limit);
        const page = consecutivePage(rows, start, lastSeq);
        if (page.messages.length !== Math.min(lastSeq - start, query.limit)) throw new ChatSequenceGap();

        return {
          conversation: conversationDto(conversation),
          messages: page.messages.map(({ createdAt, ...row }) => ({ ...row, createdAt: createdAt.toISOString() })),
          lastSeq,
          nextAfterSeq: page.nextAfterSeq,
          hasMore: page.hasMore,
          read: { lastReadSeq: conversation.readCursors[0]?.lastReadSeq ?? 0 },
        };
      }, { isolationLevel: 'RepeatableRead' });
    },

    async markRead(operator: OperatorAccess, conversationId: string, lastReadSeq: number): Promise<ReadDTO> {
      return db.$transaction(async (tx) => {
        const repo = createInboxRepo(tx);
        const { user, device } = await repo.lockOperator(operator.user.id, operator.device.id);
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
        const read = await repo.advanceRead(conversationId, access.user.id, lastReadSeq, now);
        if (!read) throw new AppError('not_found');
        return read;
      });
    },
  };
}

export type OperatorReadService = ReturnType<typeof createOperatorReadService>;
