import { isPublishedLocale } from '@/i18n/published-locales';

/**
 * 多语言第 0 期：未发布语言的页面一律 404 + noindex（中间件在 next-intl 之前调用）。
 * 只按白名单放行：首段「看起来像语言代码」时，只有 isPublishedLocale 接受的值（en、ru，区分大小写）才放行，
 * 其余一律拦下 —— 预留语言 es/de/fr/ja/hi/ar、未知代码 xx、大小写变体 EN/Ru、地区变体 en-US/en_us。
 * 拦下的请求直接给 404，不跳转（不做 /EN → /en 之类的规范化，避免开放跳转和缓存键分裂）。
 *
 * 只作用于首段是 2 个字母（可带 -/_ 地区后缀，如 en-US、zh-Hant-TW）的页面路径。
 * 其余首段（api、admin、admin-enroll、_next、s、products、contact……以及带扩展名的静态文件）不受影响；
 * 它们大多本来就不进 middleware（见 middleware.ts 的 matcher），这里再按形状排除一次。
 */
const LOCALE_LIKE_RE = /^[a-z]{2}(?:[-_][a-z0-9]{2,8})*$/i;
/** 首段是 2 个字母、但不是语言代码的站内路径（保持原行为，交给 next-intl）。新增这类顶层路由时加在这里并补测试 */
export const NON_LOCALE_TOP_SEGMENTS: ReadonlySet<string> = new Set(['og']);

/** 被拦下的请求 rewrite 到这个路径：src/app/[locale]/locale-unavailable 永远 notFound()，由同目录 not-found.tsx 渲染带头部页脚的英文 404 页。URL 不变、不跳转 */
export const LOCALE_GATE_REWRITE = '/en/locale-unavailable';

/** true = 这个页面路径要直接 404（未发布 / 未知 / 非规范写法的语言前缀） */
export function isBlockedLocalePath(pathname: string): boolean {
  const seg = pathname.split('/')[1] ?? '';
  if (!LOCALE_LIKE_RE.test(seg) || NON_LOCALE_TOP_SEGMENTS.has(seg.toLowerCase())) return false;
  return !isPublishedLocale(seg);
}
