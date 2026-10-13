import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, isIP, tooManyRequests } from '../src/lib/server/security';

const req = (h: Record<string, string>) => new Request('http://x/', { headers: h });
afterEach(() => { delete process.env.TRUSTED_PROXY_HOPS; delete process.env.BEHIND_CLOUDFLARE; });

test('default (no TRUSTED_PROXY_HOPS) identical to old behaviour', () => {
  assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.5' })), '203.0.113.5');
  assert.equal(clientIp(req({ 'x-real-ip': 'raw-unchanged' })), 'raw-unchanged');
  assert.equal(clientIp(req({})), null);
});

test('x-forwarded-for untrusted by default (spoofable)', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 10.0.0.1' })), null);
});

test('TRUSTED_PROXY_HOPS picks Nth from right, ignores client-forged left entries', () => {
  process.env.TRUSTED_PROXY_HOPS = '1';
  assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7' })), '198.51.100.7');
  process.env.TRUSTED_PROXY_HOPS = '2';
  assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.1' })), '198.51.100.7');
  assert.equal(clientIp(req({ 'x-forwarded-for': '10.0.0.1' })), null); // 层数不够
  assert.equal(clientIp(req({ 'x-forwarded-for': 'junk, 10.0.0.1' })), null); // 非法 IP
  for (const bad of ['0', '-1', 'abc', '1.5', '99']) {
    process.env.TRUSTED_PROXY_HOPS = bad;
    assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })), null, bad);
  }
});

test('x-real-ip wins over XFF; cf-connecting-ip only when BEHIND_CLOUDFLARE=1', () => {
  process.env.TRUSTED_PROXY_HOPS = '1';
  assert.equal(clientIp(req({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '2.2.2.2' })), '203.0.113.5');
  assert.equal(clientIp(req({ 'cf-connecting-ip': '4.4.4.4' })), null);
  process.env.BEHIND_CLOUDFLARE = '1';
  assert.equal(clientIp(req({ 'cf-connecting-ip': '4.4.4.4', 'x-real-ip': '203.0.113.5' })), '4.4.4.4');
});

test('BEHIND_CLOUDFLARE + TRUSTED_PROXY_HOPS: hops ignored, Cloudflare wins', () => {
  process.env.BEHIND_CLOUDFLARE = '1';
  process.env.TRUSTED_PROXY_HOPS = '1';
  assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6' })), null);
  assert.equal(clientIp(req({ 'cf-connecting-ip': '4.4.4.4', 'x-forwarded-for': '6.6.6.6' })), '4.4.4.4');
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
