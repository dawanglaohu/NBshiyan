import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr } from '@/lib/server/admin/guard';
import { hitRateLimit } from '@/lib/server/security';
import { audit } from '@/lib/server/admin/audit';
import { revealSampleAddress } from '@/lib/server/sample';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * 查看样品申请的完整收货地址（PII）。只有 POST，没有 GET 变体。
 * 顺序：同源校验 → 登录 + 角色（ADMIN / SALES）→ 限流 → 归属校验（ADMIN 或被分配的 SALES，否则 404）→ 审计 sample.address.view → 返回。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'sample.address', 60);
  if (limited) return limited;
  const { id } = await params;
  const address = await revealSampleAddress(ctx, id, {
    findSample: (sid) => prisma.sampleRequest.findUnique({ where: { id: sid }, select: { id: true, shippingAddress: true, inquiry: { select: { id: true, assigneeId: true } } } }),
    audit: (e) => audit(e),
    allowDenyAudit: (k) => hitRateLimit(`audit:sample.address.denied:${k}`, 1, 60_000),
  });
  if (address === null) return jsonErr('not_found', 404);
  return NextResponse.json({ shippingAddress: address }, { headers: NO_STORE });
}
