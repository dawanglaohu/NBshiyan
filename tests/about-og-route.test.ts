import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aboutOgResponse, type AboutOgDeps } from '../src/lib/about/og-response';
import type { AboutContent } from '../src/lib/server/site-settings';
import * as React from 'react';

// 真实模板渲染要用：tsconfig 的 jsx 是 preserve，tsx 按经典 JSX 编译，需要全局 React（同 tests/article-og-route.test.ts）
(globalThis as { React?: typeof React }).React = React;

// #350 /<locale>/about/og 规则（全栈 + PM）：已发布语言、v 必须等于当前内容版本、只读 v、200 immutable、其余 404 no-store 且不渲染
const content = (locale: 'en' | 'ru', title: string): AboutContent => ({
  locale, title, summary: '', bodyHtml: '', stats: [], images: [], home: { title: '', intro: '' }, updatedAt: '2026-10-17T00:00:00Z',
});
const GOOD = 'a1b2c3d4';
function deps(over: Partial<AboutOgDeps> = {}) {
  const calls = { read: 0, render: 0 };
  const d: AboutOgDeps = {
    getAboutContent: async (l) => { calls.read++; return content(l, l === 'ru' ? 'О компании' : 'About us'); },
    getBadge: async (l) => (l === 'ru' ? 'О компании' : 'About'),
    expectedVersion: () => GOOD,
    render: async () => { calls.render++; return new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer; },
    ...over,
  };
  return { d, calls };
}
const url = (l: string, q = '') => `http://evil.example/${l}/about/og${q}`;
const is404 = (r: Response) => {
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  assert.equal(r.headers.get('content-type'), null);
};

test('未发布 / 不合法语言 → 404 no-store，不读内容、不渲染', async () => {
  for (const l of ['de', 'ja', 'es', 'EN', 'en-US', '', '..']) {
    const { d, calls } = deps();
    is404(await aboutOgResponse(url(l, `?v=${GOOD}`), l, d));
    assert.deepEqual(calls, { read: 0, render: 0 }, l);
  }
});

test('缺 v / v 格式不对 → 404，不读内容、不渲染', async () => {
  for (const q of ['', '?v=', '?x=a1b2c3d4', '?v=A1B2C3D4', '?v=a1b2c3d', '?v=a1b2c3d4e', '?v=%3Cscript%3E']) {
    const { d, calls } = deps();
    is404(await aboutOgResponse(url('en', q), 'en', d));
    assert.deepEqual(calls, { read: 0, render: 0 }, q);
  }
});

test('v 不对 / 内容为 null / 标题不出专属图 → 404，不渲染', async () => {
  let x = deps();
  is404(await aboutOgResponse(url('en', '?v=00000000'), 'en', x.d));
  assert.equal(x.calls.render, 0);
  x = deps({ getAboutContent: async () => null });
  is404(await aboutOgResponse(url('ru', `?v=${GOOD}`), 'ru', x.d));
  assert.equal(x.calls.render, 0);
  x = deps({ expectedVersion: () => null });
  is404(await aboutOgResponse(url('en', `?v=${GOOD}`), 'en', x.d));
  assert.equal(x.calls.render, 0);
  // 渲染结果为空或出错：404 no-store（不缓存）
  is404(await aboutOgResponse(url('en', `?v=${GOOD}`), 'en', deps({ render: async () => null }).d));
  const err = console.error; console.error = () => {};
  try { is404(await aboutOgResponse(url('en', `?v=${GOOD}`), 'en', deps({ render: async () => { throw new Error('boom'); } }).d)); } finally { console.error = err; }
});

test('v 正确 → 200 PNG，Cache-Control: public, max-age=31536000, immutable；其他参数忽略，标题只来自内容', async () => {
  const seen: string[] = [];
  const { d } = deps({ render: async (t, _l, b) => { seen.push(`${t}|${b}`); return new Uint8Array([1]).buffer; }, expectedVersion: (l, t, b) => { seen.push(`${l}:${t}|${b}`); return GOOD; } });
  const r = await aboutOgResponse(url('ru', `?title=${encodeURIComponent('<script>evil</script>')}&v=${GOOD}&locale=en&w=9999`), 'ru', d);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  assert.deepEqual(seen, ['ru:О компании|О компании', 'О компании|О компании'], 'rendered once; same badge for v check and drawing');
  assert.doesNotMatch([...r.headers.values()].join('\n'), /evil|компании/);
});

test('路由：期望的 v 用 SEO 的 aboutOgVersion(locale, title, badge)，角标 = Nav.about，渲染只走 renderArticleOgPng，不读请求头 / Host', () => {
  const route = readFileSync('src/app/[locale]/about/og/route.tsx', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(route, /from '@\/lib\/seo\/about'/);
  assert.match(route, /aboutOgVersion\(locale, title\.trim\(\), badge\)/);
  assert.doesNotMatch(route, /articleOgVersion|articleOgImageUrl/);
  assert.match(route, /namespace: 'Nav' \}\)\)\('about'\)/);
  assert.match(route, /renderArticleOgPng\(title, l, \{ badge \}\)/);
  const page = readFileSync('src/app/[locale]/about/page.tsx', 'utf8');
  assert.match(page, /namespace: 'Nav' \}\)/);
  assert.match(page, /ogBadge: nav\('about'\)/);
  assert.doesNotMatch(route, /ImageResponse|headers|nextUrl|createHash|sha256/);
  const core = readFileSync('src/lib/about/og-response.ts', 'utf8');
  assert.doesNotMatch(core, /createHash|sha256/, 'no own hash function');
  assert.match(readFileSync('next.config.ts', 'utf8'), /'\/\[locale\]\/about\/og': \['\.\/src\/assets\/og-fonts\/\*\.ttf'\]/);
});

