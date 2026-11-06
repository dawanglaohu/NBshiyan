import { requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';
import { handleDeviceList } from '@/lib/server/admin/device-management';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const services = createAdminServices();
  const gate = await requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']);
  return handleDeviceList(request, gate, services);
}
