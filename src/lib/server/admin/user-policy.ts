import type { Role } from '@prisma/client';

/** 账号邮箱规范化：去空白、NFKC、小写。不去 +后缀/点（登录账号必须按原地址收信，与询价的 normalizeEmail 不同） */
export function normalizeAccountEmail(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

export type UserChange = { role?: Role; disabled?: boolean; name?: string; unlock?: true };
export type PolicyError = 'cannot_modify_self' | 'last_admin';

/** 这次改动会不会让目标不再是“有效管理员”（role=ADMIN 且未停用） */
export function removesActiveAdmin(target: { role: Role; disabled: boolean }, c: UserChange): boolean {
  if (target.role !== 'ADMIN' || target.disabled) return false;
  return (c.role !== undefined && c.role !== 'ADMIN') || c.disabled === true;
}

/**
 * 纯规则（mutateUser 在事务 + advisory lock 内调用）：
 * - 管理员不能改自己（含停用、降级）
 * - 不能让有效管理员数量变成 0
 */
export function checkUserChange(actorId: string, target: { id: string; role: Role; disabled: boolean }, c: UserChange | 'delete', otherActiveAdmins: number): PolicyError | null {
  if (actorId === target.id) return 'cannot_modify_self';
  const removes = c === 'delete' ? target.role === 'ADMIN' && !target.disabled : removesActiveAdmin(target, c);
  if (removes && otherActiveAdmins === 0) return 'last_admin';
  return null;
}

/** 会让对方旧会话失效的改动：角色、停用/启用、解锁 —— 统一 sessionVersion+1 */
export const bumpsSession = (c: UserChange) => c.role !== undefined || c.disabled !== undefined || c.unlock === true;

/** 审计 meta：只记字段名与 before→after，不含密码、哈希、TOTP、恢复码 */
export function auditDiff(before: { role: Role; disabled: boolean; name: string }, after: { role: Role; disabled: boolean; name: string }, c: UserChange) {
  const changes: Record<string, { from: string | boolean | null; to: string | boolean | null }> = {};
  for (const k of ['role', 'disabled', 'name'] as const) if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
  if (c.unlock) changes.locked = { from: true, to: false };
  return { fields: Object.keys(c), changes };
}
