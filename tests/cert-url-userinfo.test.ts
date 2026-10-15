import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Certification, isHttpsUrl as serverIs, normalizeUrlSchemeHost as serverNorm } from '../src/lib/server/specs';
import { isHttpsUrl, normalizeUrlSchemeHost, hasUserinfo, toBody, emptyForm, newCertRow } from '../src/lib/admin/spec-form';

// #251：证书链接拒绝任何 userinfo
const USERINFO = [
  'https://user:pass@example.com/cert.pdf',
  'https://user@example.com/cert.pdf',
  'https://:@example.com/',
  'https://:pass@example.com/',
  'https://user:@example.com/',
  'https://@example.com/',
  'HTTPS://User:PW@Example.COM/X',
  'https://user%40evil.com:pw@example.com/',
  'https://us%65r@example.com/',
  'https://a%40b@example.com/',
  'https://example.com%40evil.com/',
  'https://trusted.com@evil.com/',
  'https://user@evil.com@example.com/',
  'https:user@example.com/',
  'https:/user@example.com/',
  'https:\\\\user@example.com/',
  'https://us\ter@example.com/',
  ' https://user@example.com/ ',
];

test('server schema rejects every userinfo form', () => {
  for (const url of USERINFO) assert.equal(Certification.safeParse({ name: 'FSC', url }).success, false, url);
});

test('shared validator rejects every userinfo form (admin form and server use the same function)', () => {
  assert.equal(serverIs, isHttpsUrl);
  assert.equal(serverNorm, normalizeUrlSchemeHost);
  for (const u of USERINFO) {
    assert.equal(hasUserinfo(u), true, u);
    assert.equal(isHttpsUrl(normalizeUrlSchemeHost(u.trim())), false, u);
  }
});

test('admin form toBody flags userinfo urls', () => {
  const f = emptyForm();
  f.certifications = [{ ...newCertRow(), name: 'FSC', url: 'https://user:pw@example.com/c.pdf' }];
  const r = toBody(f) as { errors?: Record<string, string> };
  assert.ok(r.errors?.['certifications.0.url'], JSON.stringify(r));
});

test('normal https urls still accepted; path/query/hash preserved; @ outside authority is fine', () => {
  const ok: [string, string][] = [
    ['https://example.com/cert.pdf', 'https://example.com/cert.pdf'],
    ['HTTPS://Cert.EXAMPLE.com:8443/Path/File.PDF?Id=AbC&x=1#Frag', 'https://cert.example.com:8443/Path/File.PDF?Id=AbC&x=1#Frag'],
    ['https://example.com/a@b/c?mail=x@y.com#u@v', 'https://example.com/a@b/c?mail=x@y.com#u@v'],
    ['https://example.com/p%40th?q=%40', 'https://example.com/p%40th?q=%40'],
    ['https://example.com', 'https://example.com'],
  ];
  for (const [inp, out] of ok) {
    assert.equal(hasUserinfo(inp), false, inp);
    const r = Certification.safeParse({ name: 'FSC', url: inp });
    assert.ok(r.success, inp);
    assert.equal(r.data.url, out);
  }
});

test('non-https still rejected', () => {
  for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', 'ftp://example.com']) assert.equal(Certification.safeParse({ name: 'x', url }).success, false, url);
});

test('single shared implementation: server re-exports from spec-form, no duplicate', () => {
  const src = readFileSync('src/lib/server/specs.ts', 'utf8');
  assert.doesNotMatch(src, /function isHttpsUrl|function normalizeUrlSchemeHost/);
});
