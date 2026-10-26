import { notFound, redirect } from 'next/navigation';
import { adminLoginHref } from '@/lib/admin/safe-callback';
import { checkAdminSession, type SessionDenial } from './guard';

/** 产品规格页面允许的角色（与 /api/admin/specs 一致，SALES 无权） */
export const SPEC_PAGE_ROLES = ['ADMIN', 'EDITOR'] as const;

/** 后台页面的服务端检查：与 requireAdmin 同一套会话/账号/角色规则。返回 null 表示放行，否则返回 401 / 403 */
export async function adminPageDenied(roles: readonly ('ADMIN' | 'EDITOR' | 'SALES')[]): Promise<401 | 403 | null> {
  const c = await checkAdminSession([...roles]);
  return c.ok ? null : c.status;
}

/**
 * 页面级判断（纯函数，便于测试）：与 layout 的 adminGate 同一规则。
 * 未登录（含会话失效、锁定）→ 跳登录页（callbackUrl 只允许站内路径）；仅停用账号或角色不符 → 404。
 */
export function adminPageGate(check: { ok: true } | { ok: false; reason: SessionDenial }, path: string): { action: 'render' } | { action: 'redirect'; to: string } | { action: 'notFound' } {
  if (check.ok) return { action: 'render' };
  return check.reason === 'unauthenticated' ? { action: 'redirect', to: adminLoginHref(path) } : { action: 'notFound' };
}

/** 后台页面的服务端检查并直接执行结果：未登录 redirect 登录页，停用/角色不符 notFound()。用于 /admin/users 等页面 */
export async function enforceAdminPage(roles: readonly ('ADMIN' | 'EDITOR' | 'SALES')[], path: string): Promise<void> {
  const c = await checkAdminSession([...roles]);
  const g = adminPageGate(c.ok ? { ok: true } : { ok: false, reason: c.reason }, path);
  if (g.action === 'redirect') redirect(g.to);
  if (g.action === 'notFound') notFound();
}
