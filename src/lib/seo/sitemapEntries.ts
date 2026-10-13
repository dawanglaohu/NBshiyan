import type { MetadataRoute } from 'next';
import { categoryMeta, type CategoryMeta } from './categoryMeta';

type Locale = 'en' | 'ru';
type Freq = 'weekly' | 'monthly';
/** 一个页面在各语言下的路径（不含 /{locale} 前缀），例如 { en: '/products/custom-gift-boxes', ru: '/products/podarochnye-korobki' } */
type Page = { paths: Record<Locale, string>; priority: number; changeFrequency: Freq };

/**
 * 只列可索引的公开页面。以下页面带 noindex 或仍是占位，故意不进 sitemap：
 * /privacy（草稿）、/s/*（分享短链）、/industries、/factory、/case-studies（占位）、/admin、/api。
 * 新页面上线且去掉 noindex 后再加进来。
 */
export const STATIC_PAGES: Page[] = [
  { paths: { en: '', ru: '' }, priority: 1, changeFrequency: 'weekly' },
  { paths: { en: '/products', ru: '/products' }, priority: 0.9, changeFrequency: 'weekly' },
  { paths: { en: '/contact', ru: '/contact' }, priority: 0.7, changeFrequency: 'monthly' }
];

/**
 * 12 个品类落地页 /{locale}/products/{各语言 slug}，slug 来自 categoryMeta（与 canonicalFor 一致）。
 * 路由 [locale]/products/[slug] 合并前保持 false，否则 sitemap 里会出现 404 地址（e2e seo #6 会失败）。
 * 落地页 PR 合并时把它改成 true。
 */
export const CATEGORY_PAGES_LIVE = false;

export function categoryPages(meta: CategoryMeta[] = categoryMeta): Page[] {
  return meta.map((c) => ({
    paths: { en: `/products/${c.en.slug}`, ru: `/products/${c.ru.slug}` },
    priority: 0.8,
    changeFrequency: 'weekly'
  }));
}

export function buildSitemap(opts: {
  siteUrl: string;
  locales: readonly Locale[];
  defaultLocale: Locale;
  includeCategories?: boolean;
  lastModified?: Date;
}): MetadataRoute.Sitemap {
  const base = opts.siteUrl.replace(/\/$/, '');
  const lastModified = opts.lastModified ?? new Date();
  const pages = [...STATIC_PAGES, ...(opts.includeCategories ? categoryPages() : [])];
  const url = (l: Locale, p: Page) => `${base}/${l}${p.paths[l]}`;
  return pages.flatMap((p) => {
    const languages = {
      ...Object.fromEntries(opts.locales.map((l) => [l, url(l, p)])),
      'x-default': url(opts.defaultLocale, p)
    };
    return opts.locales.map((l) => ({
      url: url(l, p),
      lastModified,
      changeFrequency: p.changeFrequency,
      priority: p.priority,
      alternates: { languages }
    }));
  });
}
