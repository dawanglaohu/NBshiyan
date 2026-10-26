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

/** 绝对地址只认配置里的源。APP_ORIGIN 有值时只用它，解析失败也不改看 AUTH_URL。两者都没有或解析失败时，绝对地址一律拒绝。 */
function configuredCallbackOrigin(): string | null {
  const app = process.env.APP_ORIGIN;
  const chosen = typeof app === 'string' && app.length > 0 ? app : process.env.AUTH_URL;
  if (typeof chosen !== 'string' || chosen.length === 0) return null;
  try {
    return new URL(chosen).origin;
  } catch {
    return null;
  }
}

/**
 * 同源绝对地址收成 pathname + search（丢掉 hash）。
 * 源只来自 APP_ORIGIN / AUTH_URL，不读 Host 或 X-Forwarded-*。
 * 不是绝对地址时原样返回，交给后面的站内规则。
 */
function relativeAdminCallback(raw: string | null | undefined): string | null | undefined {
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  const origin = configuredCallbackOrigin();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!origin || parsed.origin !== origin || /%2f|%5c|%2e/i.test(raw)) return null;
  return parsed.pathname + parsed.search;
}

/**
 * 登录后只回到后台。绝对地址先收成同源路径，再按站内路径规范化，并拒绝 %2f / %5c / %2e。
 * 规范化结果必须正好是 /admin，或落在 /admin/ 下面。其余回到询盘列表。
 * 对已经规范化的结果再调用一次，结果不变。
 */
export function adminCallbackPath(raw: string | null | undefined): string {
  const candidate = relativeAdminCallback(raw);
  const normalized = safeCallbackPath(candidate, ADMIN_CALLBACK_FALLBACK);
  if (typeof candidate === 'string' && /%2f|%5c|%2e/i.test(candidate)) return ADMIN_CALLBACK_FALLBACK;
  const path = normalized.split('?')[0] ?? normalized;
  if (path !== '/admin' && !path.startsWith('/admin/')) return ADMIN_CALLBACK_FALLBACK;
  return normalized;
}

/** 后台页面、绑定页和会话失效后的回跳都进自定义登录页，不再经过 /api/auth/signin。 */
export function adminLoginHref(path: string | null | undefined): string {
  return `/admin-login?callbackUrl=${encodeURIComponent(adminCallbackPath(path))}`;
}
