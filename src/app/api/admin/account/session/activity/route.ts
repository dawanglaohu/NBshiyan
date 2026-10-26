import { handleSessionActivity } from '@/lib/server/admin-session-activity';
import { assertSameOrigin, requireAdmin } from '@/lib/server/auth';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const originBlocked = assertSameOrigin(request);
  if (originBlocked) return handleSessionActivity(request, originBlocked);
  const decision = await requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']);
  return handleSessionActivity(request, decision);
}
