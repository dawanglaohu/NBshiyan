import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { noStore, jsonErr } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { ID_RE } from '@/lib/server/admin/inquiries';
import { adminView, processModel } from '@/lib/server/model-service';

export const runtime = 'nodejs';

/** 重新检查（例如调整了检查规则或改了 animated 之后） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'EDITOR']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'model.process', 30));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id) || !(await prisma.model3D.findUnique({ where: { id }, select: { id: true } }))) return jsonErr('not_found', 404);
  const m = await processModel(id);
  await audit({ actorId: ctx.user.id, action: 'model.process', target: id, meta: { status: m.status }, ip: ctx.ip });
  return NextResponse.json(adminView(m), { headers: noStore });
}
