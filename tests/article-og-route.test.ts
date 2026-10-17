import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as React from 'react';
import { isSafeRelativeLocation, sameSiteRedirectPath } from '../src/lib/edge/redirect-location';

// 路由测试用 SEO mock 文章（与 seo-audit --mock 相同的开关）；tsconfig 的 jsx 是 preserve，tsx 按经典 JSX 编译，需要全局 React
process.env.SEO_AUDIT_MOCK_BUILD = '1';
process.env.SEO_AUDIT_MOCK = '1';
process.env.APP_ENV = 'test';
(globalThis as { React?: typeof React }).React = React;

const ROUTE = 'src/app/[locale]/articles/[slug]/og/route.tsx';
// 伪造的请求头：路由不能用到其中任何值
const EVIL = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example' };
const call = async (locale: string, slug: string) => {
  const { GET } = await import('../src/app/[locale]/articles/[slug]/og/route');
  return GET(new Request(`http://evil.example/${locale}/articles/${encodeURIComponent(slug)}/og?v=<script>`, { headers: EVIL }), { params: Promise.resolve({ locale, slug }) });
};
/** deploy/smoke-lib.sh 的 loc_bad（运维 smoke 用的同一个函数）：返回 true 表示 Location 不安全 */
const locBad = (loc: string) => {
  try { execFileSync('bash', ['-c', '. deploy/smoke-lib.sh && loc_bad "$1"', '_', loc]); return true; } catch { return false; }
};
const headerValues = (r: Response) => [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');

test('loc_bad 本身可用（对照）', () => {
  assert.equal(locBad('//evil.com/'), true);
  assert.equal(locBad('/og/home-en.jpg?v=7086247a'), false);
});

test('200：PNG 1200×630，Cache-Control public, max-age=86400, s-maxage=604800，noindex，标题不进响应头', async () => {
  for (const [l, slug, title] of [['en', 'mock-article-packaging-guide', 'Mock Article'], ['ru', 'mock-statya-o-upakovke', 'Тестовая статья']] as const) {
    const r = await call(l, slug);
    assert.equal(r.status, 200, slug);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400, s-maxage=604800');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('location'), null);
    assert.ok(!headerValues(r).includes(title), 'title must not appear in headers');
    assert.doesNotMatch(headerValues(r), /evil|script/i);
    const png = Buffer.from(await r.arrayBuffer());
    assert.equal(png.readUInt32BE(0), 0x89504e47);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  }
});

test('302 回退：相对 Location /og/home-<l>.jpg?v=<8 hex>，不用 Host / X-Forwarded-Host，过 loc_bad 和 #328 检查；no-store + noindex', async () => {
  for (const [l, slug] of [['en', 'does-not-exist'], ['ru', 'net-takoy-stati'], ['en', 'x'.repeat(120)]] as const) {
    const r = await call(l, slug);
    assert.equal(r.status, 302, slug);
    const loc = r.headers.get('location') ?? '';
    assert.match(loc, new RegExp(`^/og/home-${l}\\.jpg\\?v=[0-9a-f]{8}$`));
    assert.equal(locBad(loc), false, loc);
    assert.ok(isSafeRelativeLocation(loc));
    // #328 的改写只处理绝对地址，相对 Location 原样保留
    assert.equal(sameSiteRedirectPath(loc), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.doesNotMatch(headerValues(r), /evil/i);
  }
});

test('slug 白名单 ^[a-z0-9-]{1,120}$ 在查 CMS 之前：不合规一律 404 no-store，不渲染', async () => {
  for (const slug of ['', 'UPPER', 'a/b', '../etc', '..', 'a b', 'a_b', 'a.b', '%2e%2e', 'статья', 'x'.repeat(121), 'mock-article-packaging-guide\n', '<script>']) {
    const r = await call('en', slug);
    assert.equal(r.status, 404, JSON.stringify(slug));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('location'), null);
  }
  for (const l of ['de', 'EN', '']) {
    const r = await call(l, 'mock-article-packaging-guide');
    assert.equal(r.status, 404, l);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  const src = fs.readFileSync(ROUTE, 'utf8');
  const check = src.indexOf('ARTICLE_OG_SLUG_RE.test(slug)'), lookup = src.indexOf('getDocBySlug(');
  assert.ok(check > 0 && lookup > check, 'slug is validated before the CMS lookup');
  const { ARTICLE_OG_SLUG_RE } = await import('../src/lib/seo/articleOg');
  assert.equal(ARTICLE_OG_SLUG_RE.source, '^[a-z0-9-]{1,120}$');
});

test('渲染不发任何网络请求：字体只读本地文件；emoji / 中文等字体外字符先被去掉；标题只当纯文本', async () => {
  const { ImageResponse } = await import('next/og');
  const { ArticleOgImage } = await import('../src/lib/seo/og/ArticleOgImage');
  const { articleOgFonts } = await import('../src/lib/seo/og/articleOgFonts');
  const { ogSafeText, fitTitle } = await import('../src/lib/seo/og/articleOgLayout');
  assert.equal(ogSafeText('🎁 Gift 礼盒 box — «Коробка» ✨'), 'Gift box — «Коробка»');
  assert.equal(ogSafeText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error('network blocked in test'); }) as typeof fetch;
  try {
    for (const title of ['🎁 Подарочные коробки 礼盒 ✨', '<img src=x onerror=alert(1)><b>bold</b>']) {
      const r = new ImageResponse(React.createElement(ArticleOgImage, { title: ogSafeText(title), locale: 'ru' }), { width: 1200, height: 630, fonts: await articleOgFonts() });
      const png = Buffer.from(await r.arrayBuffer());
      assert.equal(png.readUInt32BE(0), 0x89504e47);
    }
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, 0);
  // HTML 当文字原样排版，不会被解析
  assert.deepEqual(fitTitle('<b>bold</b>', 'en').lines, ['<b>bold</b>']);
  const files = [ROUTE, 'src/lib/seo/og/ArticleOgImage.tsx', 'src/lib/seo/og/articleOgFonts.ts', 'src/lib/seo/og/articleOgLayout.ts'].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(files, /dangerouslySetInnerHTML|innerHTML|fetch\(|https?:\/\/(?!localhost)/);
  assert.match(fs.readFileSync('src/lib/seo/og/articleOgFonts.ts', 'utf8'), /readFile\(path\.join\(DIR, 'Manrope-ExtraBold\.ttf'\)\)/);
});

test('noindex 只在接口里设置（不依赖环境、不靠 middleware），robots.txt 不加分享图的 Disallow', () => {
  const r = fs.readFileSync(ROUTE, 'utf8');
  assert.match(r, /const OG_ROBOTS = \{ 'X-Robots-Tag': 'noindex' \} as const;/);
  assert.doesNotMatch(r.replace(/^\s*\/\/.*$/gm, ''), /isProd|APP_ENV|headers\.get|req\.(url|headers|nextUrl)/);
  assert.match(r, /GET\(_req: Request/);
  const mw = fs.readFileSync('src/middleware.ts', 'utf8');
  assert.doesNotMatch(mw, /articles|\/og/);
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
