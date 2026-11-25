import { ChatMessageRequestSchema, MessageReceivedDTOSchema } from '@/lib/contracts/chat';
import { requireAdmin } from '@/lib/server/auth';
import { CHAT_OPERATOR_ROLES } from '@/lib/server/chat/operator-read';
import { conversationId, handleOperatorWrite, writeInput, type ConversationParams } from '../../operator-read-http';

export const runtime = 'nodejs';

export function POST(request: Request, { params }: ConversationParams) {
  return handleOperatorWrite(request, 'POST /api/admin/chat/conversations/[id]/messages',
    () => requireAdmin(request, CHAT_OPERATOR_ROLES),
    async (operator, service) => {
      const id = await conversationId(params);
      const payload = await writeInput(request, ChatMessageRequestSchema);
      return MessageReceivedDTOSchema.parse(await service.reply(operator, id, payload));
    });
}
