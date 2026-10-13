import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { PrivacyExportBody, emailHash, exportCustomer } from '@/lib/server/privacy';

export const runtime = 'nodejs';

/**
 * 仅 ADMIN：导出某客户（规范化邮箱匹配）的询盘、询价清单、样品申请。
 * JSON 直接作为附件返回，不在服务器或 R2 上保存；Cache-Control: no-store；审计只记邮箱 HMAC。
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const ctx = await requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'privacy.export', 5);
  if (limited) return limited;
  const raw = await readJson(req, 2_000);
  if (raw === TOO_LARGE) return jsonErr('too_large', 413);
  const p = PrivacyExportBody.safeParse(raw);
  if (!p.success) return jsonErr('invalid', 400);
  const data = await exportCustomer(prisma, p.data.email);
  const hash = emailHash(p.data.email);
  await audit({ actorId: ctx.user.id, action: 'privacy.export', target: hash, meta: { inquiries: data.inquiries.length, quoteLists: data.quoteLists.length, samples: data.samples.length }, ip: ctx.ip });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="privacy-export-${hash.slice(0, 12)}.json"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
