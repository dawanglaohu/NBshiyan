import { handleGetAbout } from '@/lib/server/site-settings-admin';
import { siteSettingsDeps } from '@/lib/server/site-settings-admin-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** #350 站点设置：读取 about 开关和各语言内容（仅 ADMIN） */
export async function GET(req: Request) {
  return handleGetAbout(req, siteSettingsDeps);
}
