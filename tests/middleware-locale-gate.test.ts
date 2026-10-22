import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import middleware, { config } from '../src/middleware';
import { isBlockedLocalePath, NON_LOCALE_TOP_SEGMENTS } from '../src/lib/edge/locale-gate';

// 多语言第 0 期：middleware 在 next-intl 之前按白名单拦下未发布语言（全栈审核要点 2–5）
const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(new URL(path, 'http://localhost:3000'), { headers });
const rewriteTarget = (res: Response) => res.headers.get('x-middleware-rewrite');
// 中间件里的 Location 是监听 origin + 路径（路由层再改成相对路径，见 redirect-location.ts），这里只比路径
const locPath = (res: Response) => { const l = res.headers.get('location'); return l === null ? null : new URL(l, 'http://x').pathname; };

const BLOCKED = [
  '/ja', '/ja/', '/es/products', '/de/contact', '/fr', '/hi/products/x', '/ar', '/ja/s/abcdefghij12', '/es/s/expired', // 预留语言
  '/xx', '/zz/products', '/zh', '/cn', // 未知代码
  '/EN', '/Ru', '/eN/products', '/RU/contact', // 大小写变体
  '/en-US', '/en-us/products', '/ru-RU', '/en_US', '/zh-Hant-TW' // 地区变体
];

test('point 2/5: reserved, unknown, case and region variants → 404 + X-Robots-Tag noindex, no redirect', async () => {
  for (const p of BLOCKED) {
    assert.equal(isBlockedLocalePath(p), true, p);
    const res = await middleware(req(p, { 'accept-language': 'ja,en;q=0.5' }));
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('location'), null, `${p} must not redirect`);
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/, p);
    // rewrite 到站内 404 页，目标固定，不带任何请求里的路径
    assert.equal(new URL(rewriteTarget(res)!).pathname, '/en/locale-unavailable', p);
  }
});

test('point 2: allowlist only — published en/ru pages pass to next-intl unchanged', async () => {
  for (const p of ['/en', '/ru', '/en/products', '/ru/contact', '/ru/products/podarochnye-korobki', '/en/privacy', '/en/articles', '/ru/solutions', '/en/factory', '/ru/cases']) {
    assert.equal(isBlockedLocalePath(p), false, p);
    const res = await middleware(req(p));
    assert.notEqual(res.status, 404, p);
    assert.equal(res.headers.get('location'), null, p);
  }
});

test('point 3: non-locale top-level routes are never 404ed by the gate (enumerated from src/app)', async () => {
  const top = readdirSync('src/app', { withFileTypes: true }).map((d) => d.name.replace(/\.(tsx?|png|svg|css)$/, ''));
  const routes = [...new Set([...top.filter((n) => !n.startsWith('[')), 'robots.txt', 'sitemap.xml', 'icon.svg', 'apple-icon.png'])];
  // [locale] 下的页面在没有语言前缀时由 next-intl 跳到 /en/…（原行为）
  const locSegs = readdirSync('src/app/[locale]', { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('[')).map((d) => d.name);
  const extra = ['/', '/og', '/s/abcdefghij12', '/admin', '/admin/inquiries', '/admin-enroll', '/api/inquiries', '/api/health', '/_next/static/a.js', '/models/x.glb', '/images/a.png', '/abcdefgh12.txt'];
  for (const p of [...routes.map((r) => `/${r}`), ...locSegs.map((s) => `/${s}`), ...extra]) assert.equal(isBlockedLocalePath(p), false, p);
  for (const s of locSegs) {
    const res = await middleware(req(`/${s}`));
    assert.equal(res.status, 307, s);
    assert.equal(locPath(res), `/en/${s}`, s);
  }
  assert.ok(NON_LOCALE_TOP_SEGMENTS.has('og'));
  const og = await middleware(req('/og'));
  assert.notEqual(og.status, 404);
});

test('point 3: matcher still keeps api/admin/_next/static files out of the locale middleware', () => {
  const m = getPathMatch(config.matcher[0], { removeUnnamedParams: true, strict: true });
  for (const p of ['/api/inquiries', '/api/designs', '/admin', '/admin-enroll', '/_next/static/x.js', '/robots.txt', '/sitemap.xml', '/icon.svg', '/s/abc', '/models/a.glb', '/images/a.png'])
    assert.equal(m(p), false, p);
  for (const p of ['/ja', '/EN', '/en-US/products', '/xx']) assert.ok(m(p), p);
});

test('point 4: admin branch and shortlink/expired checks still run first (no early return skips them)', async () => {
  const a = await middleware(req('/admin/inquiries?x=1'));
  assert.equal(a.headers.get('x-middleware-request-x-admin-path'), '/admin/inquiries?x=1');
  const e = await middleware(req('/en/s/expired'));
  assert.equal(e.status, 404);
  assert.equal(e.headers.get('x-middleware-rewrite'), null); // 原有的过期页 404 分支，不是本次的 rewrite
  const src = readFileSync('src/middleware.ts', 'utf8');
  const gate = src.indexOf('isBlockedLocalePath(pathname)');
  for (const before of ["pathname.startsWith('/admin/')", 'EXPIRED_RE.test(pathname)', 'parseShortlink(pathname)']) assert.ok(src.indexOf(before) < gate, before);
  assert.ok(gate < src.indexOf('intl(req)'), 'gate must run before next-intl');
});

test('next-intl detection only picks published locales: / with Accept-Language ja or cookie ja → /en', async () => {
  for (const h of [{ 'accept-language': 'ja-JP,ja;q=0.9' }, { cookie: 'NEXT_LOCALE=ja' }, { 'accept-language': 'ar' }] as Record<string, string>[]) {
    const res = await middleware(req('/', h));
    assert.equal(locPath(res), '/en', JSON.stringify(h));
  }
  const ru = await middleware(req('/', { 'accept-language': 'ru-RU,ru;q=0.9' }));
  assert.equal(locPath(ru), '/ru');
});

test('gate 404 page: English 404 styling, primary button → /en, «Русский» text link, no canonical / hreflang; real 404 via notFound()', () => {
  const page = readFileSync('src/app/[locale]/locale-unavailable/page.tsx', 'utf8');
  const view = readFileSync('src/app/[locale]/locale-unavailable/not-found.tsx', 'utf8');
  assert.match(page, /notFound\(\);/);
  assert.match(view, /robots: \{ index: false, follow: true \}/);
  assert.doesNotMatch(view, /alternates|canonical:/);
  assert.match(view, /className="container nf nf-locale"/);
  assert.match(view, /<Link className="btn" href="\/" locale=\{DEFAULT_PUBLISHED_LOCALE\}/);
  assert.match(view, /PUBLISHED_LOCALES\.filter\(\(l\) => l !== DEFAULT_PUBLISHED_LOCALE\)/);
  assert.match(view, /LOCALE_META\[l\]\.nativeName/);
});

test('rewrite target is internal (listen origin), never taken from spoofed Host / X-Forwarded-Host', async () => {
  const res = await middleware(req('/ja', { host: 'evil.example', 'x-forwarded-host': 'evil.example' }));
  const u = new URL(rewriteTarget(res)!);
  assert.notEqual(u.hostname, 'evil.example');
  assert.equal(u.pathname, '/en/locale-unavailable');
  assert.equal(u.search, '');
});

test('gate 404 page is never prerendered / CDN-cached (force-dynamic)', () => {
  assert.match(readFileSync('src/app/[locale]/locale-unavailable/page.tsx', 'utf8'), /export const dynamic = 'force-dynamic';/);
});
