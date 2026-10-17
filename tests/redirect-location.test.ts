import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest, NextResponse } from 'next/server';
import { NextURL } from 'next/dist/server/web/next-url';
import middleware from '../src/middleware';
import { canonicalizeRedirect, canonicalizeRedirectLocation as canon, collapseLeadingSlashes, isInternalHostname, publicSiteOrigin } from '../src/lib/edge/redirect-location';

// standalone / next start 下 req.url 是监听地址，next-intl 会生成 http://localhost:<port>/en 这样的 Location
const SITE = 'https://geiom.com';
const run = (url: string, headers: Record<string, string> = {}) => middleware(new NextRequest(url, { headers }));
const SPOOF = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
// Next 的 middleware adapter 会用 new NextURL(Location) 再解析一遍：必须是绝对地址，否则 Invalid URL -> 500
const adapterParses = (loc: string) => new NextURL(loc, { forceLocale: false, headers: {}, nextConfig: {} }).toString();
// 路径必须正好以一个 / 开头，后面不是 / 或 \
const SAME_SITE = /^https:\/\/geiom\.com\/(?![/\\])/;

let saved: string | undefined;
beforeEach(() => { saved = process.env.NEXT_PUBLIC_SITE_URL; process.env.NEXT_PUBLIC_SITE_URL = SITE; });
afterEach(() => { if (saved === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = saved; });

test('internal hostnames: localhost, 127.0.0.0/8, ::1, 0.0.0.0, :: (case / trailing dot)', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1.2.3', '127.255.255.255', '[::1]', '::1', '0.0.0.0', '[::]'])
    assert.equal(isInternalHostname(h), true, h);
  for (const h of ['geiom.com', 'www.geiom.com', 'localhost.evil.com', 'evil-localhost', '128.0.0.1', '10.0.0.1', '192.168.1.1', '127.0.0.1.evil.com', '[::2]', '1.1.1.1'])
    assert.equal(isInternalHostname(h), false, h);
});

test('SITE_URL origin: only a public http(s) origin counts (dev localhost / invalid -> null)', () => {
  assert.equal(publicSiteOrigin('https://geiom.com'), SITE);
  assert.equal(publicSiteOrigin('https://geiom.com/'), SITE);
  assert.equal(publicSiteOrigin(' https://geiom.com/en '), SITE);
  for (const s of [undefined, '', 'not a url', 'javascript:alert(1)', 'http://localhost:3000', 'https://127.0.0.1', 'http://[::1]:3000'])
    assert.equal(publicSiteOrigin(s), null, String(s));
});

test('loopback Location -> SITE_URL origin + pathname+search+hash: localhost, 127.0.0.1, ::1, 0.0.0.0', () => {
  assert.equal(canon('http://localhost:3000/en'), 'https://geiom.com/en');
  assert.equal(canon('https://localhost:3000/en?q=1#top'), 'https://geiom.com/en?q=1#top');
  assert.equal(canon('http://127.0.0.1:3000/ru/products?x=1&y=2'), 'https://geiom.com/ru/products?x=1&y=2');
  assert.equal(canon('http://[::1]:3000/en'), 'https://geiom.com/en');
  assert.equal(canon('http://0.0.0.0:3000/en?q=1'), 'https://geiom.com/en?q=1');
});

test('loopback Location without a path -> "/" (never an empty path)', () => {
  assert.equal(canon('http://localhost:3000'), 'https://geiom.com/');
  assert.equal(canon('http://localhost'), 'https://geiom.com/');
  assert.equal(canon('http://127.0.0.1:3000?x=1'), 'https://geiom.com/?x=1');
  assert.equal(canon('http://[::1]:3000#a'), 'https://geiom.com/#a');
});

