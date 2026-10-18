import test from 'node:test';
import assert from 'node:assert/strict';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { NextRequest } from 'next/server';
import middleware, { config } from '../src/middleware';

// 分享图接口不走 middleware（否则 next-intl 会下发 NEXT_LOCALE cookie，运维 Set-Cookie 预检 FAIL）。
// 只排除最后一段恰好是 og 的两个确切形状：/<l>/articles/<slug>/og 和 /<l>/about/og；其余路径行为不变。
const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

test('OG 路径不经过 middleware：文章分享图、未来的 /<l>/about/og，含未发布 / 乱写的 locale（交给路由自己 404）', () => {
  for (const u of [
    '/en/articles/mock-article-packaging-guide/og',
    '/ru/articles/mock-statya-o-upakovke/og',
    '/en/articles/mock-article-packaging-guide/og?v=1a2b3c4d',
    '/en/articles/og/og',
    '/en/about/og',
    '/ru/about/og',
    '/ja/articles/x/og',
    '/ja/about/og',
    '/zz-garbage/articles/x/og'
  ]) assert.equal(matches(u), false, u);
});

test('其他路径照常经过 middleware：og 只作为子串、slug 叫 og、或段数/位置不对都不排除', () => {
  for (const u of [
    '/', '/en', '/ru', '/en/catalog', '/en/about', '/ru/about', '/en/ogx', '/en/og',
    '/en/articles', '/en/articles/og', '/en/articles/og-guide', '/en/articles/blog-guide', '/en/articles/mock-article-packaging-guide',
    '/en/articles/x/ogx', '/en/articles/x/og/extra', '/en/articles/x/y/og', '/en/about/ogx', '/en/about/x/og',
    '/en/products/og', '/en/products/x/og', '/articles/x/og', '/about/og', '/ja', '/ja/articles/x',
    '/s/abc123', '/en/s/abc123', '/admin', '/admin/inquiries'
  ]) assert.equal(matches(u), true, u);
});

test('静态文件 /og/*.jpg（public/og 通用分享图）仍不经过 middleware，和改动前一致', () => {
  for (const u of ['/og/home-en.jpg', '/og/home-ru.jpg?v=7086247a', '/og/category-custom-gift-boxes-en.jpg']) assert.equal(matches(u), false, u);
});

test('对照：经过 middleware 的普通页面仍下发 NEXT_LOCALE / 照常做语言跳转', async () => {
  const page = await middleware(new NextRequest('http://localhost:3000/en/articles/og-guide'));
  assert.match(page.headers.get('set-cookie') ?? '', /NEXT_LOCALE=en/);
  const root = await middleware(new NextRequest('http://localhost:3000/', { headers: { 'accept-language': 'ru' } }));
  assert.ok([307, 308].includes(root.status), String(root.status));
  assert.equal(new URL(root.headers.get('location') ?? '', 'http://x').pathname, '/ru');
});
