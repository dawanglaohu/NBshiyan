// 多语言第 0 期 SEO 快照：sitemap 和 hreflang 的 en/ru 输出。生成器只依赖 main 上也存在的接口，
// 所以同一份代码在 origin/main 上跑出的结果就是基准（tests/fixtures/seo-snapshot-main.json）。
import sitemap from '../../src/app/sitemap';
import { alternatesFor } from '../../src/i18n/alternates';
import { buildSitemap, buildCmsEntries } from '../../src/lib/seo/sitemapEntries';
import { mockCmsDocs } from '../../src/lib/server/sanityMock';

const T = new Date('2026-01-01T00:00:00Z');
const norm = (xs: { lastModified?: unknown }[]) => xs.map((x) => ({ ...x, lastModified: x.lastModified ? 'T' : undefined }));
const PATHS = ['', '/products', '/contact', '/privacy', '/solutions', '/solutions/color-boxes', '/factory', '/cases', '/articles'];

export async function seoSnapshot() {
  const common = { siteUrl: 'https://geiom.com', locales: ['en', 'ru'] as const, defaultLocale: 'en' as const };
  return {
    sitemapRoute: norm(await sitemap()),
    sitemapWithCategories: buildSitemap({ ...common, includeCategories: true, lastModified: T }),
    cmsEntries: buildCmsEntries({ ...common, base: '/articles', docs: mockCmsDocs('article'), now: T }),
    hreflang: Object.fromEntries((['en', 'ru'] as const).flatMap((l) => PATHS.map((p) => [`${l}${p}`, alternatesFor(l, p)])))
  };
}
