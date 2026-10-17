import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientIp, isIP, tooManyRequests, rateLimitSubject } from '../src/lib/server/security';
import { constantTimeEqual, resolveClientIp, trustedCountry, edgeAuthOk, _resetClientIpWarnings, UNTRUSTED } from '../src/lib/edge/client-ip';

// 测试用的假密钥（不是任何环境的真实值）
const SECRET = 'edge-test-secret-0123456789abcdef-XYZ';
const req = (h: Record<string, string>) => new Request('http://x/', { headers: h });
const authed = (h: Record<string, string> = {}) => req({ 'x-edge-auth': SECRET, ...h });
beforeEach(() => { process.env.EDGE_AUTH_SECRET = SECRET; _resetClientIpWarnings(); });
afterEach(() => { delete process.env.EDGE_AUTH_SECRET; delete process.env.TRUSTED_PROXY_HOPS; delete process.env.BEHIND_CLOUDFLARE; });

test('X-Edge-Auth matches -> CF-Connecting-IP trusted (v4 / v6, trimmed)', () => {
  assert.equal(clientIp(authed({ 'cf-connecting-ip': '203.0.113.9' })), '203.0.113.9');
  assert.equal(clientIp(authed({ 'cf-connecting-ip': ' 2001:db8::2 ' })), '2001:db8::2');
  assert.equal(clientIp(authed({ 'cf-connecting-ip': '::1' })), '::1');
  assert.deepEqual(resolveClientIp(authed({ 'cf-connecting-ip': '198.51.100.7' }).headers), { ip: '198.51.100.7', trusted: true });
});

test('X-Edge-Auth mismatch (same length, different length, prefix, case, padding) -> untrusted', () => {
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  const flipped = SECRET.slice(0, -1) + (SECRET.endsWith('Z') ? 'Y' : 'Z');
  for (const bad of [flipped, SECRET.slice(1), SECRET + 'x', SECRET.slice(0, 10), SECRET.toLowerCase(), `${SECRET} x`, 'x'.repeat(SECRET.length), '']) {
    assert.deepEqual(resolveClientIp(req({ 'x-edge-auth': bad, ...ip }).headers), { ip: null, trusted: false }, `len ${bad.length}`);
    assert.equal(clientIp(req({ 'x-edge-auth': bad, ...ip })), null);
  }
});

test('X-Edge-Auth absent -> untrusted; X-Real-IP / X-Forwarded-For never used', () => {
  assert.equal(clientIp(req({ 'cf-connecting-ip': '203.0.113.9' })), null);
  assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.5' })), null);
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 10.0.0.1' })), null);
  // 即使认证通过，也只看 CF-Connecting-IP
  assert.equal(clientIp(authed({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '6.6.6.6' })), null);
});

test('EDGE_AUTH_SECRET missing / empty / shorter than 32 bytes -> fail-closed even if header matches', () => {
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  delete process.env.EDGE_AUTH_SECRET;
  assert.equal(clientIp(req({ 'x-edge-auth': '', ...ip })), null);
  assert.equal(clientIp(req({ 'x-edge-auth': 'undefined', ...ip })), null);
  assert.equal(clientIp(authed(ip)), null);
  process.env.EDGE_AUTH_SECRET = '';
  assert.equal(clientIp(req({ 'x-edge-auth': '', ...ip })), null);
  const short = 's'.repeat(31);
  process.env.EDGE_AUTH_SECRET = short;
  assert.equal(clientIp(req({ 'x-edge-auth': short, ...ip })), null);
  process.env.EDGE_AUTH_SECRET = 's'.repeat(32);
  assert.equal(clientIp(req({ 'x-edge-auth': 's'.repeat(32), ...ip })), '203.0.113.9');
});

test('legacy BEHIND_CLOUDFLARE / TRUSTED_PROXY_HOPS no longer trust any header', () => {
  delete process.env.EDGE_AUTH_SECRET;
  process.env.BEHIND_CLOUDFLARE = '1';
  process.env.TRUSTED_PROXY_HOPS = '1';
  const err = console.error; console.error = () => {};
  try {
    assert.equal(clientIp(req({ 'cf-connecting-ip': '4.4.4.4' })), null);
    assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' })), null);
    assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.5' })), null);
  } finally { console.error = err; }
});

test('trusted request with invalid / forged CF-Connecting-IP -> untrusted (no fallback)', () => {
  for (const bad of ['evil<script>', '1.2.3.4, 5.6.7.8', '1.2.3.4:80', '256.1.1.1', '01.2.3.4', '[::1]', 'fe80::1%eth0', '::g', '', '   ', '9'.repeat(10_000), 'a'.repeat(10_000)]) {
    assert.equal(clientIp(authed({ 'cf-connecting-ip': bad, 'x-real-ip': '203.0.113.5' })), null, JSON.stringify(bad.slice(0, 20)));
  }
  assert.equal(clientIp(authed()), null);
});

test('untrusted requests all share ONE rate-limit subject', () => {
  assert.equal(UNTRUSTED, 'untrusted');
  assert.equal(rateLimitSubject(clientIp(req({ 'cf-connecting-ip': '1.1.1.1' }))), 'untrusted');
  assert.equal(rateLimitSubject(clientIp(req({ 'cf-connecting-ip': '2.2.2.2', 'x-edge-auth': 'nope' }))), 'untrusted');
  assert.equal(rateLimitSubject(clientIp(authed({ 'cf-connecting-ip': '3.3.3.3' }))), '3.3.3.3');
});

