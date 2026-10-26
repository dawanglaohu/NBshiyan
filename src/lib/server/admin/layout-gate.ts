import { adminLoginHref, safeCallbackPath } from '@/lib/admin/safe-callback';

export type AdminRole = 'ADMIN' | 'EDITOR' | 'SALES';

/** 能进入后台任一页面的角色；具体页面再由 ADMIN_ROUTE_ROLES 收紧 */
export const ADMIN_AREA_ROLES = ['ADMIN', 'EDITOR', 'SALES'] as const;

/**
 * 后台页面 → 允许角色（与对应 /api/admin/* 的 requireAdmin 一致）。按路径段前缀匹配，最长前缀优先。
 * 未列出的后台路径默认只允许 ADMIN。
 */
export const ADMIN_ROUTE_ROLES: Readonly<Record<string, readonly AdminRole[]>> = {
  '/admin': ['ADMIN', 'EDITOR', 'SALES'], // 仅精确匹配：首页只做跳转
  '/admin/inquiries': ['ADMIN', 'SALES'],
  '/admin/samples': ['ADMIN', 'SALES'],
  '/admin/models': ['ADMIN', 'EDITOR'],
  '/admin/specs': ['ADMIN', 'EDITOR'],
  '/admin/content': ['ADMIN', 'EDITOR'],
  '/admin/settings': ['ADMIN'],
  '/admin/users': ['ADMIN'],
  '/admin/mail': ['ADMIN'], // #74 未归类邮件：仅 ADMIN（SALES 404）
  '/admin/stats': ['ADMIN'],
};
const EXACT_ONLY = new Set(['/admin']);
const DEFAULT_ROLES: readonly AdminRole[] = ['ADMIN'];

/** 只取路径部分并规范化：去掉查询串、合并多余的尾部斜杠 */
export function normalizeAdminPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const safe = safeCallbackPath(raw, '');
  if (!safe) return null;
  const p = safe.split('?')[0].replace(/\/+$/, '');
  return p || '/';
}

export function rolesForAdminPath(raw: string | null | undefined): readonly AdminRole[] {
  const p = normalizeAdminPath(raw);
  if (!p) return DEFAULT_ROLES; // 缺少或不合法的路径：最严格
  let best: string | null = null;
  for (const key of Object.keys(ADMIN_ROUTE_ROLES)) {
    const hit = p === key || (!EXACT_ONLY.has(key) && p.startsWith(key + '/'));
    if (hit && (!best || key.length > best.length)) best = key;
  }
  return best ? ADMIN_ROUTE_ROLES[best] : DEFAULT_ROLES;
}

export type GateInput = { ok: true; role: string } | { ok: false; reason: 'unauthenticated' | 'disabled' | 'forbidden' | 'unavailable' };
export type GateResult = { action: 'render' } | { action: 'redirect'; to: string } | { action: 'notFound' } | { action: 'unavailable' };

/** 未登录 → 登录页（安全的 callbackUrl）；数据库不可用 → 留在后台；停用账号 / 角色不符 / 该路径不允许此角色 → 404 */
export function adminGate(check: GateInput, path: string | null | undefined): GateResult {
  if (!check.ok) {
    if (check.reason === 'unauthenticated') return { action: 'redirect', to: adminLoginHref(path) };
    if (check.reason === 'unavailable') return { action: 'unavailable' };
    return { action: 'notFound' };
  }
  return (rolesForAdminPath(path) as readonly string[]).includes(check.role) ? { action: 'render' } : { action: 'notFound' };
}
