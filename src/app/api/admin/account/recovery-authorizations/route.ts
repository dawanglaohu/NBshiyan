import { RECOVERY_AUTHORIZE_ROUTE_ID, handleRecoveryAuthorization } from '@/lib/server/admin/recovery-authorizations';
import { assertSameOrigin, requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const services = createAdminServices();
  const originBlocked = assertSameOrigin(request);
  if (originBlocked) return handleRecoveryAuthorization(request, originBlocked, services, { routeId: RECOVERY_AUTHORIZE_ROUTE_ID });
  const decision = await requireAdmin(request, ['ADMIN']);
  return handleRecoveryAuthorization(request, decision, services, { routeId: RECOVERY_AUTHORIZE_ROUTE_ID });
}
