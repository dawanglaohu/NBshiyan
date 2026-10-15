import { routing } from '@/i18n/routing';

const LOCALES = routing.locales.join('|');
const ADMIN_RE = new RegExp(`^/(?:(?:${LOCALES})/)?admin(?:/|$)`, 'i');

/** Tawk.to must never load on admin pages: /admin, /admin/*, and locale-prefixed /en/admin… */
export function isAdminPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  let p = pathname.split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  p = p.replace(/\/{2,}/g, '/');
  return ADMIN_RE.test(p);
}