test('页面 og:image 的 v == 路由期望的 v（同一个角标）；角标不同 v 就不同', async () => {
  const { aboutOgImageUrl, aboutOgVersion } = await import('../src/lib/seo/about');
  const msgs = { en: JSON.parse(readFileSync('messages/en.json', 'utf8')), ru: JSON.parse(readFileSync('messages/ru.json', 'utf8')) };
  for (const [l, title] of [['en', 'About PackJoyU'], ['ru', 'О нас: упаковка и печать']] as const) {
    const badge: string = msgs[l].Nav.about;
    const pageV = new URL(aboutOgImageUrl('https://geiom.com', l, title, badge)!).searchParams.get('v');
    assert.equal(pageV, aboutOgVersion(l, title, badge));
    assert.notEqual(aboutOgVersion(l, title, badge), aboutOgVersion(l, title, 'Article'));
  }
});

// ── 真实路由（对照 tests/article-og-route.test.ts）：路由不经过 middleware（matcher 已排除），locale 由路由按 PUBLISHED_LOCALES 白名单校验 ──
const EVIL = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'host=evil.example' };
const callRoute = async (locale: string, query = `?v=${GOOD}`) => {
  const { GET } = await import('../src/app/[locale]/about/og/route');
  return GET(new Request(`http://evil.example/${locale}/about/og${query}`, { headers: EVIL }), { params: Promise.resolve({ locale }) });
};

test('真实路由：/ja/about/og 等未发布 / 乱写 locale → 404 no-store + 显式 X-Robots-Tag: noindex，无 Set-Cookie，不读设置', async () => {
  const logged: unknown[] = [];
  const err = console.error; console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    for (const l of ['ja', 'de', 'es', 'EN', 'en-US', '', 'zz-garbage', '..', '%2e%2e', '%2E%2E', '.', 'en/..', 'ru%2f..']) {
      for (const q of [`?v=${GOOD}`, '']) {
        const r = await callRoute(l, q);
        is404(r);
        assert.equal(r.headers.get('set-cookie'), null, l);
        assert.equal(r.headers.get('location'), null, l);
        assert.equal(await r.text(), '', l);
      }
    }
  } finally { console.error = err; }
  // 没走到 getAboutContent（读库失败会打 [site-settings] 日志，这里一条都不能有）
  assert.deepEqual(logged, []);
});

test('locale 白名单在读内容之前：og-response.ts 里 isPublishedLocale 先于 getAboutContent，来自 published-locales', async () => {
  const core = readFileSync('src/lib/about/og-response.ts', 'utf8').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '');
  const check = core.indexOf('if (!isPublishedLocale(locale)) return notFound();');
  const read = core.indexOf('deps.getAboutContent(');
  assert.ok(check > 0 && read > check, 'locale allowlist runs before the content read');
  assert.match(core, /from '@\/lib\/server\/published-locales'/);
  assert.match(core, /const NO_STORE = \{ \.\.\.OG_ROBOTS, 'Cache-Control': 'no-store' \} as const;/);
  assert.match(core, /const OG_ROBOTS = \{ 'X-Robots-Tag': 'noindex' \} as const;/);
  assert.doesNotMatch(core, /isProd|APP_ENV|NODE_ENV/, 'noindex must not depend on environment');
  const { PUBLISHED_LOCALES } = await import('../src/lib/server/published-locales');
  assert.deepEqual([...PUBLISHED_LOCALES], ['en', 'ru']);
});

test('en / ru：v 正确 → 200 真实 PNG 1200×630（真实模板 + SEO 的 aboutOgVersion + Nav.about 角标），noindex，无 Set-Cookie', async () => {
  const { aboutOgVersion } = await import('../src/lib/seo/about');
  const { renderArticleOgPng } = await import('../src/lib/seo/og/renderArticleOg');
  const msgs = { en: JSON.parse(readFileSync('messages/en.json', 'utf8')), ru: JSON.parse(readFileSync('messages/ru.json', 'utf8')) };
  for (const [l, title] of [['en', 'About PackJoyU'], ['ru', 'О компании: упаковка и печать']] as const) {
    const badge: string = msgs[l].Nav.about;
    const v = aboutOgVersion(l, title, badge);
    const d: AboutOgDeps = {
      getAboutContent: async (x) => content(x, title),
      getBadge: async () => badge,
      expectedVersion: (x, t, b) => aboutOgVersion(x, t, b),
      render: (t, x, b) => renderArticleOgPng(t, x, { badge: b }),
    };
    const r = await aboutOgResponse(`http://evil.example/${l}/about/og?v=${v}`, l, d);
    assert.equal(r.status, 200, l);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('set-cookie'), null);
    const png = Buffer.from(await r.arrayBuffer());
    assert.equal(png.readUInt32BE(0), 0x89504e47);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], l);
  }
});
