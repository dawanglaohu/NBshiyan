import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { noStore, jsonErr } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { ID_RE, readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { adminView } from '@/lib/server/model-service';

export const runtime = 'nodejs';
const Body = z.object({ published: z.boolean() }).strict();

/**
 * 第 4 步：上架 / 下架。上架要求 status=READY（所有 error 级检查通过）。
 * 同一 productSlug 只保留一个上架版本：上架新版本时自动下架旧版本（同一事务）。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'EDITOR']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'model.publish', 30));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const json = await readJson(req, 1_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const m = await prisma.model3D.findUnique({ where: { id } });
  if (!m) return jsonErr('not_found', 404);
  let replaced: string[] = [];
  if (p.data.published) {
    const res = await prisma.$transaction(async (tx) => {
      const r = await tx.model3D.updateMany({ where: { id, status: 'READY' }, data: { published: true, publishedAt: new Date() } });
      if (r.count !== 1) return null;
      const old = await tx.model3D.findMany({ where: { productSlug: m.productSlug, published: true, id: { not: id } }, select: { id: true } });
      await tx.model3D.updateMany({ where: { id: { in: old.map((o) => o.id) } }, data: { published: false } });
      return old.map((o) => o.id);
    });
    if (res === null) return jsonErr('not_ready', 409);
    replaced = res;
  } else {
    await prisma.model3D.update({ where: { id }, data: { published: false } });
  }
  await audit({ actorId: ctx.user.id, action: p.data.published ? 'model.publish' : 'model.unpublish', target: id, meta: { productSlug: m.productSlug, replaced }, ip: ctx.ip });
  const after = await prisma.model3D.findUniqueOrThrow({ where: { id } });
  return NextResponse.json({ ...adminView(after), replaced }, { headers: noStore });
}
