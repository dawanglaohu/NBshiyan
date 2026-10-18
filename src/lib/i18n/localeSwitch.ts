import { categoryMeta, type CategoryMeta } from '../seo/categoryMeta';
import { CATEGORY_PAGES_LIVE } from '../seo/categoryPages';
import { PUBLISHED_LOCALES, type PublishedLocale } from '@/i18n/published-locales';
import { isBlockedLocalePath } from '../edge/locale-gate';

/** 语言切换只在已发布语言之间进行（清单见 src/i18n/published-locales.ts） */
export type Loc = PublishedLocale;
const LOC_ALT = PUBLISHED_LOCALES.join('|');
const PREFIX_RE = new RegExp(`^/(${LOC_ALT})(?=/|$)`);
/** 页面声明的各语言对应路径（不含 /{locale} 前缀）；null 表示该语言没有对应页面 */
export type LocaleAlternates = Partial<Record<Loc, string | null>>;

/** 有各语言 slug 的详情页前缀 → 没有对应页面时回退的列表页 */
const DETAIL_SECTIONS = ['/products', '/articles', '/solutions'] as const;

/**
 * 语言切换的目标路径（不含 locale 前缀）。
 * 1. 页面给了 alternates（与 hreflang 同源）→ 用目标语言的路径；
 * 2. 品类页 /products/{slug} → 按 categoryMeta 换成目标语言 slug；
 * 3. 其他带 slug 的详情页没有对应页面 → 回退到目标语言的列表页（不会 404）；
 * 4. 普通页面（路径各语言相同）→ 原路径。
 */
export function switchPath(pathname: string, from: Loc, to: Loc, alternates?: LocaleAlternates | null, meta: CategoryMeta[] = categoryMeta, live: boolean = CATEGORY_PAGES_LIVE): string {
  const path = (pathname.replace(PREFIX_RE, '') || '/').replace(/\/+$/, '') || '/';
  const section = DETAIL_SECTIONS.find((s) => path.startsWith(s + '/'));
  if (alternates && to in alternates) {
    const alt = alternates[to];
    if (alt) return alt;
    return section ?? '/';
  }
  if (!section) return path;
  let slug: string;
  try { slug = decodeURIComponent(path.slice(section.length + 1).split('/')[0]); } catch { return '/'; } // 非法 % 编码 → 目标语言首页
  if (section === '/products' && live) { // 品类落地页未上线时目标页也不存在，回退到列表页
    const c = meta.find((m) => m[from]?.slug === slug);
    if (c?.[to]?.slug) return `/products/${c[to].slug}`; // 目标语言没有 slug 时回退到列表页
  }
  return section;
}

const SAFE_RE = new RegExp(`^/(${LOC_ALT})(/[A-Za-z0-9\\-._~%/]*)?$`);

/** 只接受站内相对路径 /{已发布语言}、/{已发布语言}/…；协议相对 //x、反斜杠、编码后的 // 或 \\ 一律回退到目标语言首页 */
export function safeLocaleHref(href: string, to: Loc): string {
  const home = `/${to}`;
  if (typeof href !== 'string' || !SAFE_RE.test(href) || href.includes('//')) return home;
  let dec: string;
  try { dec = decodeURIComponent(href); } catch { return home; }
  if (dec.includes('//') || dec.includes('\\') || /[\u0000-\u001f]/.test(dec) || /(^|\/)\.\.(\/|$)/.test(dec)) return home;
  if (!href.startsWith(`${home}/`) && href !== home) return home;
  return href;
}

/** 语言切换最终链接（带目标 locale 前缀，已校验） */
export function switchHref(pathname: string, from: Loc, to: Loc, alternates?: LocaleAlternates | null, meta?: CategoryMeta[], live?: boolean): string {
  const p = switchPath(pathname, from, to, alternates, meta, live);
  return safeLocaleHref(`/${to}${p === '/' ? '' : p}`, to);
}

/**
 * LangLink 用的最终目标（不含 locale 前缀，交给 next-intl）：路径变了就丢掉 ?query/#hash，
 * 只有路径不变时才保留 suffix（suffix 只会接在已校验的路径后面，不参与生成路径）。
 */
export function langSwitchTarget(pathname: string, from: Loc, to: Loc, alternates: LocaleAlternates | null | undefined, suffix: string): string {
  const full = switchHref(pathname, from, to, alternates);
  const target = full.slice(3) || '/';
  const tail = /^[?#]/.test(suffix) ? suffix : '';
  return target === pathname ? target + tail : target;
}

/**
 * 语言下拉 / 页脚链接用的目标（不含 locale 前缀）。
 * rawPathname = 浏览器地址栏的路径（next/navigation 的 usePathname，不受 middleware rewrite 影响）。
 * 在未发布语言的 404 页上（地址栏是 /ja、/EN/…，内容由 rewrite 渲染），一律去目标语言首页（/en、/ru），
 * 不拿 /ja 当路径拼出 /ru/ja 这种链接。
 */
export function menuSwitchTarget(rawPathname: string | null | undefined, pathname: string, from: Loc, to: Loc, alternates: LocaleAlternates | null | undefined, suffix: string): string {
  // 服务端渲染时看到的是 rewrite 后的 /en/locale-unavailable，客户端看到的是地址栏的 /ja：两种都按 404 页处理，避免 hydration 不一致
  if (isBlockedLocalePath(rawPathname ?? '') || /^\/locale-unavailable\/?$/.test(pathname)) return '/';
  return langSwitchTarget(pathname, from, to, alternates, suffix);
}
