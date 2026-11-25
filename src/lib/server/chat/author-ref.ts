import { createHmac } from 'node:crypto';
import type { ChatAuthorReferenceDTO } from '../../contracts/chat';
import { AppError } from '../http/errors';
import type { ChatMessagePageRow } from './repo';

type PageMessage = Pick<ChatMessagePageRow, 'id' | 'sender' | 'authorId'>;

export function createChatPageAuthors(secret: Buffer | null) {
  const key = secret && createHmac('sha256', secret).update('chat:author-ref:v1').digest();

  return function pageAuthors(conversationId: string, messages: readonly PageMessage[]): ChatAuthorReferenceDTO[] {
    return messages.filter(({ sender }) => sender === 'OPERATOR').map(({ id, authorId }) => {
      if (authorId === null) return { messageId: id, authorRef: null };
      if (!key) throw new AppError('service_unavailable');
      const authorRef = createHmac('sha256', key).update(JSON.stringify([conversationId, authorId])).digest('base64url');
      return { messageId: id, authorRef };
    });
  };
}

export type ChatPageAuthors = ReturnType<typeof createChatPageAuthors>;
