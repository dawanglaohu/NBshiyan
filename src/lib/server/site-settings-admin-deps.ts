import { revalidatePath, revalidateTag } from 'next/cache';
import { prisma } from './db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from './auth';
import { audit } from './admin/audit';
import { readJson } from './admin/inquiries';
import { prismaSiteSettingsStore, type SiteSettingsDeps } from './site-settings-admin';
import { SITE_SETTINGS_TAG } from './site-settings-model';

/** 每次成功写入后：刷新 site-settings 缓存标签和 sitemap（页面另有 revalidate 60 兜底） */
export function revalidateSiteSettings() {
  revalidateTag(SITE_SETTINGS_TAG);
  revalidatePath('/sitemap.xml');
}

export const siteSettingsDeps: SiteSettingsDeps = {
  requireAdmin,
  assertSameOrigin: (req) => assertSameOrigin(req),
  enforceAdminRateLimit,
  readJson,
  store: prismaSiteSettingsStore(prisma),
  audit: (e) => audit(e),
  revalidate: revalidateSiteSettings,
  userNames: async (ids) => Object.fromEntries((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])),
  now: () => new Date(),
};
