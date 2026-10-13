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

/** Sanity 文档在 sitemap 里需要的字段：各语言 slug、更新时间、noindex */
export type CmsDoc = { updatedAt?: string; noindex?: boolean | null; slug: Partial<Record<Locale, string | null>> };

/** 对应 #199 的 /[locale]/articles、/[locale]/solutions（列表页 + 详情页） */
export const CMS_SECTIONS = [
  { type: 'article', base: '/articles' },
  { type: 'solution', base: '/solutions' }
] as const;

/**
 * 详情页：每种语言只在该语言 slug 存在时输出（否则详情页 404），alternates 只互指存在的语言，
 * x-default 优先 en；seo.noindex 的文档整篇跳过。lastModified 取文档的 _updatedAt。
 * 列表页：该语言至少有一篇文档时才可索引（与 #199 listMetadata 一致：无内容时 noindex），否则不输出。
 */
export function buildCmsEntries(opts: {
  siteUrl: string;
  locales: readonly Locale[];
  defaultLocale: Locale;
  base: string;
  docs: CmsDoc[] | null;
  now?: Date;
}): MetadataRoute.Sitemap {
  if (!opts.docs) return [];
  const site = opts.siteUrl.replace(/\/$/, '');
  const out: MetadataRoute.Sitemap = [];
  const listLatest = new Map<Locale, Date>();
  for (const d of opts.docs) {
    const lm = d.updatedAt && !Number.isNaN(Date.parse(d.updatedAt)) ? new Date(d.updatedAt) : undefined;
    const have = opts.locales.filter((l) => d.slug[l]);
    for (const l of have) if (lm && (!listLatest.get(l) || listLatest.get(l)! < lm)) listLatest.set(l, lm);
    for (const l of have) if (!listLatest.has(l)) listLatest.set(l, opts.now ?? new Date());
    if (d.noindex || have.length === 0) continue;
    const url = (l: Locale) => `${site}/${l}${opts.base}/${d.slug[l]}`;
    const languages = {
      ...Object.fromEntries(have.map((l) => [l, url(l)])),
      'x-default': url(have.includes(opts.defaultLocale) ? opts.defaultLocale : have[0])
    };
    for (const l of have) out.push({ url: url(l), ...(lm ? { lastModified: lm } : {}), changeFrequency: 'monthly', priority: 0.6, alternates: { languages } });
  }
  // 列表页：#199 的 alternatesFor 两种语言都互指，这里只输出可索引的语言
  const listUrl = (l: Locale) => `${site}/${l}${opts.base}`;
  const listLangs = {
    ...Object.fromEntries(opts.locales.map((l) => [l, listUrl(l)])),
    'x-default': listUrl(opts.defaultLocale)
  };
  const lists: MetadataRoute.Sitemap = opts.locales
    .filter((l) => listLatest.has(l))
    .map((l) => ({ url: listUrl(l), lastModified: listLatest.get(l), changeFrequency: 'weekly', priority: 0.7, alternates: { languages: listLangs } }));
  return [...lists, ...out];
}
