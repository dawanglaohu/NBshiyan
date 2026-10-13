import { z } from 'zod';
import type { Prisma, Role, User } from '@prisma/client';
import { prisma } from '../db';
import { verifySecret, hashSecret } from './crypto';
import { checkSecondFactor, MAX_FAILS, LOCK_MS } from './login';
import { audit } from './audit';
import { jsonErr } from './guard';

/** 密码策略：12–200 位，不能等于邮箱 */
export const Password = z.string().min(12, 'min_12').max(200);
export function passwordPolicyError(pw: string, email: string) {
  const r = Password.safeParse(pw);
  if (!r.success) return 'weak_password';
  if (pw.trim().toLowerCase() === email.toLowerCase()) return 'weak_password';
  return null;
}
export const hashPassword = hashSecret;

/**
 * 敏感操作的再次验证：当前密码 + TOTP（或恢复码）。
 * 失败计入 failedLogins，连续 5 次锁定 15 分钟（与登录共用计数）。
 */
export async function reauth(user: User, password: string, totp: string | undefined, recovery: string | undefined, ip: string | null, action: string) {
  if (user.lockedUntil && user.lockedUntil > new Date()) return 'locked' as const;
  const ok = (await verifySecret(user.passwordHash, password)) && (await checkSecondFactor(user, totp, recovery));
  if (ok) {
    if (user.failedLogins) await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0 } });
    return 'ok' as const;
  }
  const n = user.failedLogins + 1;
  await prisma.user.update({ where: { id: user.id }, data: n >= MAX_FAILS ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: n } });
  await audit({ actorId: user.id, action: `${action}_fail`, target: user.id, meta: { reason: 'reauth_failed', locked: n >= MAX_FAILS }, ip });
  return 'bad_credentials' as const;
}

/** 清空 2FA 并让会话失效；用户下次需重新走 /api/auth-admin/enroll */
export const RESET_2FA: Prisma.UserUpdateInput = { totpEnabled: false, totpSecret: null, totpLastStep: null, recoveryCodes: [], sessionVersion: { increment: 1 } };

/** 撤销该账号所有会话（改角色、停用共用） */
export const REVOKE_SESSIONS = { sessionVersion: { increment: 1 } } as const;
/** 停用（手动 PATCH 和闲置自动停用共用）：停用 + 会话失效 + 取消其名下询盘分配 */
export async function disableUserTx(tx: Prisma.TransactionClient, id: string) {
  const u = await tx.user.update({ where: { id }, data: { disabled: true, ...REVOKE_SESSIONS } });
  await unassignInquiries(tx, id);
  return u;
}
export const unassignInquiries = (tx: Prisma.TransactionClient, id: string) => tx.inquiry.updateMany({ where: { assigneeId: id }, data: { assigneeId: null } });

export class GuardError extends Error { constructor(public code: 'last_admin' | 'self' | 'not_found') { super(code); } }

/**
 * 在事务里改账号，保证至少保留一个“有效管理员”（role=ADMIN 且未禁用）。
 * 用 advisory lock 串行化所有账号变更，避免两个请求同时各降级一个管理员。
 */
export async function mutateUser<T>(actor: User, targetId: string, willRemoveAdmin: (t: User) => boolean, fn: (tx: Prisma.TransactionClient, t: User) => Promise<T>) {
  if (targetId === actor.id) throw new GuardError('self');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('admin-accounts'))`;
    const t = await tx.user.findUnique({ where: { id: targetId } });
    if (!t) throw new GuardError('not_found');
    if (t.role === 'ADMIN' && !t.disabled && willRemoveAdmin(t)) {
      const others = await tx.user.count({ where: { role: 'ADMIN', disabled: false, id: { not: t.id } } });
      if (others === 0) throw new GuardError('last_admin');
    }
    return fn(tx, t);
  });
}

export const publicUser = (u: User) => ({
  id: u.id, email: u.email, name: u.name, role: u.role as Role, disabled: u.disabled, totpEnabled: u.totpEnabled,
  locked: !!(u.lockedUntil && u.lockedUntil > new Date()), createdAt: u.createdAt,
});

/** GuardError 转成响应：404 / 409 cannot_modify_self / 409 last_admin */
export function guardResponse(e: unknown) {
  if (e instanceof GuardError) {
    if (e.code === 'not_found') return jsonErr('not_found', 404);
    if (e.code === 'self') return jsonErr('cannot_modify_self', 409);
    return jsonErr('last_admin', 409);
  }
  throw e;
}

