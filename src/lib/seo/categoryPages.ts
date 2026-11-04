import { PUBLISHED_LOCALES, type PublishedLocale } from '../../i18n/published-locale-list';
import { categoryMeta } from './categoryMeta';
import { categorySlugs } from './categorySlugs';

/**
 * 品类落地页 /{locale}/products/{各语言 slug} 是否已上线。
 * true 时页面、sitemap、hreflang、页脚和目录卡指向品类页，合入后随下一次部署生效。
 * 传入 live=false 时仍是未上线行为：路径为 null，链接回到 3D 目录锚点。
 */
export const CATEGORY_PAGES_LIVE = true;

/**
 * 品类页当前真正上线的语言。fix1 口径：只上 en，ru 文案仍是草稿（categoryMeta 里标 draft:true），
 * 不随开关一起发布，也不靠删草稿标记冒充审校通过。
 * 因此 ru 的品类页路径、hreflang、sitemap 条目都不输出，入口回退到 /{locale}/products。
 * ru 通过母语审核后，只需把 'ru' 加进这个清单。
 */
export const CATEGORY_LIVE_LOCALES = ['en'] as const;
export type CategoryLiveLocale = (typeof CATEGORY_LIVE_LOCALES)[number];

export function isCategoryLocaleLive(locale: string): locale is CategoryLiveLocale {
  return (CATEGORY_LIVE_LOCALES as readonly string[]).includes(locale);
}

/** 品类落地页路径（不含域名），如 /ru/products/podarochnye-korobki；未上线、非上线语言或未知 key 返回 null，调用方回退到 /{locale}/products。 */
export function categoryPagePath(locale: 'en' | 'ru', key: string, live: boolean = CATEGORY_PAGES_LIVE): string | null {
  if (!live) return null;
  if (!isCategoryLocaleLive(locale)) return null;
  const s = categorySlugs(key);
  return s ? `/${locale}/products/${encodeURIComponent(s[locale])}` : null;
}

/** 站内 next-intl <Link> 用的品类链接（不含 locale 前缀）：落地页上线后指向 /products/{slug}，否则回退到 3D 目录里的卡片 /products#{key} */
export function categoryHref(locale: 'en' | 'ru', key: string, live: boolean = CATEGORY_PAGES_LIVE): string {
  const p = categoryPagePath(locale, key, live);
  return p ? p.slice(locale.length + 1) : `/products#${encodeURIComponent(key)}`;
}

/** 品类落地页给语言切换器的各语言路径（不含 locale 前缀），如 { en: '/products/custom-gift-boxes', ru: '/products/podarochnye-korobki' } */
/**
 * 品类落地页给语言切换器的各语言路径（不含 locale 前缀）。
 * 只对「本体已上线语言」给出品类页路径；未上线语言（fix1 下的 ru）回退到该语言的 3D 目录，
 * 避免语言切换把用户送到将来才存在的 404 页面。
 */
export function categoryLocaleAlternates(key: string, live: boolean = CATEGORY_PAGES_LIVE): { en: string; ru: string } | null {
  const s = categorySlugs(key);
  if (!s) return null;
  const pathFor = (locale: 'en' | 'ru'): string =>
    live && isCategoryLocaleLive(locale) ? `/products/${s[locale]}` : '/products';
  return { en: pathFor('en'), ru: pathFor('ru') };
}

export function findCategoryBySlug(locale: 'en' | 'ru', slug: string) {
  let decoded = slug;
  try { decoded = decodeURIComponent(slug); } catch { return undefined; }
  return categoryMeta.find((c) => c[locale].slug === decoded);
}

/**
 * live=false 时不解析 slug，页面因此 404，也不会输出这批 URL 的 hreflang。
 * 未上线语言（fix1 下的 ru）同样 404：ru 文案仍是草稿，不能靠 URL 直接访问到未审校内容。
 */
export function categoryForRequest(locale: 'en' | 'ru', slug: string, live: boolean) {
  if (!live) return undefined;
  if (!isCategoryLocaleLive(locale)) return undefined;
  return findCategoryBySlug(locale, slug);
}

/**
 * 品类页 canonical 旁边的 hreflang。live=false 时没有这组链接。
 * 只输出「已上线语言」的条目：fix1 口径下只有 en，因此不会出现指向未上线 ru 的 hreflang。
 * x-default 取默认已上线语言（en）；若它未上线则不输出 x-default。
 */
export function categoryLanguageAlternates(key: string, live: boolean, locales: readonly PublishedLocale[] = PUBLISHED_LOCALES, xDefault: PublishedLocale = PUBLISHED_LOCALES[0]): Record<string, string> | null {
  if (!live) return null;
  const languages: Record<string, string> = {};
  let emitted = 0;
  for (const locale of locales) {
    // 跳过未上线语言，而不是让整组变 null：ru 未上线不应连带丢掉 en 的 hreflang。
    if (!isCategoryLocaleLive(locale)) continue;
    const path = categoryPagePath(locale, key, true);
    if (!path) continue;
    languages[locale] = path;
    emitted += 1;
  }
  if (emitted === 0) return null;
  if (isCategoryLocaleLive(xDefault)) {
    const fallback = categoryPagePath(xDefault, key, true);
    if (fallback) languages['x-default'] = fallback;
  }
  return languages;
}
