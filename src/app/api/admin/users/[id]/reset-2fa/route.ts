import { NextResponse } from 'next/server';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { ID_RE } from '@/lib/server/admin/inquiries';
import { guardResponse, mutateUser, publicUser, reset2faData } from '@/lib/server/admin/accounts';
import { auditTokenIssued, enrollLinkBase, issueResponse, newEnrollToken } from '@/lib/server/admin/enroll-token';

export const runtime = 'nodejs';

/** 管理员重置他人 2FA（对方丢了手机和恢复码）。清空密钥和恢复码、对方所有会话失效、重新打开 72 小时绑定窗口（#347）；对方需重新 enroll。不能对自己用（自己走 /api/admin/account/2fa/reset）。
 * #347 方案 A：同一次写入里签发新的一次性绑定令牌（覆盖旧哈希，之前发出的链接立即失效），响应体里返回一次 enrollLink。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'users.reset_2fa', 10));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const base = enrollLinkBase(); // #347：站点地址不合格时不重置（否则对方没有链接、没法重新绑定）
  if (!base) return jsonErr('site_url_invalid', 500);
  try {
    const now = new Date();
    const t = newEnrollToken({ enrollIssuedAt: now }, now.getTime());
    const u = await mutateUser(ctx.user, id, {}, (tx) => tx.user.update({ where: { id }, data: { ...reset2faData(now), ...t.data } }));
    await audit({ actorId: ctx.user.id, action: 'user.reset_2fa', target: id, ip: ctx.ip });
    await auditTokenIssued(ctx.user.id, id, 'admin_reset_2fa', ctx.ip, t.expiresTruncated);
    return NextResponse.json({ ...publicUser(u), ...issueResponse(t, base) }, { headers: noStore });
  } catch (e) { return guardResponse(e); }
}
