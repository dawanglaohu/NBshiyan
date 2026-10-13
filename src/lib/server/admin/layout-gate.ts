import { adminLoginHref } from '@/lib/admin/safe-callback';

/** 能进入后台任一页面的角色；各页面 / 接口再按自身需要收紧（如规格页只放 ADMIN、EDITOR） */
export const ADMIN_AREA_ROLES = ['ADMIN', 'EDITOR', 'SALES'] as const;

export type GateInput = { ok: true } | { ok: false; status: 401 | 403 };
export type GateResult = { action: 'render' } | { action: 'redirect'; to: string } | { action: 'notFound' };

/** 纯函数：根据 checkAdminSession 的结果决定 /admin layout 的行为。401 → 登录页（带安全的 callbackUrl）；403 → 404 */
export function adminGate(check: GateInput, path: string | null | undefined): GateResult {
  if (check.ok) return { action: 'render' };
  if (check.status === 401) return { action: 'redirect', to: adminLoginHref(path) };
  return { action: 'notFound' };
}
