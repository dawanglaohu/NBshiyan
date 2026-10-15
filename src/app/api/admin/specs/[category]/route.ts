import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { SpecInput, SPECS_TAG, adminView, auditView, isCategoryKey, toRow } from '@/lib/server/specs';

export const runtime = 'nodejs';
const ROLES: ('ADMIN' | 'EDITOR')[] = ['ADMIN', 'EDITOR']; // SALES 403
const NO_STORE = { 'Cache-Control': 'no-store' };
type P = { params: Promise<{ category: string }> };

export async function GET(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ROLES);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'spec.view');
  if (limited) return limited;
  const { category } = await params;
  if (!isCategoryKey(category)) return jsonErr('not_found', 404);
  const row = await prisma.categorySpec.findUnique({ where: { category } });
  return NextResponse.json(adminView(category, row), { headers: NO_STORE });
}

/** 整体替换某品类规格（省略 / null = 清空）。审计记录 before/after。 */
export async function PUT(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ROLES);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'spec.update', 30));
  if (blocked) return blocked;
  const { category } = await params;
  if (!isCategoryKey(category)) return jsonErr('not_found', 404);
  const json = await readJson(req, 16_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = SpecInput.safeParse(json);
  if (!p.success) return NextResponse.json({ error: 'invalid', issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, { status: 400, headers: NO_STORE });
  const data = { ...toRow(p.data), updatedById: ctx.user.id };
  const { before, after } = await prisma.$transaction(async (tx) => {
    const before = await tx.categorySpec.findUnique({ where: { category } });
    const after = await tx.categorySpec.upsert({ where: { category }, create: { category, ...data }, update: data });
    return { before, after };
  });
  await audit({ actorId: ctx.user.id, action: 'spec.update', target: category, meta: { before: auditView(category, before), after: auditView(category, after) }, ip: ctx.ip });
  revalidateTag(SPECS_TAG);
  return NextResponse.json(adminView(category, after), { headers: NO_STORE });
}
