/**
 * 登录后回跳地址只允许站内相对路径（#91）：以单个 '/' 开头，不能是 '//'、'/\'，不含控制字符或反斜杠。
 * 不合法一律回落到 fallback，防止开放重定向。
 */
export function safeCallbackPath(raw: string | null | undefined, fallback = '/admin'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const base = 'https://admin.invalid';
    const u = new URL(raw, base);
    if (u.origin !== base) return fallback;
    return u.pathname + u.search;
  } catch { return fallback; }
}

const ADMIN_CALLBACK_FALLBACK = '/admin/inquiries';

/**
 * 登录后只回到后台。先按站内路径规范化，再拒绝 %2f / %5c / %2e，
 * 规范化结果必须正好是 /admin，或落在 /admin/ 下面。其余回到询盘列表。
 * 对已经规范化的结果再调用一次，结果不变。
 */
export function adminCallbackPath(raw: string | null | undefined): string {
  const normalized = safeCallbackPath(raw, ADMIN_CALLBACK_FALLBACK);
  if (typeof raw === 'string' && /%2f|%5c|%2e/i.test(raw)) return ADMIN_CALLBACK_FALLBACK;
  const path = normalized.split('?')[0] ?? normalized;
  if (path !== '/admin' && !path.startsWith('/admin/')) return ADMIN_CALLBACK_FALLBACK;
  return normalized;
}

export function adminLoginHref(path: string | null | undefined): string {
  return `/api/auth/signin?callbackUrl=${encodeURIComponent(safeCallbackPath(path))}`;
}
