// #339：全站安全响应头的关键值（CSP 白名单；HSTS 与 nginx v5 同值）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders } from '../security-headers';

const get = (k: string) => securityHeaders.find((h) => h.key === k)?.value ?? '';
const directive = (name: string) => get('Content-Security-Policy').split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '';

test('HSTS 与 nginx v5 同值：1 年，不含子域、不加 preload', () => {
  assert.equal(get('Strict-Transport-Security'), 'max-age=31536000');
});

test('CSP 放行 Cloudflare Insights beacon', () => {
  assert.ok(directive('script-src').split(' ').includes('https://static.cloudflareinsights.com'));
  assert.ok(directive('connect-src').split(' ').includes('https://cloudflareinsights.com'));
});

test('CSP 不含 tawk.to，也没有空指令或多余空格', () => {
  const csp = get('Content-Security-Policy');
  assert.equal(csp.toLowerCase().includes('tawk.to'), false);
  assert.equal(csp.includes('  '), false);
  for (const part of csp.split(';')) assert.notEqual(part.trim(), '');
});

test('CSP 不再放行 R2 公开域名和 Vercel Insights', () => {
  const csp = get('Content-Security-Policy');
  assert.ok(!csp.includes('r2.dev'));
  assert.ok(!csp.includes('vercel-insights'));
});

test('CSP 关键限制保持不变', () => {
  for (const d of ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) {
    assert.ok(get('Content-Security-Policy').includes(d), d);
  }
  assert.equal(get('X-Frame-Options'), 'DENY');
});

test('每个头只出现一次', () => {
  const keys = securityHeaders.map((h) => h.key.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
});
