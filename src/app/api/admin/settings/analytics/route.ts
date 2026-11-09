import { requireAdmin } from '@/lib/server/auth';
import { createAdminServices } from '@/lib/server/composition';
import { handleGetAnalyticsSettings, handlePatchAnalyticsSettings } from '@/lib/server/analytics/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 站点统计时区：GET 读当前 version/timezone/revision/可重算起点；PATCH 用 expectedVersion CAS 改区并登记重算待办。 */
export async function GET(request: Request) {
  const gate = await requireAdmin(request, ['ADMIN']);
  if (gate instanceof Response) return gate;
  return handleGetAnalyticsSettings(request, gate, createAdminServices());
}

export async function PATCH(request: Request) {
  const gate = await requireAdmin(request, ['ADMIN']);
  if (gate instanceof Response) return gate;
  return handlePatchAnalyticsSettings(request, gate, createAdminServices());
}
