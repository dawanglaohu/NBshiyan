import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { probeClientIp } from '../src/lib/server/probe';

const SECRET = 'x'.repeat(32);
const req = (h: Record<string, string>) => new Request('http://localhost/api/designs/abc', { method: 'HEAD', headers: h });
beforeEach(() => { process.env.MIDDLEWARE_PROBE_SECRET = SECRET; });

test('valid secret + valid IP -> trusted IP (v4 and v6)', () => {
  assert.equal(probeClientIp(req({ 'x-internal-probe': SECRET, 'x-probe-client-ip': '203.0.113.7' })), '203.0.113.7');
  assert.equal(probeClientIp(req({ 'x-internal-probe': SECRET, 'x-probe-client-ip': '2001:DB8::1' })), '2001:db8::1');
});

test('wrong / missing secret -> header ignored', () => {
  assert.equal(probeClientIp(req({ 'x-internal-probe': 'y'.repeat(32), 'x-probe-client-ip': '203.0.113.7' })), null);
  assert.equal(probeClientIp(req({ 'x-internal-probe': SECRET.slice(1), 'x-probe-client-ip': '203.0.113.7' })), null);
  assert.equal(probeClientIp(req({ 'x-probe-client-ip': '203.0.113.7' })), null);
});

test('invalid IP format -> null', () => {
  for (const ip of ['', 'evil', '1.2.3.4, 5.6.7.8', '999.1.1.1', 'a'.repeat(60)])
    assert.equal(probeClientIp(req({ 'x-internal-probe': SECRET, 'x-probe-client-ip': ip })), null, ip);
});

test('secret unset or shorter than 32 bytes -> ignored even if header matches', () => {
  delete process.env.MIDDLEWARE_PROBE_SECRET;
  assert.equal(probeClientIp(req({ 'x-internal-probe': '', 'x-probe-client-ip': '203.0.113.7' })), null);
  process.env.MIDDLEWARE_PROBE_SECRET = 'short-secret';
  assert.equal(probeClientIp(req({ 'x-internal-probe': 'short-secret', 'x-probe-client-ip': '203.0.113.7' })), null);
});
