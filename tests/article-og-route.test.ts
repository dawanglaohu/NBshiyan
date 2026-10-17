import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as React from 'react';

// 路由测试用 SEO mock 文章（与 seo-audit --mock 相同的开关）；tsconfig 的 jsx 是 preserve，tsx 按经典 JSX 编译，需要全局 React
process.env.SEO_AUDIT_MOCK_BUILD = '1';
process.env.SEO_AUDIT_MOCK = '1';
process.env.APP_ENV = 'test';
(globalThis as { React?: typeof React }).React = React;

const call = async (locale: string, slug: string) => {
  const { GET } = await import('../src/app/[locale]/articles/[slug]/og/route');
  return GET(new Request(`http://localhost/${locale}/articles/${slug}/og`), { params: Promise.resolve({ locale, slug }) });
};

test('文章分享图接口：200 PNG、302 回退、404 都带 X-Robots-Tag: noindex', async () => {
  const ok = await call('en', 'mock-article-packaging-guide');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-robots-tag'), 'noindex');
  const png = Buffer.from(await ok.arrayBuffer());
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);

  const ru = await call('ru', 'mock-statya-o-upakovke');
  assert.equal(ru.status, 200);
  assert.equal(ru.headers.get('x-robots-tag'), 'noindex');

  for (const [l, slug] of [['en', 'does-not-exist'], ['ru', 'net-takoy-stati'], ['en', 'BAD..slug']] as const) {
    const r = await call(l, slug);
    assert.equal(r.status, 302, slug);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex', slug);
    assert.equal(new URL(r.headers.get('location') ?? '').pathname, `/og/home-${l}.jpg`);
  }
  const bad = await call('de', 'x');
  assert.equal(bad.status, 404);
  assert.equal(bad.headers.get('x-robots-tag'), 'noindex');
});

test('noindex 只在接口里设置（不依赖环境），robots.txt 不加分享图的 Disallow', () => {
  const r = fs.readFileSync('src/app/[locale]/articles/[slug]/og/route.tsx', 'utf8');
  assert.match(r, /const OG_ROBOTS = \{ 'X-Robots-Tag': 'noindex' \} as const;/);
  assert.doesNotMatch(r, /isProd|APP_ENV/);
  assert.equal((r.match(/\.\.\.OG_ROBOTS|headers: OG_ROBOTS/g) ?? []).length, 3);
  const robots = fs.readFileSync('src/app/robots.ts', 'utf8');
  assert.doesNotMatch(robots, /\/og|articles/);
});

test('sitemap 不含分享图接口：静态页 + 品类 + mock 文章的所有地址都不以 /og 结尾', async () => {
  const { buildSitemap, buildCmsEntries, CMS_SECTIONS } = await import('../src/lib/seo/sitemapEntries');
  const { mockCmsDocs } = await import('../src/lib/server/sanityMock');
  const common = { siteUrl: 'https://geiom.com', locales: ['en', 'ru'] as const, defaultLocale: 'en' as const };
  const urls = [
    ...buildSitemap({ ...common, locales: [...common.locales], includeCategories: true }),
    ...CMS_SECTIONS.flatMap(({ type, base }) => buildCmsEntries({ ...common, locales: [...common.locales], base, docs: mockCmsDocs(type) as never }))
  ].flatMap((e) => [e.url, ...Object.values(e.alternates?.languages ?? {})]).filter((u): u is string => typeof u === 'string');
  assert.ok(urls.some((u) => /\/articles\/mock-/.test(u)), 'mock articles are in the sitemap');
  for (const u of urls) assert.doesNotMatch(u, /\/og(\?|$)/, u);
  assert.doesNotMatch(fs.readFileSync('src/app/sitemap.ts', 'utf8') + fs.readFileSync('src/lib/seo/sitemapEntries.ts', 'utf8'), /\/og\b/);
});
