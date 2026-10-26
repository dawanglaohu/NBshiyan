import { notFound, redirect } from 'next/navigation';
import { adminLoginHref } from '@/lib/admin/safe-callback';
import { checkAdminSession, type SessionDenial } from './guard';

/** 产品规格页面允许的角色（与 /api/admin/specs 一致，SALES 无权） */
export const SPEC_PAGE_ROLES = ['ADMIN', 'EDITOR'] as const;

/** 后台页面的服务端检查：与 requireAdmin 同一套会话/账号/角色规则。返回 null 表示放行，否则返回 401 / 403 / 503 */
export async function adminPageDenied(roles: readonly ('ADMIN' | 'EDITOR' | 'SALES')[]): Promise<401 | 403 | 503 | null> {
  const c = await checkAdminSession([...roles]);
  return c.ok ? null : c.status;
}

/**
 * 页面级判断（纯函数，便于测试）：与 layout 的 adminGate 同一规则。
 * 未登录（含会话失效、锁定、未开 2FA）→ 跳登录页（callbackUrl 只允许站内路径）。
 * 数据库不可用 → 不跳转、不 404，由 layout 换成错误卡片。仅停用账号或角色不符 → 404。
 */
export function adminPageGate(check: { ok: true } | { ok: false; reason: SessionDenial }, path: string): { action: 'render' } | { action: 'redirect'; to: string } | { action: 'notFound' } | { action: 'unavailable' } {
  if (check.ok) return { action: 'render' };
  if (check.reason === 'unauthenticated') return { action: 'redirect', to: adminLoginHref(path) };
  if (check.reason === 'unavailable') return { action: 'unavailable' };
  return { action: 'notFound' };
}

/** 后台页面的服务端检查并直接执行结果：未登录 redirect 登录页，停用/角色不符 notFound()。数据库不可用时返回，不跳转。 */
export async function enforceAdminPage(roles: readonly ('ADMIN' | 'EDITOR' | 'SALES')[], path: string): Promise<void | 'unavailable'> {
  const c = await checkAdminSession([...roles]);
  const g = adminPageGate(c.ok ? { ok: true } : { ok: false, reason: c.reason }, path);
  if (g.action === 'redirect') redirect(g.to);
  if (g.action === 'notFound') notFound();
  if (g.action === 'unavailable') return 'unavailable';
}
