import { handlePutAboutEnabled } from '@/lib/server/site-settings-admin';
import { siteSettingsDeps } from '@/lib/server/site-settings-admin-deps';
import { requireAdmin } from '@/lib/server/auth';

/** 鉴权在这里传入：仅 ADMIN（角色表见 SITE_SETTINGS_ROLES） */
const deps = { ...siteSettingsDeps, requireAdmin: (req: Request, roles: Parameters<typeof requireAdmin>[1]) => requireAdmin(req, roles) };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** #350 站点设置：「前台显示」开关，单独保存（仅 ADMIN） */
export async function PUT(req: Request) {
  return handlePutAboutEnabled(req, deps);
}
