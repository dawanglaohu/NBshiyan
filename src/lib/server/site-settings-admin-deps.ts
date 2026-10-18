import { revalidatePath, revalidateTag } from 'next/cache';
import { prisma } from './db';
import { assertSameOrigin, enforceAdminRateLimit } from './auth';
import { audit } from './admin/audit';
import { readJson } from './admin/inquiries';
import { prismaSiteSettingsStore, type SiteSettingsDeps } from './site-settings-admin';
import { SITE_SETTINGS_TAG } from './site-settings-model';
import { prismaAboutImagesLock } from './about-images-lock';

/** 每次成功写入后：刷新 site-settings 缓存标签和 sitemap（页面另有 revalidate 60 兜底） */
export function revalidateSiteSettings() {
  revalidateTag(SITE_SETTINGS_TAG);
  revalidatePath('/sitemap.xml');
}

/**
 * 不含 requireAdmin：鉴权由每个 route.ts 自己 import 并传入（`{ ...siteSettingsDeps, requireAdmin: (r, roles) => requireAdmin(r, roles) }`），
 * 这样 scripts/check-admin-guard.mjs 在 route 文件里能看到真实的鉴权调用，漏传时 tsc 也会报错。
 */
export const siteSettingsDeps: Omit<SiteSettingsDeps, 'requireAdmin'> = {
  assertSameOrigin: (req) => assertSameOrigin(req),
  enforceAdminRateLimit,
  readJson,
  store: prismaSiteSettingsStore(prisma),
  audit: (e) => audit(e),
  revalidate: revalidateSiteSettings,
  userNames: async (ids) => Object.fromEntries((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])),
  liveAssets: (ids) => (ids.length ? prisma.publicAsset.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, smWidth: true, smHeight: true, lgWidth: true, lgHeight: true } }) : Promise.resolve([])),
  aboutImagesLock: prismaAboutImagesLock(prisma),
  now: () => new Date(),
};
