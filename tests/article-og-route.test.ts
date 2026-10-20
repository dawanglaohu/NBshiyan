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
const HANDLER = 'src/lib/seo/og/articleOgHandler.ts';
const RENDER = 'src/lib/seo/og/renderArticleOg.tsx';
// 伪造的请求头：路由不能用到其中任何值
const EVIL = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example' };
// #350：路由只认查询参数 v（= articleOgVersion(locale, 当前标题)）；query 传 undefined 表示不带 v
const call = async (locale: string, slug: string, query?: string) => {
  const { GET } = await import('../src/app/[locale]/articles/[slug]/og/route');
  const qs = query === undefined ? '' : `?${query}`;
  return GET(new Request(`http://evil.example/${locale}/articles/${encodeURIComponent(slug)}/og${qs}`, { headers: EVIL }), { params: Promise.resolve({ locale, slug }) });
};
const MOCK = [['en', 'mock-article-packaging-guide', 'Mock Article: Packaging Guide Layout Test'], ['ru', 'mock-statya-o-upakovke', 'Тестовая статья: проверка макета']] as const;
const ver = async (l: 'en' | 'ru', title: string) => (await import('../src/lib/seo/articleOg')).articleOgVersion(l, title);
/** 正确的 v，外加会被忽略的干扰参数 */
const goodQuery = async (l: 'en' | 'ru', title: string) => `title=${encodeURIComponent('<script>evil</script>')}&v=${await ver(l, title)}&slug=..%2F..&locale=de`;
/** deploy/smoke-lib.sh 的 loc_bad（运维 smoke 用的同一个函数）：返回 true 表示 Location 不安全 */
const locBad = (loc: string) => {
  try { execFileSync('bash', ['-c', '. deploy/smoke-lib.sh && loc_bad "$1"', '_', loc]); return true; } catch { return false; }
};
const headerValues = (r: Response) => [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');

test('loc_bad 本身可用（对照）', () => {
  assert.equal(locBad('//evil.com/'), true);
  assert.equal(locBad('/og/home-en.jpg?v=7086247a'), false);
});

test('200（v 正确，其他参数忽略）：PNG 1200×630，Cache-Control public, max-age=31536000, immutable，noindex，标题不进响应头', async () => {
  for (const [l, slug, title] of MOCK) {
    const r = await call(l, slug, await goodQuery(l, title));
    assert.equal(r.status, 200, slug);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('location'), null);
    assert.ok(!headerValues(r).includes(title), 'title must not appear in headers');
    assert.doesNotMatch(headerValues(r), /evil|script/i);
    const png = Buffer.from(await r.arrayBuffer());
    assert.equal(png.readUInt32BE(0), 0x89504e47);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  }
});

