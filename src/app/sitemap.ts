import type { MetadataRoute } from 'next';
import { routing } from '@/i18n/routing';
import { SITE_URL } from '@/lib/site';
import { sanityFetch } from '@/lib/server/sanity';
import { buildSitemap, buildCmsEntries, CMS_SECTIONS, type CmsDoc } from '@/lib/seo/sitemapEntries';
import { categoryPagesLive, seoMockEnabled } from '@/lib/seo/mock';
import { mockCmsDocs } from '@/lib/server/sanityMock';

// 规则见 src/lib/seo/sitemapEntries.ts：只放可索引页面，品类落地页和 Sanity 文档都用各语言自己的 slug
export const revalidate = 3600;

const cmsQuery = (type: string) =>
  `*[_type == "${type}" && (defined(slug.en.current) || defined(slug.ru.current))]{ "updatedAt": _updatedAt, "noindex": seo.noindex, "slug": { "en": slug.en.current, "ru": slug.ru.current } }`;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const common = { siteUrl: SITE_URL, locales: routing.locales, defaultLocale: routing.defaultLocale };
  // 未配置 Sanity 或请求失败时 sanityFetch 返回 null → 不输出任何 CMS 条目
  const cms = await Promise.all(
    CMS_SECTIONS.map(async ({ type, base }) =>
      buildCmsEntries({ ...common, base, docs: seoMockEnabled() ? (mockCmsDocs(type) as CmsDoc[]) : await sanityFetch<CmsDoc[]>(cmsQuery(type), {}, { tags: [`sanity:${type}`] }) })
    )
  );
  return [...buildSitemap({ ...common, includeCategories: categoryPagesLive() }), ...cms.flat()];
}
