import { NextResponse } from 'next/server';
import { requireAdmin, assertSameOrigin, enforceAdminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { ID_RE } from '@/lib/server/admin/inquiries';
import { guardResponse, mutateUser, publicUser, reset2faData } from '@/lib/server/admin/accounts';

export const runtime = 'nodejs';

/** 管理员重置他人 2FA（对方丢了手机和恢复码）。清空密钥和恢复码、对方所有会话失效、重新打开 72 小时绑定窗口（#347）；对方需重新 enroll。不能对自己用（自己走 /api/admin/account/2fa/reset）。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? (await enforceAdminRateLimit(req, 'users.reset_2fa', 10));
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  try {
    const u = await mutateUser(ctx.user, id, {}, (tx) => tx.user.update({ where: { id }, data: reset2faData() }));
    await audit({ actorId: ctx.user.id, action: 'user.reset_2fa', target: id, ip: ctx.ip });
    return NextResponse.json(publicUser(u), { headers: noStore });
  } catch (e) { return guardResponse(e); }
}
