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

export function adminLoginHref(path: string | null | undefined): string {
  return `/api/auth/signin?callbackUrl=${encodeURIComponent(safeCallbackPath(path))}`;
}
