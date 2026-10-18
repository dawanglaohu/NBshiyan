import { handlePutAboutEnabled } from '@/lib/server/site-settings-admin';
import { siteSettingsDeps } from '@/lib/server/site-settings-admin-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** #350 站点设置：「前台显示」开关，单独保存（仅 ADMIN） */
export async function PUT(req: Request) {
  return handlePutAboutEnabled(req, siteSettingsDeps);
}
