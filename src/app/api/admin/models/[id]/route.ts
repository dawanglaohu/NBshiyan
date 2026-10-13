import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { noStore, jsonErr } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE, ID_RE } from '@/lib/server/admin/inquiries';
import { adminView, deleteModelFiles, processModel } from '@/lib/server/model-service';

export const runtime = 'nodejs';
const ROLES: ('ADMIN' | 'EDITOR')[] = ['ADMIN', 'EDITOR'];
type P = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ROLES);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'model.view');
  if (limited) return limited;
  const { id } = await params;
  const m = ID_RE.test(id) ? await prisma.model3D.findUnique({ where: { id } }) : null;
  if (!m) return jsonErr('not_found', 404);
  return NextResponse.json(adminView(m), { headers: noStore });
}

const Patch = z.object({
  productSlug: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  animated: z.boolean().optional(), // 改了会重新检查（体积上限、Open 动画）
  customizable: z.record(z.unknown()).nullable().optional(),
}).strict();

export async function PATCH(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'model.update', 60));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const json = await readJson(req, 8_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Patch.safeParse(json);
  if (!p.success || !Object.keys(p.data).length) return jsonErr('invalid', 400);
  const before = await prisma.model3D.findUnique({ where: { id } });
  if (!before) return jsonErr('not_found', 404);
  const { customizable, ...rest } = p.data;
  let m = await prisma.model3D.update({ where: { id }, data: { ...rest, ...(customizable !== undefined ? { customizable: customizable === null ? undefined : (customizable as object) } : {}) } });
  if (p.data.animated !== undefined && p.data.animated !== before.animated) m = await processModel(id);
  await audit({ actorId: ctx.user.id, action: 'model.update', target: id, meta: { fields: Object.keys(p.data) }, ip: ctx.ip });
  return NextResponse.json(adminView(m), { headers: noStore });
}

/** 只能删除未上架的模型（先下架再删） */
export async function DELETE(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'model.delete', 30));
  if (blocked) return blocked;
  const { id } = await params;
  const m = ID_RE.test(id) ? await prisma.model3D.findUnique({ where: { id } }) : null;
  if (!m) return jsonErr('not_found', 404);
  const r = await prisma.model3D.deleteMany({ where: { id, published: false } });
  if (r.count !== 1) return jsonErr('published', 409);
  await deleteModelFiles(m);
  await audit({ actorId: ctx.user.id, action: 'model.delete', target: id, meta: { productSlug: m.productSlug }, ip: ctx.ip });
  return new Response(null, { status: 204, headers: noStore });
}
