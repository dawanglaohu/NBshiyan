import { PUBLISHED_LOCALES, type PublishedLocale } from '../../i18n/published-locale-list';
import { categoryMeta } from './categoryMeta';
import { categorySlugs } from './categorySlugs';

/**
 * 品类落地页 /{locale}/products/{各语言 slug} 是否已上线。
 * true 时页面、sitemap、hreflang、页脚和目录卡指向品类页，合入后随下一次部署生效。
 * 传入 live=false 时仍是未上线行为：路径为 null，链接回到 3D 目录锚点。
 */
export const CATEGORY_PAGES_LIVE = true;

/** 品类落地页路径（不含域名），如 /ru/products/podarochnye-korobki；未上线或未知 key 返回 null，调用方回退到 /{locale}/products。 */
export function categoryPagePath(locale: 'en' | 'ru', key: string, live: boolean = CATEGORY_PAGES_LIVE): string | null {
  if (!live) return null;
  const s = categorySlugs(key);
  return s ? `/${locale}/products/${encodeURIComponent(s[locale])}` : null;
}

/** 站内 next-intl <Link> 用的品类链接（不含 locale 前缀）：落地页上线后指向 /products/{slug}，否则回退到 3D 目录里的卡片 /products#{key} */
export function categoryHref(locale: 'en' | 'ru', key: string, live: boolean = CATEGORY_PAGES_LIVE): string {
  const p = categoryPagePath(locale, key, live);
  return p ? p.slice(locale.length + 1) : `/products#${encodeURIComponent(key)}`;
}

/** 品类落地页给语言切换器的各语言路径（不含 locale 前缀），如 { en: '/products/custom-gift-boxes', ru: '/products/podarochnye-korobki' } */
export function categoryLocaleAlternates(key: string): { en: string; ru: string } | null {
  const s = categorySlugs(key);
  return s ? { en: `/products/${s.en}`, ru: `/products/${s.ru}` } : null;
}

export function findCategoryBySlug(locale: 'en' | 'ru', slug: string) {
  let decoded = slug;
  try { decoded = decodeURIComponent(slug); } catch { return undefined; }
  return categoryMeta.find((c) => c[locale].slug === decoded);
}

/** live=false 时不解析 slug，页面因此 404，也不会输出这批 URL 的 hreflang。 */
export function categoryForRequest(locale: 'en' | 'ru', slug: string, live: boolean) {
  if (!live) return undefined;
  return findCategoryBySlug(locale, slug);
}

/** 品类页 canonical 旁边的 en / ru / x-default。live=false 时没有这组链接。 */
export function categoryLanguageAlternates(key: string, live: boolean, locales: readonly PublishedLocale[] = PUBLISHED_LOCALES, xDefault: PublishedLocale = PUBLISHED_LOCALES[0]): Record<string, string> | null {
  if (!live) return null;
  const languages: Record<string, string> = {};
  for (const locale of locales) {
    const path = categoryPagePath(locale, key, true);
    if (!path) return null;
    languages[locale] = path;
  }
  const fallback = categoryPagePath(xDefault, key, true);
  if (!fallback) return null;
  languages['x-default'] = fallback;
  return languages;
}
