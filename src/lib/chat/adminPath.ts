import { routing } from '@/i18n/routing';

const LOCALES = routing.locales.join('|');
const ADMIN_RE = new RegExp(`^/(?:(?:${LOCALES})/)?admin(?:/|$)`, 'i');

/** True for /admin, /admin/*, and locale-prefixed admin paths. Third-party chat is not loaded on these paths or on public pages. */
export function isAdminPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  let p = pathname.split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  p = p.replace(/\/{2,}/g, '/');
  return ADMIN_RE.test(p);
}
