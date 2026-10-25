import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OG_STATIC_JPG_CACHE_CONTROL } from '../next.config';
import { parseArgs, normalizeBase, get, isNoindex, htmlLang, hreflangs, robotsRules, sitemapLocs, runChecks, sessionClearCookieViolation, SANITY_WEBHOOK_PATH, ADMIN_API_PROBE, OG_HOME_CACHE_PATH, OG_HOME_CACHE_CONTROL, type Fetch } from '../scripts/smoke';

const B = 'https://shop.example.com';
const page = (lang: string, robots = '') => `<!doctype html><html lang="${lang}"><head>${robots ? `<meta name="robots" content="${robots}"/>` : ''}<link rel="alternate" hrefLang="en" href="${B}/en"/><link rel="alternate" hrefLang="ru" href="${B}/ru"/><link rel="alternate" hrefLang="x-default" href="${B}/en"/></head><body>ok</body></html>`;
const GOOD: Record<string, [number, string, Record<string, string | string[]>?]> = {
  '/': [307, '', { location: '/en' }],
  '/en': [200, page('en')], '/ru': [200, page('ru')],
  '/robots.txt': [200, `User-Agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${B}/sitemap.xml\n`],
  '/sitemap.xml': [200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${B}/en</loc></url><url><loc>${B}/ru</loc></url></urlset>`],
  '/admin': [307, '', { location: '/api/auth/signin?callbackUrl=%2Fadmin' }],
  '/api/auth/signin': [200, '<html><body>Sign in</body></html>'],
  '/en/privacy': [200, page('en', 'noindex, follow')], '/ru/privacy': [200, page('ru', 'noindex, follow')],
  [SANITY_WEBHOOK_PATH]: [401, '{"error":"unauthorized"}'],
  [ADMIN_API_PROBE]: [401, '{"error":"unauthorized"}'],
  [OG_HOME_CACHE_PATH]: [200, '', { 'cache-control': OG_HOME_CACHE_CONTROL }],
};
function mock(routes: typeof GOOD) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (u: URL, init: RequestInit) => {
    seen.push({ url: String(u), init });
    const [s, body, h] = routes[new URL(u).pathname] ?? [404, 'nf'];
    const headers = new Headers();
    if (h) {
      for (const [key, value] of Object.entries(h)) {
        for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
      }
    }
    return new Response([301, 302, 303, 307, 308].includes(s) ? null : body, { status: s, headers });
  }) as unknown as Fetch;
  return { f, seen };
}
const run = (r: typeof GOOD, privacyIndexed = false) => { const m = mock(r); return runChecks(m.f, normalizeBase(B), { privacyIndexed, timeout: 1000 }).then((rs) => ({ rs, seen: m.seen })); };
const failed = (rs: { name: string; ok: boolean; detail: string }[]) => rs.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);

test('args: base must be http(s) origin; flags', () => {
  assert.equal(parseArgs(['--base', `${B}/`]).base.origin, B);
  assert.equal(parseArgs([`--base=${B}`, '--privacy-indexed']).privacyIndexed, true);
  for (const bad of ['ftp://x.com', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'https://u:p@x.com', 'https://x.com/path', 'https://x.com/?a=1']) assert.throws(() => normalizeBase(bad));
  assert.throws(() => parseArgs([]), /required/);
  assert.throws(() => parseArgs(['--base', B, '--token', 'x']), /unknown/);
});

test('all good → every check PASS; only GET/HEAD plus one unsigned POST; no secrets; manual redirects', async () => {
  const { rs, seen } = await run(GOOD);
  assert.deepEqual(failed(rs), []);
  assert.equal(rs.length, 11);
  assert.equal(OG_HOME_CACHE_CONTROL, OG_STATIC_JPG_CACHE_CONTROL);
  const posts = seen.filter((s) => s.init.method === 'POST');
  assert.equal(posts.length, 1); assert.equal(new URL(posts[0].url).pathname, SANITY_WEBHOOK_PATH);
  for (const s of seen) {
    assert.ok(['GET', 'HEAD', 'POST'].includes(String(s.init.method)));
    assert.equal(s.init.redirect, 'manual');
    assert.ok(s.init.signal, 'timeout signal');
    const h = Object.keys(s.init.headers as Record<string, string>).map((k) => k.toLowerCase());
    assert.ok(!h.includes('authorization') && !h.includes('cookie') && !h.some((k) => k.includes('signature')));
    assert.equal(new URL(s.url).origin, B);
  }
});

test('noindex detection: meta robots and X-Robots-Tag', async () => {
  assert.ok(isNoindex({ headers: new Headers({ 'x-robots-tag': 'noindex, nofollow' }), body: '' }));
  assert.ok(isNoindex({ headers: new Headers(), body: '<meta content="NOINDEX" name="robots">' }));
  assert.ok(!isNoindex({ headers: new Headers(), body: '<meta name="description" content="noindex">' }));
  const { rs } = await run({ ...GOOD, '/en': [200, page('en')], '/': [200, page('en', 'noindex')] });
  assert.match(failed(rs)[0], /homepage.*noindex/);
  const r2 = await run({ ...GOOD, '/': [200, page('en')] }); assert.deepEqual(failed(r2.rs), []);
});

test('lang / hreflang parsing and failures', async () => {
  assert.equal(htmlLang(page('ru')), 'ru');
  assert.deepEqual(Object.keys(hreflangs(page('en'))), ['en', 'ru', 'x-default']);
  const { rs } = await run({ ...GOOD, '/ru': [200, page('en')] });
  assert.match(failed(rs).join(), /\/ru .*lang=en/);
  const evil = page('en').replace(`${B}/ru`, 'https://evil.com/ru');
  assert.match(failed((await run({ ...GOOD, '/en': [200, evil] })).rs).join(), /other origin/);
});

test('robots.txt: needs /admin, /api/, Sitemap; whole-site Disallow fails', async () => {
  assert.deepEqual(robotsRules('User-agent: bot\nDisallow: /x\nUser-agent: *\nDisallow: /admin # c\nSitemap: https://a/sitemap.xml').disallow, ['/admin']);
  assert.match(failed((await run({ ...GOOD, '/robots.txt': [200, 'User-agent: *\nDisallow: /\n'] })).rs).join(), /whole site/);
  assert.match(failed((await run({ ...GOOD, '/robots.txt': [200, 'User-agent: *\nDisallow: /admin\nSitemap: x/sitemap.xml'] })).rs).join(), /api/);
});

test('sitemap: valid XML, absolute same-origin URLs', async () => {
  assert.deepEqual(sitemapLocs(`<urlset><url><loc>${B}/a?x=1&amp;y=2</loc></url></urlset>`), [`${B}/a?x=1&y=2`]);
  assert.throws(() => sitemapLocs('<html></html>'), /root/);
  assert.throws(() => sitemapLocs('<urlset><url><loc>x</url></urlset>'), /mismatched/);
  assert.match(failed((await run({ ...GOOD, '/sitemap.xml': [200, '<urlset><url><loc>/en</loc></url><url><loc>http://shop.example.com/ru</loc></url></urlset>'] })).rs).join(), /2 non-absolute or other-origin/);
});

test('/admin: served without login → FAIL; cross-origin redirect never fetched', async () => {
  const leak = await run({ ...GOOD, '/admin': [307, '', { location: '/admin/inquiries' }], '/admin/inquiries': [200, '<main class="adm-main">PJ-2610-ABC123</main>'] });
  assert.match(failed(leak.rs).join(), /admin content served without login/);
  const shell = await run({ ...GOOD, '/admin': [307, '', { location: '/admin/inquiries' }], '/admin/inquiries': [200, '<html>shell</html>'] });
  assert.match(failed(shell.rs).join(), /not redirected to login: final 200 \/admin\/inquiries/);
  const ext = await run({ ...GOOD, '/admin': [302, '', { location: 'https://evil.com/login' }] });
  assert.match(failed(ext.rs).join(), /redirect to other origin blocked/);
  assert.ok(!ext.seen.some((s) => s.url.includes('evil.com')));
});

test('privacy: noindex expected by default, indexable with --privacy-indexed, 404 reported', async () => {
  const idx = { ...GOOD, '/en/privacy': [200, page('en')], '/ru/privacy': [200, page('ru')] } as typeof GOOD;
  assert.equal(failed((await run(idx)).rs).length, 2);
  assert.deepEqual(failed((await run(idx, true)).rs), []);
  assert.equal(failed((await run(GOOD, true)).rs).length, 2);
  const nf = { ...GOOD } as typeof GOOD; delete nf['/en/privacy'];
  assert.match(failed((await run(nf)).rs).join(), /privacy page 404/);
});

test('sanity webhook: 401 PASS, 503 → "SANITY_WEBHOOK_SECRET not set", 200 FAIL', async () => {
  assert.match(failed((await run({ ...GOOD, [SANITY_WEBHOOK_PATH]: [503, '{}'] })).rs).join(), /SANITY_WEBHOOK_SECRET not set/);
  assert.match(failed((await run({ ...GOOD, [SANITY_WEBHOOK_PATH]: [200, '{}'] })).rs).join(), /expected 401, got 200/);
});

test('401 session-cookie clear is a whitelist of two names', async () => {
  const plain = 'authjs.session-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const secure = '__Secure-authjs.session-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure';
  assert.equal(sessionClearCookieViolation([]), null);
  assert.equal(sessionClearCookieViolation([plain, secure]), null);
  assert.equal(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT']), null);
  const livePlain = 'authjs.session-token=; Path=/; HttpOnly; SameSite=lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const liveSecure = '__Secure-authjs.session-token=; Path=/; HttpOnly; SameSite=lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure';
  assert.equal(sessionClearCookieViolation([livePlain, liveSecure]), null);
  assert.match(sessionClearCookieViolation(['__Secure-authjs.session-token=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT']) ?? '', /missing Secure/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; SameSite=None; Max-Age=0']) ?? '', /SameSite must be Lax or Strict/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; Max-Age=0']) ?? '', /missing SameSite/);
  assert.match(sessionClearCookieViolation([plain, secure, 'extra=; Path=/; HttpOnly; Max-Age=0']) ?? '', /too many/);
  assert.match(sessionClearCookieViolation(['sid=; Path=/; HttpOnly; Max-Age=0']) ?? '', /not allowed/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=leftover; Path=/; HttpOnly; Max-Age=0']) ?? '', /empty/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; Max-Age=0; Domain=shop.example.com']) ?? '', /attribute not allowed/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/admin; HttpOnly; Max-Age=0']) ?? '', /Path/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; Max-Age=0']) ?? '', /HttpOnly/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; Max-Age=60']) ?? '', /Max-Age/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; Expires=Wed, 21 Oct 2015 07:28:00 GMT']) ?? '', /1970/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:01 GMT']) ?? '', /1970/);
  assert.match(sessionClearCookieViolation(['authjs.session-token=; Path=/; HttpOnly; Expires=not-a-date-but-1970']) ?? '', /1970/);
  const ok = await run({ ...GOOD, [ADMIN_API_PROBE]: [401, '{}', { 'set-cookie': [plain, secure] }] });
  assert.deepEqual(failed(ok.rs), []);
  assert.equal(ok.rs.length, 11);
  const bad = await run({ ...GOOD, [ADMIN_API_PROBE]: [401, '{}', { 'set-cookie': 'sid=; Path=/; HttpOnly; Max-Age=0' }] });
  assert.match(failed(bad.rs).join(), /cookie name not allowed/);
  const webhookCookies = await run({ ...GOOD, [SANITY_WEBHOOK_PATH]: [401, '{}', { 'set-cookie': 'sid=; Path=/; HttpOnly; Max-Age=0' }] });
  assert.deepEqual(failed(webhookCookies.rs), []);
  assert.match(failed((await run({ ...GOOD, [ADMIN_API_PROBE]: [200, '{}'] })).rs).join(), /expected 401, got 200/);
  assert.match(failed((await run({ ...GOOD, [OG_HOME_CACHE_PATH]: [200, '', { 'cache-control': 'no-store' }] })).rs).join(), /no-store/);
  assert.deepEqual(failed((await run({ ...GOOD, [OG_HOME_CACHE_PATH]: [200, '', { 'cache-control': 'public, max-age=14400' }] })).rs), []);
  assert.match(failed((await run({ ...GOOD, [OG_HOME_CACHE_PATH]: [200, '', { 'cache-control': 'public, max-age=0' }] })).rs).join(), /max-age/);
  assert.match(failed((await run({ ...GOOD, [OG_HOME_CACHE_PATH]: [200, '', { 'cache-control': 'public, max-age=86400, no-store' }] })).rs).join(), /no-store/);
});

test('get(): too many same-origin redirects stops; non-http redirect blocked', async () => {
  const loop = mock({ '/a': [302, '', { location: '/a' }] } as never);
  await assert.rejects(get(loop.f, normalizeBase(B), '/a', { timeout: 100 }), /too many/);
  const js = mock({ '/a': [302, '', { location: 'javascript:alert(1)' }] } as never);
  await assert.rejects(get(js.f, normalizeBase(B), '/a', { timeout: 100 }), /other origin|non-http/);
});
