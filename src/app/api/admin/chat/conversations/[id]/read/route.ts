import { CHAT_BODY_MAX_BYTES } from '@/lib/chat/rules';
import { ChatReadRequestSchema, ReadDTOSchema } from '@/lib/contracts/chat';
import { requireAdmin } from '@/lib/server/auth';
import { CHAT_OPERATOR_ROLES } from '@/lib/server/chat/operator-read';
import { AppError } from '@/lib/server/http/errors';
import { readBody } from '@/lib/server/security';
import { conversationId, handleOperatorRead, parseInput, type ConversationParams } from '../../operator-read-http';

export const runtime = 'nodejs';

export function POST(request: Request, { params }: ConversationParams) {
  return handleOperatorRead(request, 'POST /api/admin/chat/conversations/[id]/read',
    () => requireAdmin(request, CHAT_OPERATOR_ROLES),
    async (operator, service) => {
      const id = await conversationId(params);
      const raw = await readBody(request, CHAT_BODY_MAX_BYTES);
      if (raw === null) throw new AppError('too_large');
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new AppError('invalid');
      }
      const { lastReadSeq } = parseInput(ChatReadRequestSchema, payload);
      return ReadDTOSchema.parse(await service.markRead(operator, id, lastReadSeq));
    });
}
