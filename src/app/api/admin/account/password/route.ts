import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, adminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { reauth, passwordPolicyError, hashPassword } from '@/lib/server/admin/accounts';
import { verifySecret } from '@/lib/server/admin/crypto';

export const runtime = 'nodejs';
const Body = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().max(40).optional(),
}).strict();

/** 改自己的密码：当前密码 + TOTP（或恢复码）。成功后所有会话（含当前）失效，需重新登录。 */
export async function POST(req: Request) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES', 'EDITOR']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? adminRateLimit(req, 'account.password', 5);
  if (blocked) return blocked;
  const json = await readJson(req, 2_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const policy = passwordPolicyError(p.data.newPassword, ctx.user.email);
  if (policy) return jsonErr(policy, 422);
  const r = await reauth(ctx.user, p.data.currentPassword, p.data.totp, p.data.recoveryCode, ctx.ip, 'account.password');
  if (r !== 'ok') return jsonErr(r, r === 'locked' ? 423 : 401);
  if (await verifySecret(ctx.user.passwordHash, p.data.newPassword)) return jsonErr('same_password', 422);
  await prisma.user.update({ where: { id: ctx.user.id }, data: { passwordHash: await hashPassword(p.data.newPassword), sessionVersion: { increment: 1 } } }); // = revokeSessions
  await audit({ actorId: ctx.user.id, action: 'account.password_change', target: ctx.user.id, ip: ctx.ip });
  return NextResponse.json({ ok: true, reauthRequired: true }, { headers: noStore });
}