test('every rate-limited route uses rateLimitSubject (no per-route noip buckets, no raw header reads)', () => {
  const files = ['src/app/api/uploads/logo/route.ts', 'src/app/api/rum/route.ts', 'src/lib/server/admin-guard.ts', 'src/app/api/designs/route.ts',
    'src/app/api/designs/[id]/route.ts', 'src/app/api/designs/[id]/logo/route.ts', 'src/app/api/inquiries/route.ts', 'src/lib/server/admin/login.ts'];
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.match(src, /rateLimitSubject\(/, f);
    assert.doesNotMatch(src, /noip/, f);
    assert.doesNotMatch(src, /x-real-ip|x-forwarded-for|cf-connecting-ip|cf-ipcountry|x-vercel-ip-country/i, f);
  }
  const mw = readFileSync('src/middleware.ts', 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(mw, /resolveClientIp\(req\.headers/);
  assert.doesNotMatch(mw, /x-real-ip|x-forwarded-for|cf-connecting-ip/i);
});

test('cf-ipcountry only trusted with valid X-Edge-Auth', () => {
  assert.equal(trustedCountry(authed({ 'cf-ipcountry': 'ru' }).headers), 'RU');
  assert.equal(trustedCountry(authed({ 'cf-ipcountry': 'T1' }).headers), 'T1');
  assert.equal(trustedCountry(req({ 'cf-ipcountry': 'RU' }).headers), null);
  assert.equal(trustedCountry(req({ 'cf-ipcountry': 'RU', 'x-edge-auth': 'nope' }).headers), null);
  assert.equal(trustedCountry(authed({ 'cf-ipcountry': 'RUS<' }).headers), null);
});

test('constantTimeEqual: equal / unequal / different length / multibyte', () => {
  assert.ok(constantTimeEqual('abc', 'abc'));
  assert.ok(!constantTimeEqual('abc', 'abd'));
  assert.ok(!constantTimeEqual('abc', 'abcd'));
  assert.ok(!constantTimeEqual('', 'a'));
  assert.ok(constantTimeEqual('', ''));
  assert.ok(!constantTimeEqual('é', 'e\u0301')); // 按 UTF-8 字节比较
  assert.ok(constantTimeEqual('ключ', 'ключ'));
});

test('client-ip module stays edge-safe (no node: imports, no Buffer, no timingSafeEqual)', () => {
  const src = readFileSync('src/lib/edge/client-ip.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /from ['"](node:|crypto|net)/);
  assert.doesNotMatch(src, /\bBuffer\b|\brequire\(/);
});

test('X-Edge-Auth value and secret never logged or echoed', async () => {
  const seen: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => { seen.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  const wrong = 'WRONG-edge-value-should-never-appear-123456';
  const shortSecret = 'short-secret-value-77';
  try {
    // 头不对、头对、没配密钥、密钥太短、旧变量告警，每条路径都走一遍
    clientIp(req({ 'x-edge-auth': wrong, 'cf-connecting-ip': '203.0.113.9' }));
    clientIp(authed({ 'cf-connecting-ip': 'evil' }));
    clientIp(authed({ 'cf-connecting-ip': '203.0.113.9' }));
    edgeAuthOk(req({ 'x-edge-auth': wrong }).headers, process.env);
    process.env.EDGE_AUTH_SECRET = shortSecret;
    clientIp(req({ 'x-edge-auth': shortSecret }));
    process.env.BEHIND_CLOUDFLARE = '1';
    clientIp(req({ 'x-edge-auth': shortSecret }));
    process.env.EDGE_AUTH_SECRET = SECRET;
    // 真实路由：RUM 接口带错误的 X-Edge-Auth，响应头和响应体都不能出现这个值
    const { POST } = await import('../src/app/api/rum/route');
    for (const [v, body] of [[wrong, '{"bad":'], [SECRET, '{"bad":'], [wrong, '{"name":"LCP","value":1200,"id":"v1-1","path":"/en"}'], [SECRET, '{"name":"LCP","value":1200,"id":"v1-2","path":"/en"}']]) {
      const res = await POST(new Request('http://x/api/rum', { method: 'POST', headers: { 'x-edge-auth': v, 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' }, body }) as never);
      assert.ok([204, 400].includes(res.status), String(res.status));
      const text = await res.text();
      assert.ok(!text.includes(v));
      for (const [, hv] of res.headers) assert.ok(!hv.includes(v));
    }
  } finally { Object.assign(console, orig); }
  assert.ok(seen.length >= 1, 'expected at least the short-secret / legacy warnings to be logged');
  for (const line of seen) for (const v of [SECRET, wrong, shortSecret]) assert.ok(!line.includes(v), `leaked in log: ${line.slice(0, 80)}`);
});

test('isIP', () => {
  for (const ok of ['1.2.3.4', '255.255.255.255', '::1', '2001:db8::1']) assert.ok(isIP(ok), ok);
  for (const no of ['', '256.1.1.1', '1.2.3', 'abc', '::g', '1.2.3.4:80', 'a'.repeat(50)]) assert.ok(!isIP(no), no);
});

test('per-IP 429 carries integer Retry-After >= 1', async () => {
  const r = tooManyRequests(0.2, { reason: 'sample_ip_limit' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '1');
  assert.equal(tooManyRequests(30 * 86_400).headers.get('Retry-After'), String(30 * 86_400));
});

test('sample_recent 429 has no Retry-After / retryAfter (anti email probing)', async () => {
  const { sampleRecentResponse } = await import('../src/lib/server/sample');
  const r = sampleRecentResponse();
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), null);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await r.json(), { error: 'sample_recent' });
});

