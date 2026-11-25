import { ChatSummaryPageDTOSchema, ChatSummaryQuerySchema } from '@/lib/contracts/chat';
import { requireAdmin } from '@/lib/server/auth';
import { CHAT_OPERATOR_ROLES } from '@/lib/server/chat/operator-read';
import { handleOperatorRead, parseInput, queryInput } from './operator-read-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleOperatorRead(request, 'GET /api/admin/chat/conversations',
    () => requireAdmin(request, CHAT_OPERATOR_ROLES),
    async ({ user }, service) => {
      const query = parseInput(ChatSummaryQuerySchema, queryInput(request));
      return ChatSummaryPageDTOSchema.parse(await service.list(user.id, query));
    });
}
