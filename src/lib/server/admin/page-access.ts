import { checkAdminSession } from './guard';

/** 产品规格页面允许的角色（与 /api/admin/specs 一致，SALES 无权） */
export const SPEC_PAGE_ROLES = ['ADMIN', 'EDITOR'] as const;

/** 后台页面的服务端检查：与 requireAdmin 同一套会话/账号/角色规则。返回 null 表示放行，否则返回 401 / 403 */
export async function adminPageDenied(roles: readonly ('ADMIN' | 'EDITOR' | 'SALES')[]): Promise<401 | 403 | null> {
  const c = await checkAdminSession([...roles]);
  return c.ok ? null : c.status;
}
