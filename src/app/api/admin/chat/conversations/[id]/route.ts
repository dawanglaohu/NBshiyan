import { AdminChatSyncDTOSchema, ChatMessagesQuerySchema } from '@/lib/contracts/chat';
import { requireAdmin } from '@/lib/server/auth';
import { CHAT_OPERATOR_ROLES } from '@/lib/server/chat/operator-read';
import { conversationId, handleOperatorRead, parseInput, queryInput, type ConversationParams } from '../operator-read-http';

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
