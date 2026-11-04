import { handleReauth } from '@/lib/server/admin/action-grant';
import { assertSameOrigin, requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const services = createAdminServices();
  const originBlocked = assertSameOrigin(request);
  if (originBlocked) return handleReauth(request, originBlocked, services);
  const decision = await requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']);
  return handleReauth(request, decision, services);
}
