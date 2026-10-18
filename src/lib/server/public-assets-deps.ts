import { prisma } from './db';
import { assertSameOrigin, enforceAdminRateLimit, enforceAdminUserRateLimit } from './auth';
import { audit } from './admin/audit';
import { storage } from './storage';
import { randomId } from './security';
import { prismaSiteSettingsStore } from './site-settings-admin';
import { revalidateSiteSettings } from './site-settings-admin-deps';
import { prismaPublicAssetRepo, type PublicAssetDeps } from './public-assets-admin';

/**
 * 不含 requireAdmin：鉴权由每个 route.ts 自己 import 并传入（和 site-settings-admin-deps.ts 一样），
 * scripts/check-admin-guard.mjs 在 route 文件里能看到真实的 requireAdmin( 调用，漏传时 tsc 报错。
 */
export const publicAssetRepo = prismaPublicAssetRepo(prisma);
export const publicAssetDeps: Omit<PublicAssetDeps, 'requireAdmin'> = {
  assertSameOrigin: (req) => assertSameOrigin(req),
  enforceAdminRateLimit,
  enforceAdminUserRateLimit,
  storage,
  repo: publicAssetRepo,
  settings: prismaSiteSettingsStore(prisma),
  audit: (e) => audit(e),
  revalidate: revalidateSiteSettings,
  newId: () => randomId(24),
  now: () => new Date(),
};