test('leading run of / and \\ collapses to one /, so //evil.com can never be emitted', () => {
  assert.equal(canon('http://localhost:3000//evil.com/x'), 'https://geiom.com/evil.com/x');
  assert.equal(canon('http://localhost:3000///evil.com'), 'https://geiom.com/evil.com');
  assert.equal(canon('http://localhost:3000/\\evil.com/en'), 'https://geiom.com/evil.com/en');
  assert.equal(canon('http://localhost:3000\\/evil.com'), 'https://geiom.com/evil.com');
  assert.equal(canon('https://geiom.com//evil.com/en'), 'https://geiom.com/evil.com/en');
  for (const [i, o] of [['//evil.com/', '/evil.com/'], ['/\\evil.com', '/evil.com'], ['\\/evil.com', '/evil.com'], ['\\\\x', '/x'], ['/', '/'], ['', '/'], ['/en', '/en']])
    assert.equal(collapseLeadingSlashes(i), o, JSON.stringify(i));
  // 编码过的 %2F / %5C 只是路径里的普通字符，浏览器不会当成主机分隔符，保持原样
  assert.equal(canon('http://localhost:3000/en/%2F%2Fevil.com'), 'https://geiom.com/en/%2F%2Fevil.com');
});

test('external domains, other geiom origins, relative and non-http Locations are unchanged', () => {
  for (const loc of ['https://evil.example/en', 'https://evil.example/en?q=1', 'http://localhost.evil.com/en', 'https://www.geiom.com/',
    'http://geiom.com/en', 'https://geiom.com:8443/en', 'https://geiom.com.evil.com/en', 'https://evil.com/geiom.com',
    'https://geiom.com/en', 'https://geiom.com/en?q=1', // 已经是本站地址：不用改
    '/en', '/en?q=1', '//localhost/en', 'mailto:a@localhost', 'ftp://localhost/x', 'not a url', 'http://'])
    assert.equal(canon(loc), null, loc);
});

test('without a public SITE_URL nothing is rewritten (relative Location would 500 in Next adapter)', () => {
  for (const s of ['', '  ', 'http://localhost:3000', 'not a url']) assert.equal(canon('http://localhost:3000/en', s), null, String(s));
});

test('canonicalizeRedirect only touches 3xx and keeps other headers (cookies) intact', () => {
  const r = NextResponse.redirect('http://localhost:3000/en?q=1', 307);
  r.cookies.set('NEXT_LOCALE', 'en');
  const out = canonicalizeRedirect(r);
  assert.equal(out.status, 307);
  assert.equal(out.headers.get('location'), 'https://geiom.com/en?q=1');
  assert.match(out.headers.get('set-cookie') ?? '', /NEXT_LOCALE=en/);
  const ok = new NextResponse(null, { status: 200, headers: { location: 'http://localhost/x' } });
  assert.equal(canonicalizeRedirect(ok).headers.get('location'), 'http://localhost/x');
  assert.equal(canonicalizeRedirect(NextResponse.redirect('https://evil.example/en', 308)).headers.get('location'), 'https://evil.example/en');
  // Response.redirect 的头是只读的：复制响应后改写，状态码不变
  const frozen = canonicalizeRedirect(Response.redirect('http://127.0.0.1:3000/ru', 301));
  assert.equal(frozen.status, 301);
  assert.equal(frozen.headers.get('location'), 'https://geiom.com/ru');
});

const noLoopbackHeaders = (r: Response) => { for (const [k, v] of r.headers) assert.doesNotMatch(v, /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/, k); };

test('middleware: / -> 307 https://geiom.com/en, cookie kept, no loopback in any header, adapter-parsable', async () => {
  const r = await run('http://localhost:3000/');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), 'https://geiom.com/en');
  assert.match(r.headers.get('set-cookie') ?? '', /NEXT_LOCALE=en/);
  noLoopbackHeaders(r);
  assert.equal(adapterParses(r.headers.get('location')!), 'https://geiom.com/en');
});

