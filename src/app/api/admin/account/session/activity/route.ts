import { handleSessionActivity } from '@/lib/server/admin-session-activity';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return handleSessionActivity(request);
}
