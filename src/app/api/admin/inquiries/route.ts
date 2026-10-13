import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/server/db';
import { requireAdmin } from '@/lib/server/auth';
import { noStore } from '@/lib/server/admin/guard';
import { inquiryScope } from '@/lib/server/admin/inquiries';
import { audit } from '@/lib/server/admin/audit';

export const runtime = 'nodejs';
const Q = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['NEW', 'FOLLOWING', 'QUOTED', 'WON', 'INVALID']).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

export async function GET(req: Request) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const p = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return NextResponse.json({ error: 'invalid', issues: p.error.flatten() }, { status: 400, headers: noStore });
  const { page, pageSize, status, minScore, maxScore, q } = p.data;
  const where: Prisma.InquiryWhereInput = {
    AND: [
      inquiryScope(ctx.user),
      status ? { status } : {},
      minScore !== undefined || maxScore !== undefined ? { trustScore: { gte: minScore, lte: maxScore } } : {},
      q ? { OR: [
        { ref: { contains: q, mode: 'insensitive' } },
        { message: { contains: q, mode: 'insensitive' } },
        { contact: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { company: { contains: q, mode: 'insensitive' } }] } },
      ] } : {},
    ],
  };
  const [total, rows] = await prisma.$transaction([
    prisma.inquiry.count({ where }),
    prisma.inquiry.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
      select: { id: true, ref: true, status: true, source: true, locale: true, trustScore: true, ipCountry: true, createdAt: true, assigneeId: true,
        contact: { select: { name: true, email: true, company: true, region: true } }, _count: { select: { items: true, messages: true } } },
    }),
  ]);
  await audit({ actorId: ctx.user.id, action: 'inquiry.list', meta: { page, status, minScore, maxScore, q: q ?? null }, ip: ctx.ip });
  return NextResponse.json({ page, pageSize, total, items: rows }, { headers: noStore });
}
