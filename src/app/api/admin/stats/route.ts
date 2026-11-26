import { requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';
import { handleGetStats } from '@/lib/server/ops/stats-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read role-restricted business and operations statistics for authenticated admins. */
export async function GET(request: Request) {
  const gate = await requireAdmin(request, ['ADMIN', 'SALES', 'EDITOR']);
  if (gate instanceof Response) return gate;
  return handleGetStats(request, gate, createAdminServices());
}