test('#350 v 校验：缺 v、v 不对、v 格式不对、文章不存在 → 404 no-store + noindex，不渲染、不跳转', async () => {
  for (const [l, slug, title] of MOCK) {
    const good = await ver(l, title);
    const wrong = good.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    for (const q of [undefined, '', 'v=', `v=${wrong}`, `v=${good.toUpperCase()}`, `v=${good}0`, `v=00000000&v=${good}`, `x=${good}`]) {
      const r = await call(l, slug, q);
      assert.equal(r.status, 404, `${slug} ${q}`);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-robots-tag'), 'noindex');
      assert.equal(r.headers.get('location'), null);
      assert.equal(r.headers.get('content-type'), null, 'no image rendered');
    }
  }
  // 文章不存在：任何 v 都对不上 → 404（以前是 302 回退通用图）
  for (const [l, slug] of [['en', 'does-not-exist'], ['ru', 'net-takoy-stati'], ['en', 'x'.repeat(120)]] as const) {
    const r = await call(l, slug, `v=${await ver(l, 'does-not-exist')}`);
    assert.equal(r.status, 404, slug);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  // 源码顺序：v 校验在查 CMS 之前（缺 v 不查库），版本比对在渲染之前
  const src = fs.readFileSync(HANDLER, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(src.indexOf('if (!v) return notFound()') < src.indexOf('deps.getDoc('));
  assert.ok(src.indexOf('expected !== v) return notFound()') < src.indexOf('deps.render('));
});

test('302 回退（v 正确但渲染不出来）：Location 仍是相对路径 /og/home-<l>.jpg?v=…，过 loc_bad 和 #328 检查', async () => {
  const { ogImageUrl } = await import('../src/lib/seo/pageMeta');
  for (const l of ['en', 'ru'] as const) {
    const u = new URL(ogImageUrl('home', l));
    const loc = u.pathname + u.search;
    assert.match(loc, new RegExp(`^/og/home-${l}\\.jpg\\?v=[0-9a-f]{8}$`));
    assert.equal(locBad(loc), false, loc);
    assert.ok(isSafeRelativeLocation(loc));
    assert.equal(sameSiteRedirectPath(loc), null);
  }
  assert.match(fs.readFileSync(HANDLER, 'utf8'), /Location: u\.pathname \+ u\.search/);
});

test('slug 白名单 ^[a-z0-9-]{1,120}$ 在查 CMS 之前：不合规一律 404 no-store，不渲染', async () => {
  for (const slug of ['', 'UPPER', 'a/b', '../etc', '..', 'a b', 'a_b', 'a.b', '%2e%2e', 'статья', 'x'.repeat(121), 'mock-article-packaging-guide\n', '<script>']) {
    const r = await call('en', slug, await goodQuery('en', MOCK[0][2]));
    assert.equal(r.status, 404, JSON.stringify(slug));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('location'), null);
  }
  for (const l of ['de', 'ja', 'es', 'EN', 'en-US', '', 'zz-garbage', '..', '%2e%2e']) {
    const r = await call(l, 'mock-article-packaging-guide', await goodQuery('en', MOCK[0][2]));
    assert.equal(r.status, 404, l);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const src = fs.readFileSync(HANDLER, 'utf8');
  const check = src.indexOf('ARTICLE_OG_SLUG_RE.test(slug)'), lookup = src.indexOf('deps.getDoc(');
  assert.ok(check > 0 && lookup > check, 'slug is validated before the CMS lookup');
  // 路由不经过 middleware：locale 按 PUBLISHED_LOCALES 白名单（不是格式检查），也在查 CMS 之前
  const localeCheck = src.indexOf('if (!isPublishedLocale(locale)) return notFound();');
  assert.ok(localeCheck > 0 && lookup > localeCheck, 'locale allowlist runs before the CMS lookup');
  assert.match(src, /from '@\/lib\/server\/published-locales'/);
  const { ARTICLE_OG_SLUG_RE } = await import('../src/lib/seo/articleOg');
  assert.equal(ARTICLE_OG_SLUG_RE.source, '^[a-z0-9-]{1,120}$');
});

test('渲染不发任何网络请求：字体只读本地文件；emoji / 中文等字体外字符先被去掉；标题只当纯文本', async () => {
  const { fitTitle, ogSafeText } = await import('../src/lib/seo/og/articleOgLayout');
  assert.equal(ogSafeText('🎁 Gift 礼盒 box — «Коробка» ✨'), 'Gift box — «Коробка»');
  assert.equal(ogSafeText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  // HTML 当文字原样排版，不会被解析
  assert.deepEqual(fitTitle('<b>bold</b>', 'en').lines, ['<b>bold</b>']);
  const files = [ROUTE, RENDER, 'src/lib/seo/og/ArticleOgImage.tsx', 'src/lib/seo/og/articleOgFonts.ts', 'src/lib/seo/og/articleOgLayout.ts'].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(files, /dangerouslySetInnerHTML|innerHTML|fetch\(|https?:\/\/(?!localhost)/);
  assert.match(fs.readFileSync('src/lib/seo/og/articleOgFonts.ts', 'utf8'), /readFile\(path\.join\(DIR, 'Manrope-ExtraBold\.ttf'\)\)/);
});

test('唯一渲染入口：路由只通过 renderArticleOgPng 渲染，字符过滤在入口里', () => {
  const route = fs.readFileSync(ROUTE, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(route, /from '@\/lib\/seo\/og\/renderArticleOg'/);
  assert.match(route, /render: \(title, l\) => renderArticleOgPng\(title, l\)/);
  assert.match(route, /getDoc: \(l, s\) => getDocBySlug\('article', l, s\)/);
  const handler = fs.readFileSync(HANDLER, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(handler, /ImageResponse|ArticleOgImage|articleOgFonts|ogSafeText/);
  // 路由里不能自己构造 ImageResponse、读字体或直接用模板，否则就会绕过入口里的过滤
  assert.doesNotMatch(route, /ImageResponse|ArticleOgImage|articleOgFonts|ogSafeText/);
  const entry = fs.readFileSync(RENDER, 'utf8');
  assert.equal((entry.match(/new ImageResponse\(/g) ?? []).length, 1);
  assert.ok(entry.indexOf('ogSafeText(rawTitle)') > 0 && entry.indexOf('ogSafeText(rawTitle)') < entry.indexOf('new ImageResponse('), 'filter runs before render');
  // 仓库里别处也不能再起一个文章分享图的渲染入口
  const others = execFileSync('git', ['grep', '--untracked', '-l', 'ArticleOgImage', '--', 'src']).toString().trim().split('\n').sort();
  assert.deepEqual(others, ['src/lib/seo/og/ArticleOgImage.tsx', RENDER].sort());
});

test('断网渲染：屏蔽 fetch 和所有 TCP/TLS 连接后，入口照常出图（含 emoji / 中文 / HTML 标题），零网络请求', async () => {
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  const { renderArticleOgPng } = await import('../src/lib/seo/og/renderArticleOg');
  const attempts: string[] = [];
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  const realTlsConnect = tls.connect;
  globalThis.fetch = (async (u: unknown) => { attempts.push(`fetch ${String(u)}`); throw new Error('network blocked in test'); }) as typeof fetch;
  net.Socket.prototype.connect = function (this: unknown, ...a: unknown[]) { attempts.push(`net.connect ${JSON.stringify(a[0])}`); throw new Error('network blocked in test'); } as never;
  (tls as { connect: unknown }).connect = (...a: unknown[]) => { attempts.push(`tls.connect ${JSON.stringify(a[0])}`); throw new Error('network blocked in test'); };
  try {
    for (const [title, l] of [['🎁 Подарочные коробки 礼盒 ✨', 'ru'], ['<img src=x onerror=alert(1)><b>bold</b>', 'en'], ['Custom Gift Boxes 🎄 圣诞', 'en']] as const) {
      const png = await renderArticleOgPng(title, l);
      assert.ok(png, title);
      const b = Buffer.from(png);
      assert.equal(b.readUInt32BE(0), 0x89504e47);
      assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [1200, 630]);
    }
    // 过滤后为空（全是字体外字符）或不是字符串：不渲染，返回 null 让路由回退
    for (const t of ['🎁✨', '礼盒', '', '   ', null, undefined, 42]) assert.equal(await renderArticleOgPng(t, 'en'), null, String(t));
    assert.deepEqual(attempts, []);
    // 对照：绕过入口、直接把 emoji / 中文交给 Satori，会去网上补字体 → 被拦截并记录。证明上面的「零请求」不是拦截失效。
    const { ImageResponse } = await import('next/og');
    const { articleOgFonts } = await import('../src/lib/seo/og/articleOgFonts');
    const realError = console.error;
    console.error = () => {};
    try {
      await new ImageResponse(React.createElement('div', { style: { display: 'flex', fontFamily: 'Manrope', fontSize: 60 } }, '🎁 礼盒 Gift'), { width: 1200, height: 630, fonts: await articleOgFonts() }).arrayBuffer();
    } catch { /* 拦截后渲染失败是预期的 */ } finally { console.error = realError; }
    assert.ok(attempts.length > 0, 'control: unfiltered render must try the network');
    attempts.length = 0;
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
    (tls as { connect: unknown }).connect = realTlsConnect;
  }
  assert.deepEqual(attempts, []);
});

test('noindex 只在接口里设置（不依赖环境、不靠 middleware），robots.txt 不加分享图的 Disallow', () => {
  const r = fs.readFileSync(HANDLER, 'utf8');
  assert.match(r, /const OG_ROBOTS = \{ 'X-Robots-Tag': 'noindex' \} as const;/);
  // #350：请求里只读 URL 的查询参数 v（一处），不读请求头 / Host / 其他参数
  const code = r.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /isProd|APP_ENV|headers\.get|req\.(headers|nextUrl)/);
  assert.equal((code.match(/new URL\(reqUrl\)/g) ?? []).length, 1);
  assert.match(code, /new URL\(reqUrl\)\.searchParams\.get\('v'\)/);
  assert.doesNotMatch(code, /searchParams\.get\('(?!v')/);
  const route = fs.readFileSync(ROUTE, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((route.match(/req\.url/g) ?? []).length, 1, 'route only passes req.url to the handler');
  assert.doesNotMatch(route, /headers|nextUrl|searchParams/);
  // middleware 只在 matcher 里排除分享图路径（tests/og-middleware-matcher.test.ts），处理逻辑里不碰 articles / og
  const mw = fs.readFileSync('src/middleware.ts', 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/^export const config = .*$/m, '');
  assert.doesNotMatch(mw, /articles|\/og|\bog\b/);
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

// ───────── #350 安全复核点 ─────────
test('#350 v 格式不对（长度 / 字符集）时根本不查 CMS、不渲染；格式对才查', async () => {
  const { handleArticleOg } = await import('../src/lib/seo/og/articleOgHandler');
  const calls = { getDoc: 0, render: 0 };
  const deps = {
    getDoc: async () => { calls.getDoc++; return { slug: 'mock-article-packaging-guide', title: MOCK[0][2] }; },
    render: async () => { calls.render++; return new Uint8Array([1]).buffer; },
  };
  for (const q of ['', '?v=', '?v=1234567', '?v=123456789', '?v=ABCDEF12', '?v=1234567g', '?v=%20a1b2c3d4', '?v=a1b2c3d4%00', '?x=a1b2c3d4']) {
    const r = await handleArticleOg(`http://evil.example/en/articles/mock-article-packaging-guide/og${q}`, 'en', 'mock-article-packaging-guide', deps);
    assert.equal(r.status, 404, q);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, { getDoc: 0, render: 0 }, 'no CMS lookup for malformed v');
  const r = await handleArticleOg(`http://x/en/articles/s/og?v=00000000`, 'en', 'mock-article-packaging-guide', deps);
  assert.equal(r.status, 404);
  assert.deepEqual(calls, { getDoc: 1, render: 0 }, 'well-formed but wrong v: looked up, not rendered');
  const ok = await handleArticleOg(`http://x/en/articles/s/og?v=${await ver('en', MOCK[0][2])}`, 'en', 'mock-article-packaging-guide', deps);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(calls, { getDoc: 2, render: 1 });
});

test('#350 页面 og:image 的 v == 路由期望的 v（同一个函数、同一组参数）', async () => {
  // 页面：cmsPages.tsx detailMetadata 用 getDocBySlug(type, locale, slug) 取文档，再把 { slug: d.slug ?? slug, title: d.title } 交给 articleShareMeta。
  // （detailMetadata 里有 getTranslations，测试环境跑不了，所以按同样的参数直接调 articleShareMeta，并锁住 cmsPages 的调用写法）
  const cms = fs.readFileSync('src/components/cms/cmsPages.tsx', 'utf8');
  assert.match(cms, /const d = \(await getDocBySlug\(type, loc\(locale\), slug\)\) as Doc \| null;/);
  assert.match(cms, /shareMeta\(type, locale, \{ slug: d\.slug \?\? slug, title: d\.title \}\)/);
  assert.match(cms, /return articleShareMeta\(loc\(locale\), t\('ogImageAlt'\), doc\);/);
  const { articleShareMeta } = await import('../src/lib/seo/articleOg');
  const { expectedArticleOgVersion } = await import('../src/lib/seo/og/articleOgHandler');
  const { getDocBySlug } = await import('../src/lib/server/sanity');
  for (const [l, slug] of MOCK) {
    const d = (await getDocBySlug('article', l, slug)) as { slug?: string; title?: string };
    const meta = articleShareMeta(l, 'alt', { slug: d.slug ?? slug, title: d.title });
    const images = (meta.openGraph as { images?: { url: string }[] } | undefined)?.images ?? [];
    const pageV = new URL(images[0].url).searchParams.get('v');
    assert.match(images[0].url, new RegExp(`/${l}/articles/${slug}/og\\?v=`));
    // 路由：同一份文档（路由也是 getDocBySlug('article', locale, slug)）
    const routeV = expectedArticleOgVersion(l, slug, d);
    assert.ok(pageV && routeV);
    assert.equal(pageV, routeV, slug);
    // 路由按这个 v 真的返回 200
    const r = await call(l, slug, `v=${pageV}`);
    assert.equal(r.status, 200);
  }
});

test('#350 文章分享图的 v 和图都不受 badge 参数影响（articleOgVersion 固定值 + 默认角标）', async () => {
  const { articleOgVersion } = await import('../src/lib/seo/articleOg');
  assert.equal(articleOgVersion('en', 'Custom Gift Boxes Guide'), '1cafb4ae');
  assert.equal(articleOgVersion('ru', 'Гофрокороб'), '789cc75f');
  const { renderArticleOgPng } = await import('../src/lib/seo/og/renderArticleOg');
  const { LABEL } = await import('../src/lib/seo/og/ArticleOgImage');
  assert.deepEqual(LABEL, { en: 'Article', ru: 'Статья' });
  for (const [l, , title] of MOCK) {
    const a = Buffer.from((await renderArticleOgPng(title, l))!);
    const b = Buffer.from((await renderArticleOgPng(title, l, { badge: LABEL[l] }))!);
    const c = Buffer.from((await renderArticleOgPng(title, l, { badge: 'О компании' }))!);
    assert.ok(a.equals(b), 'default badge == explicit Article/Статья');
    assert.ok(!a.equals(c), 'a different badge changes the image');
  }
  // 路由不传 badge
  assert.doesNotMatch(fs.readFileSync(ROUTE, 'utf8') + fs.readFileSync(HANDLER, 'utf8'), /badge/);
});
