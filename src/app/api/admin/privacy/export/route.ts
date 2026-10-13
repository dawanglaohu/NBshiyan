import { prisma } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/auth';
import { audit } from '@/lib/server/admin/audit';
import { handlePrivacyExport } from '@/lib/server/privacy-routes';

export const runtime = 'nodejs';

/**
 * 仅 ADMIN：导出某客户（规范化邮箱匹配）的询盘、询价清单、样品申请；JSON 以附件直接返回，不落盘、不写 R2。
 * 顺序 requireAdmin → assertSameOrigin → 限流（5 次/分钟）→ PRIVACY_HASH_SECRET；审计只记邮箱 HMAC。逻辑见 privacy-routes.ts。
 */
export async function POST(req: Request) {
  return handlePrivacyExport(req, { requireAdmin: (r, roles) => requireAdmin(r, roles), db: prisma, audit });
}
