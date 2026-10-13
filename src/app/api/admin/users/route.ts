import { NextResponse } from 'next/server';
import { prisma } from '@/lib/server/db';
import { requireAdmin, adminRateLimit } from '@/lib/server/auth';
import { noStore } from '@/lib/server/admin/guard';

export const runtime = 'nodejs';

/**
 * 分配下拉框用的账号列表。ADMIN：所有未禁用的 ADMIN/SALES；SALES：只返回自己。
 * 只返回 id、name、email、role，不含任何安全字段。
 */
export async function GET(req: Request) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const limited = adminRateLimit(req, 'users.list');
  if (limited) return limited;
  const select = { id: true, name: true, email: true, role: true } as const;
  const items = ctx.user.role === 'ADMIN'
    ? await prisma.user.findMany({ where: { disabled: false, role: { in: ['ADMIN', 'SALES'] } }, select, orderBy: { name: 'asc' } })
    : [{ id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role }];
  return NextResponse.json({ items }, { headers: noStore });
}
