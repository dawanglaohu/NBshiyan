import type { MetadataRoute } from 'next';
import { unstable_cache } from 'next/cache';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE, type PublishedLocale } from '@/i18n/published-locales';
import { SITE_URL } from '@/lib/site';
import { sanityFetch } from '@/lib/server/sanity';
import { buildSitemap, buildCmsEntries, CMS_SECTIONS, type CmsDoc } from '@/lib/seo/sitemapEntries';
import { loadAboutPage } from '@/lib/about/visibility';
import { aboutSitemapFromLoader } from '@/lib/seo/about';
import { categoryPagesLive, seoMockEnabled } from '@/lib/seo/mock';
import { SITE_SETTINGS_TAG } from '@/lib/server/site-settings-model';

// 规则见 src/lib/seo/sitemapEntries.ts：只放可索引页面，品类落地页和 Sanity 文档都用各语言自己的 slug
export const revalidate = 3600;

// loadAboutPage 内部的读取自带 60 秒缓存。预渲染时直接调用会把本路由的 revalidate 从 3600 压到 60。
// 外层 3600 包住整个共用函数，让那次读取变成嵌套缓存，不再改本路由的刷新时间。标签仍是 site-settings，后台保存会一起失效。
const aboutContentForSitemap = unstable_cache(
  async (locale: PublishedLocale) => loadAboutPage(locale),
  ['sitemap-about-content'],
  { tags: [SITE_SETTINGS_TAG], revalidate: 3600 }
);

const cmsQuery = (type: string) =>
  `*[_type == "${type}" && (defined(slug.en.current) || defined(slug.ru.current))]{ "updatedAt": _updatedAt, "noindex": seo.noindex, "slug": { "en": slug.en.current, "ru": slug.ru.current } }`;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const common = { siteUrl: SITE_URL, locales: PUBLISHED_LOCALES, defaultLocale: DEFAULT_PUBLISHED_LOCALE };
  // 未配置 Sanity 或请求失败时 sanityFetch 返回 null → 不输出任何 CMS 条目
  const cms = await Promise.all(
    CMS_SECTIONS.map(async ({ type, base }) =>
      buildCmsEntries({ ...common, base, docs: process.env.SEO_AUDIT_MOCK_BUILD === '1' && seoMockEnabled() ? ((await import('@/lib/server/sanityMock')).mockCmsDocs(type) as CmsDoc[]) : await sanityFetch<CmsDoc[]>(cmsQuery(type), {}, { tags: [`sanity:${type}`] }) })
    )
  );
  const pages = [...buildSitemap({ ...common, includeCategories: categoryPagesLive() }), ...cms.flat()];
  const about = await aboutSitemapFromLoader({ locales: PUBLISHED_LOCALES, origin: SITE_URL, load: aboutContentForSitemap });
  return [...pages, ...about];
}
