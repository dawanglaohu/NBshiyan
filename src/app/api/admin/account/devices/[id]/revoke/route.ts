import { requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';
import { handleDeviceRevoke } from '@/lib/server/admin/device-management';

export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const services = createAdminServices();
  const gate = await requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']);
  const { id } = await context.params;
  return handleDeviceRevoke(request, gate, services, id);
}
