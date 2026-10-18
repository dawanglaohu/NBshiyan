import { handleGetOrganization, handlePutOrganization } from '@/lib/server/site-settings-admin';
import { siteSettingsDeps } from '@/lib/server/site-settings-admin-deps';
import { requireAdmin } from '@/lib/server/auth';

/** 鉴权在这里传入：仅 ADMIN（角色表见 SITE_SETTINGS_ROLES） */
const deps = { ...siteSettingsDeps, requireAdmin: (req: Request, roles: Parameters<typeof requireAdmin>[1]) => requireAdmin(req, roles) };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** #350 站点设置：组织信息（Organization JSON-LD 字段，仅 ADMIN） */
export async function GET(req: Request) {
  return handleGetOrganization(req, deps);
}

export async function PUT(req: Request) {
  return handlePutOrganization(req, deps);
}
