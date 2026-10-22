import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/server/db';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { reauth, reset2faData } from '@/lib/server/admin/accounts';
import { auditTokenIssued, enrollLinkBase, issueResponse, newEnrollToken } from '@/lib/server/admin/enroll-token';

export const runtime = 'nodejs';
const Body = z.object({
  currentPassword: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().max(40).optional(),
}).strict().refine((b) => b.totp || b.recoveryCode, 'totp_or_recovery');

/** 重置自己的 2FA（换手机等）：当前密码 + TOTP 或恢复码。清空密钥和恢复码、所有会话失效，然后重新走 enroll。
 * #347 方案 A：同一次写入里签发一次性绑定令牌，响应体里返回一次 enrollLink（前端可以直接跳过去），之后拿不到。 */
export async function POST(req: Request) {
  const ctx = await requireAdmin(req, ['ADMIN', 'SALES', 'EDITOR']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'account.2fa_reset', 5));
  if (blocked) return blocked;
  const json = await readJson(req, 2_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Body.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const base = enrollLinkBase(); // #347：站点地址不合格时不重置（在 reauth 之前，不消耗失败次数）
  if (!base) return jsonErr('site_url_invalid', 500);
  const r = await reauth(ctx.user, p.data.currentPassword, p.data.totp, p.data.recoveryCode, ctx.ip, 'account.2fa_reset');
  if (r !== 'ok') return jsonErr(r, r === 'locked' ? 423 : 401);
  const now = new Date();
  const t = newEnrollToken({ enrollIssuedAt: now }, now.getTime());
  await prisma.user.update({ where: { id: ctx.user.id }, data: { ...reset2faData(now), ...t.data } }); // 含 sessionVersion+1 = revokeSessions
  const { revokeUserDevices } = await import('@/lib/server/admin/device-repo');
  await revokeUserDevices(prisma, ctx.user.id, 'totp_reset');
  await audit({ actorId: ctx.user.id, action: 'account.2fa_reset', target: ctx.user.id, meta: { via: p.data.totp ? 'totp' : 'recovery_code' }, ip: ctx.ip });
  await auditTokenIssued(ctx.user.id, ctx.user.id, 'self_reset_2fa', ctx.ip, t.expiresTruncated);
  return NextResponse.json({ ok: true, reenrollRequired: true, ...issueResponse(t, base) }, { headers: noStore });
}
