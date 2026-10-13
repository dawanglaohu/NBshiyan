import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope, readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { audit } from '@/lib/server/admin/audit';

export const runtime = 'nodejs';
const Body = z.object({ body: z.string().trim().min(1).max(5000) }).strict();

/** 内部备注，纯文本存储；前端按文本渲染 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'inquiry.note', 30));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const json = await readJson(req, 12_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const inq = await prisma.inquiry.findFirst({ where: { AND: [{ id }, inquiryScope(ctx.user)] }, select: { id: true } });
  if (!inq) return jsonErr('not_found', 404);
  const note = await prisma.inquiryNote.create({ data: { inquiryId: id, authorId: ctx.user.id, body: p.data.body } });
  await audit({ actorId: ctx.user.id, action: 'inquiry.note', target: id, meta: { noteId: note.id }, ip: ctx.ip });
  return NextResponse.json(note, { status: 201, headers: noStore });
}