test('middleware: /?q=1 keeps the query string', async () => {
  const r = await run('http://127.0.0.1:3000/?q=1');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), 'https://geiom.com/en?q=1');
});

test('middleware: unprefixed /products -> /en/products, ru Accept-Language -> /ru/products', async () => {
  assert.equal((await run('http://127.0.0.1:3000/products')).headers.get('location'), 'https://geiom.com/en/products');
  const ru = await run('http://127.0.0.1:3000/products', { 'accept-language': 'ru-RU,ru;q=0.9' });
  assert.equal(ru.status, 307);
  assert.equal(ru.headers.get('location'), 'https://geiom.com/ru/products');
});

test('middleware: listen address ::1 / 0.0.0.0 / https://localhost variants', async () => {
  for (const u of ['http://[::1]:3000/', 'http://0.0.0.0:3000/', 'https://localhost:3000/'])
    assert.equal((await run(u)).headers.get('location'), 'https://geiom.com/en', u);
});

test('middleware: Host geiom.com + X-Forwarded-Proto/Host -> https://geiom.com/en', async () => {
  const r = await run('http://localhost:3000/', { host: 'geiom.com', 'x-forwarded-host': 'geiom.com', 'x-forwarded-proto': 'https' });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), 'https://geiom.com/en');
});

test('middleware: spoofed Host / X-Forwarded-Host does not influence the Location', async () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:3000/?q=1', 'http://127.0.0.1:3000/products']) {
    const plain = await run(url);
    const spoofed = await run(url, SPOOF);
    assert.equal(spoofed.headers.get('location'), plain.headers.get('location'), url);
    assert.doesNotMatch(spoofed.headers.get('location') ?? '', /evil/);
  }
});

test('middleware: existing locale path -> no redirect', async () => {
  for (const p of ['/en', '/ru', '/en/products']) {
    const r = await run(`http://localhost:3000${p}`);
    assert.ok(r.status < 300 || r.status >= 400, `${p} status ${r.status}`);
    assert.equal(r.headers.get('location'), null, p);
    assert.equal(r.headers.get('x-middleware-request-x-next-intl-locale'), p.slice(1, 3));
  }
});

test('middleware: req.url on another real host stays absolute on that host (not ours to change)', async () => {
  assert.equal((await run('https://staging.example/')).headers.get('location'), 'https://staging.example/en');
  assert.equal((await run('https://geiom.com/')).headers.get('location'), 'https://geiom.com/en');
});

test('middleware: dev (SITE_URL is localhost / unset) keeps next-intl behaviour', async () => {
  process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
  assert.equal((await run('http://localhost:3001/')).headers.get('location'), 'http://localhost:3001/en');
  delete process.env.NEXT_PUBLIC_SITE_URL;
  assert.equal((await run('http://localhost:3001/')).headers.get('location'), 'http://localhost:3001/en');
});

test('middleware: //evil.com, /\\evil.com, /%2F%2Fevil.com etc. -> same-site Location (one leading /)', async () => {
  const cases: Array<[string, string]> = [
    ['//evil.com', '/en/evil.com'], ['//evil.com/', '/en/evil.com'], ['/\\evil.com', '/en/evil.com'], ['/\\/evil.com', '/en/evil.com'],
    ['///evil.com/x?y=1', '/en/evil.com/x?y=1'], ['/%2F%2Fevil.com', '/en/%2F%2Fevil.com'], ['/%5Cevil.com', '/en/%5Cevil.com'],
  ];
  for (const [p, want] of cases) {
    for (const h of [{}, SPOOF]) {
      const r = await run(`http://localhost:3000${p}`, h);
      const loc = r.headers.get('location') ?? '';
      assert.equal(r.status, 307, p);
      assert.match(loc, SAME_SITE, `${p} -> ${loc}`);
      assert.equal(loc, SITE + want, p);
      assert.equal(new URL(adapterParses(loc)).host, 'geiom.com');
    }
  }
});
