import { prisma } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/auth';
import { audit } from '@/lib/server/admin/audit';
import { handlePrivacyDelete } from '@/lib/server/privacy-routes';

export const runtime = 'nodejs';

/**
 * 仅 ADMIN：删除某客户的个人信息（匿名化，保留统计字段）并删除其 logo；body { email, confirmEmail }。
 * 顺序 requireAdmin → assertSameOrigin → 限流（5 次/分钟）→ PRIVACY_HASH_SECRET；审计只记邮箱 HMAC。逻辑见 privacy-routes.ts。
 */
export async function POST(req: Request) {
  return handlePrivacyDelete(req, { requireAdmin: (r, roles) => requireAdmin(r, roles), db: prisma, audit });
}
