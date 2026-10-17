import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest, NextResponse } from 'next/server';
import middleware from '../src/middleware';
import { collapseLeadingSlashes, internalLocationToRelative, isInternalHostname, relativizeInternalRedirect } from '../src/lib/edge/redirect-location';

// standalone / next start 下 req.url 是监听地址，next-intl 会生成 http://localhost:<port>/en 这样的 Location
const run = (url: string, headers: Record<string, string> = {}) => middleware(new NextRequest(url, { headers }));
const SPOOF = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
// 相对 Location 必须正好以一个 / 开头，后面不是 / 或 \（否则浏览器会当成 //host）
const SAME_SITE_RELATIVE = /^\/(?![/\\])/;
const SITE = 'https://geiom.com';
let savedSite: string | undefined;
beforeEach(() => { savedSite = process.env.NEXT_PUBLIC_SITE_URL; delete process.env.NEXT_PUBLIC_SITE_URL; });
afterEach(() => { if (savedSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL = savedSite; });

test('internal hostnames: localhost, 127.0.0.0/8, ::1, 0.0.0.0, :: (case / trailing dot)', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', '127.0.0.1', '127.1.2.3', '127.255.255.255', '[::1]', '::1', '0.0.0.0', '[::]'])
    assert.equal(isInternalHostname(h), true, h);
  for (const h of ['geiom.com', 'www.geiom.com', 'localhost.evil.com', 'evil-localhost', '128.0.0.1', '10.0.0.1', '192.168.1.1', '127.0.0.1.evil.com', '[::2]', '1.1.1.1'])
    assert.equal(isInternalHostname(h), false, h);
});

test('loopback absolute Location -> relative path (pathname+search+hash)', () => {
  assert.equal(internalLocationToRelative('http://localhost:3000/en'), '/en');
  assert.equal(internalLocationToRelative('https://localhost:3000/en?q=1#top'), '/en?q=1#top');
  assert.equal(internalLocationToRelative('http://127.0.0.1:3000/ru/products?x=1&y=2'), '/ru/products?x=1&y=2');
  assert.equal(internalLocationToRelative('http://[::1]:3000/en'), '/en');
  assert.equal(internalLocationToRelative('http://0.0.0.0:3000/en'), '/en');
});

test('loopback Location without a path -> "/" (never empty)', () => {
  assert.equal(internalLocationToRelative('http://localhost:3000'), '/');
  assert.equal(internalLocationToRelative('http://localhost'), '/');
  assert.equal(internalLocationToRelative('http://127.0.0.1:3000?x=1'), '/?x=1');
  assert.equal(internalLocationToRelative('http://[::1]:3000#a'), '/#a');
});

test('never produces a protocol-relative Location: leading run of / and \\ collapses to one /', () => {
  assert.equal(internalLocationToRelative('http://localhost:3000//evil.com/x'), '/evil.com/x');
  assert.equal(internalLocationToRelative('http://localhost:3000///evil.com'), '/evil.com');
  assert.equal(internalLocationToRelative('http://localhost:3000/\\evil.com/en'), '/evil.com/en');
  assert.equal(internalLocationToRelative('http://localhost:3000\\/evil.com'), '/evil.com');
  assert.equal(internalLocationToRelative('https://geiom.com//evil.com/en', SITE), '/evil.com/en');
  for (const [i, o] of [['//evil.com/', '/evil.com/'], ['/\\evil.com', '/evil.com'], ['\\/evil.com', '/evil.com'], ['\\\\x', '/x'], ['/', '/'], ['', '/'], ['/en', '/en']])
    assert.equal(collapseLeadingSlashes(i), o, JSON.stringify(i));
  // 编码过的 %2F / %5C 只是路径里的普通字符，浏览器不会当成主机分隔符，保持原样
  assert.equal(internalLocationToRelative('http://localhost:3000/en/%2F%2Fevil.com'), '/en/%2F%2Fevil.com');
});

test('NEXT_PUBLIC_SITE_URL origin counts as our own site; only exact origin matches', () => {
  assert.equal(internalLocationToRelative('https://geiom.com/en?q=1', SITE), '/en?q=1');
  assert.equal(internalLocationToRelative('https://geiom.com', SITE), '/');
  assert.equal(internalLocationToRelative('https://geiom.com:443/ru', SITE + '/'), '/ru');
  for (const loc of ['http://geiom.com/en', 'https://www.geiom.com/en', 'https://geiom.com:8443/en', 'https://geiom.com.evil.com/en', 'https://evil.com/geiom.com'])
    assert.equal(internalLocationToRelative(loc, SITE), null, loc);
  // SITE_URL 未设置 / 无效时，geiom.com 也保持绝对地址
  assert.equal(internalLocationToRelative('https://geiom.com/en', undefined), null);
  assert.equal(internalLocationToRelative('https://geiom.com/en', 'not a url'), null);
  assert.equal(internalLocationToRelative('https://geiom.com/en', 'javascript:alert(1)'), null);
});

