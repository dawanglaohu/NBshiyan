import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { hashPassword, passwordPolicyError, publicUser } from '@/lib/server/admin/accounts';
import { normalizeAccountEmail } from '@/lib/server/admin/user-policy';
import { auditTokenIssued, enrollLinkBase, issueResponse, newEnrollToken } from '@/lib/server/admin/enroll-token';

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
  email: z.string().max(254).transform(normalizeAccountEmail).pipe(z.string().email().max(200)),
  name: z.string().trim().min(1).max(100),
  role: z.enum(['ADMIN', 'SALES', 'EDITOR']),
  password: z.string().max(200), // 初始密码，线下告知；对方登录前须先绑定 2FA
}).strict();

/**
 * 新建账号（仅 ADMIN）。#347 方案 A：同时签发一次性绑定令牌，响应体里多返回一次 enrollLink / expiresAt / expiresTruncated，
 * 之后任何接口都拿不到这个链接（库里只有哈希）。链接只给本人私信，不进日志、审计、URL。
 */
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
  const base = enrollLinkBase(); // #347：站点地址不合格时不建号（否则发不出链接）
  if (!base) return jsonErr('site_url_invalid', 500);
  const now = new Date();
  // 新账号的绑定窗口起点仍是 createdAt（≈ now，enrollIssuedAt 留空：reset 脚本把非空 enrollIssuedAt 当作“绑定进行中”）
  const t = newEnrollToken({ createdAt: now, enrollIssuedAt: null }, now.getTime());
  const u = await prisma.user.create({ data: { email: p.data.email, name: p.data.name, role: p.data.role, passwordHash: await hashPassword(p.data.password), ...t.data } });
  await audit({ actorId: ctx.user.id, action: 'user.create', target: u.id, meta: { changes: { role: { from: null, to: u.role }, disabled: { from: null, to: false } } }, ip: ctx.ip });
  await auditTokenIssued(ctx.user.id, u.id, 'admin_create', ctx.ip, t.expiresTruncated);
  return NextResponse.json({ ...publicUser(u), ...issueResponse(t, base) }, { status: 201, headers: noStore });
}
