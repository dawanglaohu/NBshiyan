import { requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';
import { handleLogoutAll } from '@/lib/server/admin/device-management';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const services = createAdminServices();
  const gate = await requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']);
  return handleLogoutAll(request, gate, services);
}
