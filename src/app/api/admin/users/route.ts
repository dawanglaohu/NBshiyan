import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { hashPassword, passwordPolicyError, publicUser } from '@/lib/server/admin/accounts';

export const runtime = 'nodejs';

/**
 * 账号列表。默认（分配下拉框）：ADMIN 拿到未禁用的 ADMIN/SALES，SALES 只拿到自己，字段 id/name/email/role。
 * `?all=1`（仅 ADMIN，账号管理页）：所有账号，另含 disabled、totpEnabled、locked、createdAt。
 */
export async function GET(req: Request) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES']);
  if (ctx instanceof Response) return ctx;
  const limited = await enforceAdminRateLimit(req, 'users.list');
  if (limited) return limited;
  if (new URL(req.url).searchParams.get('all') === '1') {
    if (ctx.user.role !== 'ADMIN') return jsonErr('forbidden', 403);
    const all = await prisma.user.findMany({ orderBy: [{ disabled: 'asc' }, { name: 'asc' }] });
    return NextResponse.json({ items: all.map(publicUser) }, { headers: noStore });
  }
  const select = { id: true, name: true, email: true, role: true } as const;
  const items = ctx.user.role === 'ADMIN'
    ? await prisma.user.findMany({ where: { disabled: false, role: { in: ['ADMIN', 'SALES'] } }, select, orderBy: { name: 'asc' } })
    : [{ id: ctx.user.id, name: ctx.user.name, email: ctx.user.email, role: ctx.user.role }];
  return NextResponse.json({ items }, { headers: noStore });
}

const Create = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['ADMIN', 'SALES', 'EDITOR']),
  password: z.string().max(200), // 初始密码，线下告知；对方登录前须先绑定 2FA
}).strict();

/** 新建账号（仅 ADMIN） */
export async function POST(req: Request) {
  const ctx = await requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'users.create', 20));
  if (blocked) return blocked;
  const json = await readJson(req, 2_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Create.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const policy = passwordPolicyError(p.data.password, p.data.email);
  if (policy) return jsonErr(policy, 422);
  if (await prisma.user.findUnique({ where: { email: p.data.email }, select: { id: true } })) return jsonErr('email_taken', 409);
  const u = await prisma.user.create({ data: { email: p.data.email, name: p.data.name, role: p.data.role, passwordHash: await hashPassword(p.data.password) } });
  await audit({ actorId: ctx.user.id, action: 'user.create', target: u.id, meta: { role: u.role }, ip: ctx.ip });
  return NextResponse.json(publicUser(u), { status: 201, headers: noStore });
}
