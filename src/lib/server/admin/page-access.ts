import { createElement, type ReactElement } from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import AdminOutageNotice from '@/components/admin/AdminOutageNotice';
import { outageCopy, outageLang, type OutageKind } from '@/lib/admin/outage-copy';
import { adminLoginHref } from '@/lib/admin/safe-callback';
import { checkAdminSession, type SessionDenial } from './guard';

/** 产品规格页面允许的角色（与 /api/admin/specs 一致，SALES 无权） */
export const SPEC_PAGE_ROLES = ['ADMIN', 'EDITOR'] as const;

const NOTICE_FALLBACK = '/admin';

/** 重试地址只接受服务端拼好的后台相对路径。不读 Host、转发头、Referer 或查询串。非法值回到 /admin。 */
export function adminNoticeHref(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return NOTICE_FALLBACK;
  const path = raw.split('#')[0]?.split('?')[0] ?? '';
  return isAdminNoticePath(path) ? path : NOTICE_FALLBACK;
}

function isAdminNoticePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (path.includes('\\') || path.includes('//') || path.includes(':')) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (/%2f|%5c/i.test(path)) return false;
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  if (decoded !== '/admin' && !decoded.startsWith('/admin/')) return false;
  if (decoded.includes('\\') || decoded.includes('//') || decoded.includes(':')) return false;
  if (decoded.split('/').includes('..')) return false;
  return true;
}

export async function adminOutageNotice(path: string, kind: OutageKind = 'unavailable'): Promise<ReactElement> {
  const accept = (await headers()).get('accept-language');
  return createElement(AdminOutageNotice, {
    copy: outageCopy(accept, kind),
    href: adminNoticeHref(path),
    lang: outageLang(accept),
  });
}

/** 后台页面的服务端检查：与 requireAdmin 同一套会话/账号/角色规则。返回 null 表示放行。 */
export async function adminPageDenied(roles: readonly ('ADMIN' | 'EDITOR' | 'SALES')[]): Promise<401 | 403 | 500 | 503 | null> {
  const c = await checkAdminSession([...roles]);
  return c.ok ? null : c.status;
}

/**
 * 页面级判断（纯函数，便于测试）：与 layout 的 adminGate 同一规则。
 * 未登录（含会话失效、锁定）→ 跳登录页（callbackUrl 只允许站内路径）。
 * 数据库不可用或服务出错 → 不跳转、不 404，由页面换成错误卡片。仅停用账号或角色不符 → 404。
 */
export function adminPageGate(check: { ok: true } | { ok: false; reason: SessionDenial }, path: string): { action: 'render' } | { action: 'redirect'; to: string } | { action: 'notFound' } | { action: 'unavailable' } | { action: 'internal' } {
  if (check.ok) return { action: 'render' };
  if (check.reason === 'unauthenticated') return { action: 'redirect', to: adminLoginHref(path) };
  if (check.reason === 'unavailable') return { action: 'unavailable' };
  if (check.reason === 'internal') return { action: 'internal' };
  return { action: 'notFound' };
}

/** 后台页面的服务端检查并直接执行结果。数据库不可用和服务出错都返回错误卡，保留 cookie，不跳登录。 */
export async function enforceAdminPage(roles: readonly ('ADMIN' | 'EDITOR' | 'SALES')[], path: string): Promise<{ ok: true } | { ok: false; notice: ReactElement }> {
  const c = await checkAdminSession([...roles]);
  const g = adminPageGate(c.ok ? { ok: true } : { ok: false, reason: c.reason }, path);
  if (g.action === 'redirect') redirect(g.to);
  if (g.action === 'notFound') notFound();
  if (g.action === 'render') return { ok: true };
  const kind: OutageKind = g.action === 'internal' ? 'internal' : 'unavailable';
  return { ok: false, notice: await adminOutageNotice(path, kind) };
}
