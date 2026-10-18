import { handleGetOrganization, handlePutOrganization } from '@/lib/server/site-settings-admin';
import { siteSettingsDeps } from '@/lib/server/site-settings-admin-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** #350 站点设置：组织信息（Organization JSON-LD 字段，仅 ADMIN） */
export async function GET(req: Request) {
  return handleGetOrganization(req, siteSettingsDeps);
}

export async function PUT(req: Request) {
  return handlePutOrganization(req, siteSettingsDeps);
}
