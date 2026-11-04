// sitemap 和 hreflang 的 en/ru 输出。基准是 tests/fixtures/seo-snapshot-main.json。
// CATEGORY_PAGES_LIVE 为 true 时，sitemap() 的结果含品类页。
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
