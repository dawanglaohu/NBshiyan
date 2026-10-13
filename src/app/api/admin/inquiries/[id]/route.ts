import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope, readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { audit } from '@/lib/server/admin/audit';
import { maskAddress, canViewFullAddress } from '@/lib/server/sample';
import { buildHistory } from '@/lib/server/admin/history';

export const runtime = 'nodejs';
type P = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'inquiry.view');
  if (limited) return limited;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const inq = await prisma.inquiry.findFirst({
    where: { AND: [{ id }, inquiryScope(ctx.user)] },
    include: {
      contact: true, sample: true,
      items: true,
      messages: { orderBy: { createdAt: 'asc' } },
      notes: { orderBy: { createdAt: 'asc' } },
      assignee: { select: { id: true, name: true, email: true } },
      logoUploads: { select: { id: true, width: true, height: true, bytes: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!inq) return jsonErr('not_found', 404);
  const { replyToken: _omit, ...rest } = inq; void _omit; // 回信 token 不下发
  // logoUploadId：第一个（通常唯一）logo，前端用 GET /api/admin/uploads/:id 预览
  // 样品收货地址是 PII：这里永远脱敏；完整地址只能 POST /api/admin/samples/:id/address（同源 + 权限 + 审计）
  const sample = inq.sample && { ...inq.sample, shippingAddress: maskAddress(inq.sample.shippingAddress), normalizedEmail: undefined };
  const safe = { ...rest, sample, canRevealAddress: !!inq.sample?.shippingAddress && canViewFullAddress(ctx.user, inq), logoUploadId: inq.logoUploads[0]?.id ?? null };
  // 时间线：只对已通过范围校验（inquiryScope）的询盘查询
  const audits = await prisma.auditLog.findMany({ where: { target: id, action: 'inquiry.update' }, orderBy: { createdAt: 'asc' }, take: 500, select: { action: true, actorId: true, meta: true, createdAt: true } });
  const userIds = new Set<string>();
  for (const a of audits) {
    if (a.actorId) userIds.add(a.actorId);
    const aid = (a.meta as { after?: { assigneeId?: string | null } } | null)?.after?.assigneeId;
    if (aid) userIds.add(aid);
  }
  for (const m of inq.messages) if (m.authorId) userIds.add(m.authorId);
  const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, role: true } });
  const history = buildHistory(inq, audits, inq.messages, users);
  await audit({ actorId: ctx.user.id, action: 'inquiry.view', target: id, ip: ctx.ip });
  return NextResponse.json({ ...safe, history }, { headers: noStore });
}

const Patch = z.object({
  status: z.enum(['NEW', 'FOLLOWING', 'QUOTED', 'WON', 'INVALID']).optional(),
  assigneeId: z.string().regex(ID_RE).nullable().optional(), // 仅管理员
}).strict().refine((b) => b.status !== undefined || b.assigneeId !== undefined, 'empty');

export async function PATCH(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'inquiry.update', 60));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const json = await readJson(req, 2_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Patch.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  if (p.data.assigneeId !== undefined && ctx.user.role !== 'ADMIN') return jsonErr('forbidden', 403);
  if (p.data.assigneeId) {
    const a = await prisma.user.findUnique({ where: { id: p.data.assigneeId }, select: { role: true, disabled: true } });
    if (!a || a.disabled || a.role === 'EDITOR') return jsonErr('invalid_assignee', 422);
  }
  const before = await prisma.inquiry.findFirst({ where: { AND: [{ id }, inquiryScope(ctx.user)] }, select: { status: true, assigneeId: true } });
  if (!before) return jsonErr('not_found', 404);
  const after = await prisma.inquiry.update({ where: { id }, data: p.data, select: { id: true, status: true, assigneeId: true, updatedAt: true } });
  await audit({ actorId: ctx.user.id, action: 'inquiry.update', target: id, meta: { before, after: { status: after.status, assigneeId: after.assigneeId } }, ip: ctx.ip });
  return NextResponse.json(after, { headers: noStore });
}
