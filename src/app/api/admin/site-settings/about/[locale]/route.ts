import { handlePutAboutLocale } from '@/lib/server/site-settings-admin';
import { siteSettingsDeps } from '@/lib/server/site-settings-admin-deps';
import { requireAdmin } from '@/lib/server/auth';

/** 鉴权在这里传入：仅 ADMIN（角色表见 SITE_SETTINGS_ROLES） */
const deps = { ...siteSettingsDeps, requireAdmin: (req: Request, roles: Parameters<typeof requireAdmin>[1]) => requireAdmin(req, roles) };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type P = { params: Promise<{ locale: string }> };

/** #350 站点设置：整份保存某个语言的 about 内容（仅 ADMIN，带 expectedVersion，冲突 409） */
export async function PUT(req: Request, { params }: P) {
  const { locale } = await params;
  return handlePutAboutLocale(req, locale, deps);
}
