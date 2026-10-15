import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/server/db';
import { requireAdmin, enforceAdminRateLimit } from '@/lib/server/auth';
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
  from: z.coerce.date().optional(), // 创建时间 >= from（ISO 日期或时间）
  to: z.coerce.date().optional(), // 创建时间 < to；只给日期时按当天结束算
  product: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  type: z.enum(['general', 'quote_list', 'sample']).optional(), // general = FORM/WIZARD/CUSTOMIZER，quote_list = CART，sample = SAMPLE
  includeAnonymized: z.enum(['true', 'false', '1', '0']).optional(), // 默认 false：只列未匿名化的询盘
  assignee: z.union([z.literal('me'), z.literal('none'), z.string().regex(/^[a-z0-9]{20,40}$/)]).optional(),
});

export async function GET(req: Request) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'inquiry.list');
  if (limited) return limited;
  const p = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return NextResponse.json({ error: 'invalid', issues: p.error.flatten() }, { status: 400, headers: noStore });
  const { page, pageSize, status, minScore, maxScore, q, from, product, assignee, type } = p.data;
  const includeAnonymized = p.data.includeAnonymized === 'true' || p.data.includeAnonymized === '1';
  let to = p.data.to;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(new URL(req.url).searchParams.get('to') ?? '')) to = new Date(to.getTime() + 86_400_000);
  const assigneeWhere: Prisma.InquiryWhereInput = assignee === 'me' ? { assigneeId: ctx.user.id } : assignee === 'none' ? { assigneeId: null } : assignee ? { assigneeId: assignee } : {};
  const where: Prisma.InquiryWhereInput = {
    AND: [
      inquiryScope(ctx.user),
      includeAnonymized ? {} : { anonymizedAt: null }, // 服务端过滤，total 和分页一致
      status ? { status } : {},
      type ? { source: type === 'sample' ? 'SAMPLE' : type === 'quote_list' ? 'CART' : { in: ['FORM', 'WIZARD', 'CUSTOMIZER'] } } : {},
      assigneeWhere,
      from || to ? { createdAt: { gte: from, lt: to } } : {},
      product ? { items: { some: { productSlug: product } } } : {},
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
      select: { id: true, ref: true, status: true, source: true, locale: true, trustScore: true, ipCountry: true, createdAt: true, assigneeId: true, anonymizedAt: true,
        contact: { select: { name: true, email: true, company: true, region: true } }, _count: { select: { items: true, messages: true } },
        sample: { select: { status: true } } }, // 列表不含收货地址
    }),
  ]);
  await audit({ actorId: ctx.user.id, action: 'inquiry.list', meta: { page, includeAnonymized, type, status, minScore, maxScore, product, assignee, hasQuery: !!q }, ip: ctx.ip });
  return NextResponse.json({ page, pageSize, total, items: rows }, { headers: noStore });
}