test('external / non-http / already-relative Locations are left unchanged', () => {
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
  for (const loc of ['https://evil.example/en', 'http://localhost.evil.com/en', 'https://www.geiom.com/']) assert.equal(internalLocationToRelative(loc), null, loc);
  delete process.env.NEXT_PUBLIC_SITE_URL;
  for (const loc of ['https://geiom.com/en', 'https://www.geiom.com/', 'https://evil.example/en', 'http://localhost.evil.com/en',
    '/en', '/en?q=1', '//localhost/en', 'mailto:a@localhost', 'ftp://localhost/x', 'not a url', 'http://'])
    assert.equal(internalLocationToRelative(loc), null, loc);
});

test('relativizeInternalRedirect only touches 3xx and keeps other headers (cookies) intact', () => {
  const r = NextResponse.redirect('http://localhost:3000/en?q=1', 307);
  r.cookies.set('NEXT_LOCALE', 'en');
  const out = relativizeInternalRedirect(r);
  assert.equal(out.status, 307);
  assert.equal(out.headers.get('location'), '/en?q=1');
  assert.match(out.headers.get('set-cookie') ?? '', /NEXT_LOCALE=en/);
  // 200 带 Location（不该出现，但也不改）
  const ok = new NextResponse(null, { status: 200, headers: { location: 'http://localhost/x' } });
  assert.equal(relativizeInternalRedirect(ok).headers.get('location'), 'http://localhost/x');
  // 外部跳转不动
  assert.equal(relativizeInternalRedirect(NextResponse.redirect('https://geiom.com/en', 308)).headers.get('location'), 'https://geiom.com/en');
  // Response.redirect 的头是只读的：复制响应后改写，状态码不变
  const frozen = relativizeInternalRedirect(Response.redirect('http://127.0.0.1:3000/ru', 301));
  assert.equal(frozen.status, 301);
  assert.equal(frozen.headers.get('location'), '/ru');
});

test('middleware: / -> 307 Location /en, NEXT_LOCALE cookie kept', async () => {
  const r = await run('http://localhost:3000/');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), '/en');
  assert.match(r.headers.get('set-cookie') ?? '', /NEXT_LOCALE=en/);
  for (const [k, v] of r.headers) assert.doesNotMatch(v, /localhost|127\.0\.0\.1/, k);
});

test('middleware: /?q=1 keeps the query string', async () => {
  const r = await run('http://localhost:3000/?q=1');
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), '/en?q=1');
});

test('middleware: unprefixed /products -> /en/products, ru Accept-Language -> /ru/products', async () => {
  assert.equal((await run('http://127.0.0.1:3000/products')).headers.get('location'), '/en/products');
  const ru = await run('http://127.0.0.1:3000/products', { 'accept-language': 'ru-RU,ru;q=0.9' });
  assert.equal(ru.status, 307);
  assert.equal(ru.headers.get('location'), '/ru/products');
});

test('middleware: listen address ::1 / 0.0.0.0 and https (X-Forwarded-Proto) variants', async () => {
  assert.equal((await run('http://[::1]:3000/')).headers.get('location'), '/en');
  assert.equal((await run('http://0.0.0.0:3000/')).headers.get('location'), '/en');
  assert.equal((await run('https://localhost:3000/')).headers.get('location'), '/en');
});

test('middleware: Host geiom.com + X-Forwarded-Proto/Host -> still relative /en', async () => {
  const r = await run('http://localhost:3000/', { host: 'geiom.com', 'x-forwarded-host': 'geiom.com', 'x-forwarded-proto': 'https' });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), '/en');
});

test('middleware: spoofed Host / X-Forwarded-Host does not influence the Location', async () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1:3000/?q=1']) {
    const plain = await run(url);
    const spoofed = await run(url, SPOOF);
    assert.equal(spoofed.headers.get('location'), plain.headers.get('location'));
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

test('middleware: req.url on SITE_URL origin -> relative; any other real host stays absolute', async () => {
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
  assert.equal((await run('https://geiom.com/')).headers.get('location'), '/en');
  assert.equal((await run('https://staging.example/')).headers.get('location'), 'https://staging.example/en');
  delete process.env.NEXT_PUBLIC_SITE_URL;
  assert.equal((await run('https://geiom.com/')).headers.get('location'), 'https://geiom.com/en');
});

test('middleware: //evil.com, /\\evil.com, /%2F%2Fevil.com etc. -> same-site relative Location', async () => {
  const cases: Array<[string, string]> = [
    ['//evil.com', '/en/evil.com'], ['//evil.com/', '/en/evil.com'], ['/\\evil.com', '/en/evil.com'], ['/\\/evil.com', '/en/evil.com'],
    ['///evil.com/x?y=1', '/en/evil.com/x?y=1'], ['/%2F%2Fevil.com', '/en/%2F%2Fevil.com'], ['/%5Cevil.com', '/en/%5Cevil.com'],
  ];
  for (const withSite of [false, true]) {
    if (withSite) process.env.NEXT_PUBLIC_SITE_URL = SITE;
    for (const [p, want] of cases) {
      for (const h of [{}, SPOOF]) {
        const r = await run(`http://localhost:3000${p}`, h);
        const loc = r.headers.get('location') ?? '';
        assert.equal(r.status, 307, p);
        assert.match(loc, SAME_SITE_RELATIVE, `${p} -> ${loc}`);
        assert.equal(loc, want, p);
      }
    }
  }
});
