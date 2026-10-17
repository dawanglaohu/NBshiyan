import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest, NextResponse } from 'next/server';
import { NextURL } from 'next/dist/server/web/next-url';
import { getRelativeURL } from 'next/dist/shared/lib/router/utils/relativize-url';
import middleware from '../src/middleware';
import { collapseLeadingSlashes, isInternalHostname, isSafeRelativeLocation, listenOrigin, rewriteSameSiteRedirect, sameSiteRedirectPath as rel, siteOrigin } from '../src/lib/edge/redirect-location';

// standalone 下 middleware 的 req.url 和路由层 initURL（见 redirect-location.ts 顶部注释）：
// HOSTNAME=127.0.0.1 -> req.url http://localhost:<port>，initURL http://127.0.0.1:<port>
// HOSTNAME=0.0.0.0   -> 两者都是 http://0.0.0.0:<port>
const SITE = 'https://geiom.com';
const LISTEN = { '127.0.0.1': ['http://localhost:3000', 'http://127.0.0.1:3000'], '0.0.0.0': ['http://0.0.0.0:3000', 'http://0.0.0.0:3000'] } as const;
const nurl = (u: string) => new NextURL(u, { forceLocale: false, headers: {}, nextConfig: {} });
/** 用 Next 自己的 NextURL / getRelativeURL 模拟 adapter + 路由层对 Location 的处理（Next 升级改了行为时这里会失败） */
function nextPipeline(location: string, reqUrl: string, initUrl: string): string {
  let out = location;
  const r = nurl(location);
  if (r.host === nurl(reqUrl).host) out = r.toString();
  return getRelativeURL(out, initUrl);
}
const SPOOF = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
let saved: Record<string, string | undefined>;
beforeEach(() => { saved = { s: process.env.NEXT_PUBLIC_SITE_URL, h: process.env.HOSTNAME }; process.env.NEXT_PUBLIC_SITE_URL = SITE; });
afterEach(() => {
  for (const [k, v] of [['NEXT_PUBLIC_SITE_URL', saved.s], ['HOSTNAME', saved.h]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** 在 HOSTNAME=host 的 standalone 上请求 path，返回浏览器最终看到的 status / Location */
async function served(host: keyof typeof LISTEN, path: string, headers: Record<string, string> = {}) {
  process.env.HOSTNAME = host;
  const [reqBase, initBase] = LISTEN[host];
  const r = await middleware(new NextRequest(reqBase + path, { headers }));
  const loc = r.headers.get('location');
  return { status: r.status, location: loc === null ? null : nextPipeline(loc, reqBase + path, initBase + path), raw: loc, res: r };
}

test('internal hostnames: localhost, 127.0.0.0/8, ::1, 0.0.0.0, ::', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '0.0.0.0', '[::]']) assert.equal(isInternalHostname(h), true, h);
  for (const h of ['geiom.com', 'localhost.evil.com', 'evil-localhost', '128.0.0.1', '10.0.0.1', '127.0.0.1.evil.com', '[::2]']) assert.equal(isInternalHostname(h), false, h);
});

test('same-site path: loopback (localhost / 127.0.0.1 / ::1 / 0.0.0.0) and SITE_URL origin only', () => {
  assert.equal(rel('http://localhost:3000/en'), '/en');
  assert.equal(rel('http://127.0.0.1:3000/en?q=1#a'), '/en?q=1#a');
  assert.equal(rel('http://[::1]:3000/ru/products'), '/ru/products');
  assert.equal(rel('http://0.0.0.0:3000/en'), '/en');
  assert.equal(rel('https://geiom.com/en?q=1'), '/en?q=1');
  assert.equal(rel('https://GEIOM.com:443/en'), '/en');
  for (const loc of ['https://evil.example/en', 'https://evil.example/en?q=1', 'http://geiom.com/en', 'https://www.geiom.com/', 'https://geiom.com.evil.com/',
    'http://localhost.evil.com/', '/en', '//localhost/en', 'mailto:a@localhost', 'not a url']) assert.equal(rel(loc), null, loc);
  assert.equal(rel('https://geiom.com/en', ''), null);
  assert.equal(siteOrigin('javascript:alert(1)'), null);
});

test('loopback Location without a path -> "/" (never empty)', () => {
  assert.equal(rel('http://localhost:3000'), '/');
  assert.equal(rel('http://127.0.0.1:3000?x=1'), '/?x=1');
  assert.equal(rel('http://[::1]:3000#a'), '/#a');
});

test('leading run of / and \\ collapses to one /', () => {
  assert.equal(rel('http://localhost:3000//evil.com/x'), '/evil.com/x');
  assert.equal(rel('http://localhost:3000/\\evil.com'), '/evil.com');
  assert.equal(rel('http://localhost:3000\\\\/evil.com'), '/evil.com');
  for (const [i, o] of [['//evil.com/', '/evil.com/'], ['/\\evil.com', '/evil.com'], ['\\/x', '/x'], ['', '/'], ['/en', '/en']]) assert.equal(collapseLeadingSlashes(i), o);
  for (const bad of ['//evil.com', '/\\evil.com', '\\evil.com', 'evil.com', '/a b', '/a\\b', '/a\nb']) assert.equal(isSafeRelativeLocation(bad), false, JSON.stringify(bad));
  assert.equal(rel('http://localhost:3000/en/%2F%2Fevil.com'), '/en/%2F%2Fevil.com');
});

test('listenOrigin: HOSTNAME env (never Host headers); non-loopback HOSTNAME -> null', () => {
  const u = new URL('http://localhost:3000/');
  assert.equal(listenOrigin(u, '127.0.0.1'), 'http://127.0.1:3000');
  assert.equal(listenOrigin(u, '0.0.0.0'), 'http://0.0.0.0:3000');
  assert.equal(listenOrigin(u, undefined), 'http://0.0.0.0:3000');
  assert.equal(listenOrigin(u, '::1'), 'http://[0:0:0:0:0:0:0:1]:3000');
  assert.equal(listenOrigin(u, 'localhost'), 'http://localhost:3000');
  assert.equal(listenOrigin(new URL('https://localhost:3000/'), '127.0.0.1'), 'https://127.0.1:3000');
  for (const h of ['geiom.com', 'a1b2c3d4', '10.0.0.5']) assert.equal(listenOrigin(u, h), null, h);
});

for (const host of ['127.0.0.1', '0.0.0.0'] as const) {
  test(`standalone HOSTNAME=${host}: / -> exactly /en, /?q=1 -> exactly /en?q=1, cookie kept`, async () => {
    const r = await served(host, '/');
    assert.equal(r.status, 307);
    assert.equal(r.location, '/en');
    assert.match(r.res.headers.get('set-cookie') ?? '', /NEXT_LOCALE=en/);
    assert.equal((await served(host, '/?q=1')).location, '/en?q=1');
  });
  test(`standalone HOSTNAME=${host}: /products -> /en/products, ru Accept-Language -> /ru/products`, async () => {
    assert.equal((await served(host, '/products')).location, '/en/products');
    assert.equal((await served(host, '/products', { 'accept-language': 'ru-RU,ru;q=0.9' })).location, '/ru/products');
  });
  test(`standalone HOSTNAME=${host}: Host geiom.com + X-Forwarded-Proto/Host -> /en; spoofed Host / X-Forwarded-Host ignored`, async () => {
    assert.equal((await served(host, '/', { host: 'geiom.com', 'x-forwarded-host': 'geiom.com', 'x-forwarded-proto': 'https' })).location, '/en');
    for (const p of ['/', '/?q=1', '/products']) {
      const a = await served(host, p); const b = await served(host, p, SPOOF);
      assert.equal(b.raw, a.raw, p);
      assert.doesNotMatch(b.raw ?? '', /evil/);
    }
  });
  test(`standalone HOSTNAME=${host}: //evil.com, /\\evil.com, /%2F%2Fevil.com, /%5C%5Cevil.com -> same-site only`, async () => {
    for (const p of ['//evil.com', '//evil.com/', '/\\evil.com', '/%2F%2Fevil.com', '/%5Cevil.com', '/%5C%5Cevil.com', '///evil.com/x?y=1']) {
      for (const h of [{}, SPOOF]) {
        const r = await served(host, p, h);
        assert.ok(r.status < 500, p);
        if (r.location !== null) {
          assert.match(r.location, /^\/(?![/\\])/, `${p} -> ${r.location}`);
          assert.doesNotMatch(r.location, /^\/\/|^\/\\|^\\/);
          assert.ok(!new URL(r.location, 'https://geiom.com').host.includes('evil'), r.location);
        }
      }
    }
  });
}

test('existing locale path -> no redirect', async () => {
  for (const p of ['/en', '/ru', '/en/products']) {
    const r = await served('0.0.0.0', p);
    assert.equal(r.location, null, p);
    assert.equal(r.res.headers.get('x-middleware-request-x-next-intl-locale'), p.slice(1, 3));
  }
});

test('external redirect is left unchanged; non-3xx untouched; read-only headers are copied', () => {
  const u = new URL('http://localhost:3000/');
  const env = { HOSTNAME: '0.0.0.0', NEXT_PUBLIC_SITE_URL: SITE };
  assert.equal(rewriteSameSiteRedirect(u, NextResponse.redirect('https://evil.example/en?q=1', 307), env).headers.get('location'), 'https://evil.example/en?q=1');
  const ok = new NextResponse(null, { status: 200, headers: { location: 'http://localhost/x' } });
  assert.equal(rewriteSameSiteRedirect(u, ok, env).headers.get('location'), 'http://localhost/x');
  const frozen = rewriteSameSiteRedirect(u, Response.redirect('http://127.0.0.1:3000/ru', 301), env);
  assert.equal(frozen.status, 301);
  assert.equal(frozen.headers.get('location'), 'http://0.0.0.0:3000/ru');
});

test('non-loopback HOSTNAME (e.g. container id) falls back to SITE_URL origin, never loopback', async () => {
  process.env.HOSTNAME = 'a1b2c3d4e5f6';
  const r = await middleware(new NextRequest('http://localhost:3000/'));
  assert.equal(r.headers.get('location'), 'https://geiom.com/en');
});
