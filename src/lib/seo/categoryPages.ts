import { categorySlugs } from './categorySlugs';

/**
 * 12 个品类落地页 /{locale}/products/{各语言 slug} 是否已上线。
 * 路由 [locale]/products/[slug] 合并前保持 false，避免 sitemap 和站内链接指向 404。
 * 落地页 PR 合并时改成 true。
 */
export const CATEGORY_PAGES_LIVE = false;

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
