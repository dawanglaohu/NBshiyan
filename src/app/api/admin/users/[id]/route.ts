import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, assertSameOrigin, adminRateLimit } from '@/lib/server/auth';
import { jsonErr, noStore } from '@/lib/server/admin/guard';
import { audit } from '@/lib/server/admin/audit';
import { ID_RE, readJson, TOO_LARGE } from '@/lib/server/admin/inquiries';
import { guardResponse, mutateUser, publicUser } from '@/lib/server/admin/accounts';

export const runtime = 'nodejs';
type P = { params: Promise<{ id: string }> };

const Patch = z.object({
  role: z.enum(['ADMIN', 'SALES', 'EDITOR']).optional(),
  disabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  unlock: z.literal(true).optional(), // 解除登录锁定
}).strict().refine((b) => Object.keys(b).length > 0, 'empty');

/** 改角色 / 停用 / 启用 / 改名 / 解锁（仅 ADMIN；不能改自己；不能去掉最后一个有效管理员）。改角色或停用会让对方所有会话失效。 */
export async function PATCH(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? adminRateLimit(req, 'users.update', 30);
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  const json = await readJson(req, 1_000);
  if (json === TOO_LARGE) return jsonErr('too_large', 413);
  const p = Patch.safeParse(json);
  if (!p.success) return jsonErr('invalid', 400);
  const b = p.data;
  try {
    const { before, after } = await mutateUser(ctx.user, id, () => (b.role !== undefined && b.role !== 'ADMIN') || b.disabled === true, async (tx, t) => {
      const after = await tx.user.update({
        where: { id },
        data: {
          ...(b.role !== undefined ? { role: b.role } : {}),
          ...(b.disabled !== undefined ? { disabled: b.disabled } : {}),
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.unlock ? { lockedUntil: null, failedLogins: 0 } : {}),
          sessionVersion: { increment: 1 }, // revokeSessions：权限变化后旧会话立即失效
        },
      });
      // 停用或改成非 SALES 角色时，取消其名下询盘的分配
      if (b.disabled === true || (b.role && b.role === 'EDITOR')) await tx.inquiry.updateMany({ where: { assigneeId: id }, data: { assigneeId: null } });
      return { before: t, after };
    });
    await audit({ actorId: ctx.user.id, action: 'user.update', target: id, meta: { fields: Object.keys(b), before: { role: before.role, disabled: before.disabled }, after: { role: after.role, disabled: after.disabled } }, ip: ctx.ip });
    return NextResponse.json(publicUser(after), { headers: noStore });
  } catch (e) { return guardResponse(e); }
}

/** 删除账号（仅 ADMIN；不能删自己或最后一个有效管理员）。名下询盘取消分配；审计记录保留。 */
export async function DELETE(req: Request, { params }: P) {
  const ctx = await requireAdmin(req, ['ADMIN']);
  if (ctx instanceof Response) return ctx;
  const blocked = assertSameOrigin(req) ?? adminRateLimit(req, 'users.delete', 10);
  if (blocked) return blocked;
  const { id } = await params;
  if (!ID_RE.test(id)) return jsonErr('not_found', 404);
  try {
    const t = await mutateUser(ctx.user, id, () => true, async (tx, t) => {
      await tx.inquiry.updateMany({ where: { assigneeId: id }, data: { assigneeId: null } });
      await tx.user.delete({ where: { id } }); // 账号不存在了，JWT 回调查不到用户，会话立即失效
      return t;
    });
    await audit({ actorId: ctx.user.id, action: 'user.delete', target: id, meta: { role: t.role }, ip: ctx.ip });
    return new Response(null, { status: 204, headers: noStore });
  } catch (e) { return guardResponse(e); }
}
