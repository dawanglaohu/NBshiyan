import { RESET_2FA_ALIAS_ROUTE_ID, handleRecoveryAuthorization } from '@/lib/server/admin/recovery-authorizations';
import { assertSameOrigin, requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';
import { ID_RE } from '@/lib/server/admin/inquiries';

export const runtime = 'nodejs';

/** 兼容别名：旧 UI 的 reset-2fa 不再直清目标 TOTP，改为消费目标绑定的 RECOVERY_AUTHORIZE grant 后签发 15min permit。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const services = createAdminServices();
  const { id } = await params;
  if (!ID_RE.test(id)) {
    return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'private, no-store' } });
  }
  const originBlocked = assertSameOrigin(request);
  if (originBlocked) return handleRecoveryAuthorization(request, originBlocked, services, { routeId: RESET_2FA_ALIAS_ROUTE_ID, targetIdFromPath: id });
  const decision = await requireAdmin(request, ['ADMIN']);
  return handleRecoveryAuthorization(request, decision, services, { routeId: RESET_2FA_ALIAS_ROUTE_ID, targetIdFromPath: id });
}
