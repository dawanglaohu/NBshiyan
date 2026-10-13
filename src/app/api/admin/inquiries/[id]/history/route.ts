import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope } from '@/lib/server/admin/inquiries';
import { buildHistory, pageHistory, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from '@/lib/server/admin/history';

export const runtime = 'nodejs';
const Q = z.object({
  limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).default(HISTORY_DEFAULT_LIMIT),
  before: z.string().max(200).optional(),
}).strict();

/** 询盘时间线：{ items, total }，新的在前，?limit（默认 10，最多 50）&before=<cursor>。SALES 只能看分配给自己的询盘（含分配前的记录）。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'inquiry.history');
  if (limited) return limited;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const q = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return NextResponse.json({ error: 'invalid', issues: q.error.flatten() }, { status: 400, headers: noStore });
  const inq = await prisma.inquiry.findFirst({
    where: { AND: [{ id }, inquiryScope(ctx.user)] },
    select: { id: true, createdAt: true, source: true, sample: { select: { shippingAddress: true } },
      messages: { select: { id: true, direction: true, subject: true, authorId: true, createdAt: true }, take: 1000 } },
  });
  if (!inq) return jsonErr('not_found', 404);
  const audits = await prisma.auditLog.findMany({ where: { target: id, action: 'inquiry.update' }, take: 1000, select: { id: true, action: true, actorId: true, meta: true, createdAt: true } });
  const userIds = new Set<string>();
  for (const a of audits) {
    if (a.actorId) userIds.add(a.actorId);
    const aid = (a.meta as { after?: { assigneeId?: string | null } } | null)?.after?.assigneeId;
    if (aid) userIds.add(aid);
  }
  for (const m of inq.messages) if (m.authorId) userIds.add(m.authorId);
  const users = await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true, role: true } });
  const page = pageHistory(buildHistory(inq, audits, inq.messages, users, inq.sample?.shippingAddress), q.data.limit, q.data.before);
  if (!page) return jsonErr('bad_cursor', 400);
  return NextResponse.json(page, { headers: noStore });
}
