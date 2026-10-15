import { categoryHref } from './categoryPages';
import type { Locale } from './templates';

/**
 * BreadcrumbList JSON-LD（schema.org）。URL 一律是本站绝对地址（siteUrl + /{locale} + 路径）。
 * 品类链接必须走 categoryHref()（#195，已做 encodeURIComponent），不要另外拼路径。
 * 只通过 src/components/seo/JsonLd.tsx 输出。
 */
export type Crumb = { name: string; path: string };
export const BREADCRUMB_LABELS: Record<'home' | 'products' | 'articles', Record<Locale, string>> = {
  home: { en: 'Home', ru: 'Главная' },
  products: { en: 'Products', ru: 'Продукция' },
  articles: { en: 'Articles', ru: 'Статьи' }
};

export function breadcrumbJsonLd(siteUrl: string, locale: Locale, crumbs: Crumb[]) {
  const origin = new URL(siteUrl).origin;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => {
      if (!c.path.startsWith('/') || c.path.startsWith('//')) throw new Error(`breadcrumb path must be site-relative: ${c.path}`);
      const u = new URL(`/${locale}${c.path === '/' ? '' : c.path}`, origin);
      if (u.origin !== origin) throw new Error('breadcrumb URL left the site');
      return { '@type': 'ListItem', position: i + 1, name: c.name, item: u.href };
    })
  };
}

/** Home > Products > 品类 */
export function categoryBreadcrumb(siteUrl: string, locale: Locale, key: string, name: string, live: boolean) {
  return breadcrumbJsonLd(siteUrl, locale, [
    { name: BREADCRUMB_LABELS.home[locale], path: '/' },
    { name: BREADCRUMB_LABELS.products[locale], path: '/products' },
    { name, path: categoryHref(locale, key, live) }
  ]);
}

/** Home > Articles > 文章（实际路由 /{locale}/articles/{slug}） */
export function articleBreadcrumb(siteUrl: string, locale: Locale, slug: string, title: string) {
  return breadcrumbJsonLd(siteUrl, locale, [
    { name: BREADCRUMB_LABELS.home[locale], path: '/' },
    { name: BREADCRUMB_LABELS.articles[locale], path: '/articles' },
    { name: title, path: `/articles/${encodeURIComponent(slug)}` }
  ]);
}

/** Home > 行业方案 > 行业。name 必须与页面上可见的面包屑文字同源（Nav.home / Solutions.detail.crumb / 行业名） */
export function solutionCrumbs(home: string, hub: string, slug: string, name: string): Crumb[] {
  return [
    { name: home, path: '/' },
    { name: hub, path: '/solutions' },
    { name, path: `/solutions/${encodeURIComponent(slug)}` }
  ];
}
