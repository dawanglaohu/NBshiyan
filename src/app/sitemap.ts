import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { SITE_URL } from '@/lib/site';
import { buildSitemap, CATEGORY_PAGES_LIVE } from '@/lib/seo/sitemapEntries';

// 规则见 src/lib/seo/sitemapEntries.ts：只放可索引页面，品类落地页用各语言自己的 slug
export default function sitemap(): MetadataRoute.Sitemap {
  return buildSitemap({
    siteUrl: SITE_URL,
    locales: routing.locales,
    defaultLocale: routing.defaultLocale,
    includeCategories: CATEGORY_PAGES_LIVE
  });
}
