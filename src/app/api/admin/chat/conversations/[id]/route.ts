import { AdminChatSyncDTOSchema, ChatMessagesQuerySchema, ChatStatusDTOSchema, ChatStatusRequestSchema } from '@/lib/contracts/chat';
import { requireAdmin } from '@/lib/server/auth';
import { CHAT_OPERATOR_ROLES } from '@/lib/server/chat/operator-read';
import { conversationId, handleOperatorRead, handleOperatorWrite, parseInput, queryInput, writeInput, type ConversationParams } from '../operator-read-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request, { params }: ConversationParams) {
  return handleOperatorRead(request, 'GET /api/admin/chat/conversations/[id]',
    () => requireAdmin(request, CHAT_OPERATOR_ROLES),
    async ({ user }, service) => {
      const id = await conversationId(params);
      const query = parseInput(ChatMessagesQuerySchema, queryInput(request));
      return AdminChatSyncDTOSchema.parse(await service.getSync(user.id, id, query));
    });
}

export function PATCH(request: Request, { params }: ConversationParams) {
  return handleOperatorWrite(request, 'PATCH /api/admin/chat/conversations/[id]',
    () => requireAdmin(request, CHAT_OPERATOR_ROLES),
    async (operator, service) => {
      const id = await conversationId(params);
      const payload = await writeInput(request, ChatStatusRequestSchema);
      return ChatStatusDTOSchema.parse(await service.close(operator, id, payload));
    });
}
