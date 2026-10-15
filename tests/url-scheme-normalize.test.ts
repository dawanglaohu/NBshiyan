import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Certification, SpecInput, isHttpsUrl, normalizeUrlSchemeHost } from '../src/lib/server/specs';
import { normalizeUrlSchemeHost as clientNorm, toBody, emptyForm, newCertRow } from '../src/lib/admin/spec-form';

// Refs #239：证书链接大写协议/主机名应规范为小写，路径保持不变
const parseUrl = (url: string) => Certification.safeParse({ name: 'FSC', url });

test('uppercase scheme is normalized to lowercase', () => {
  const r = parseUrl('HTTPS://example.com/Cert/ABC.pdf');
  assert.ok(r.success);
  assert.equal(r.data.url, 'https://example.com/Cert/ABC.pdf');
});

test('mixed-case host is lowercased, path/query/fragment unchanged', () => {
  const r = parseUrl('  HtTpS://Cert.EXAMPLE.Com:8443/Path/To/File.PDF?Id=AbC#Frag ');
  assert.ok(r.success);
  assert.equal(r.data.url, 'https://cert.example.com:8443/Path/To/File.PDF?Id=AbC#Frag');
  assert.equal(normalizeUrlSchemeHost('https://User:PW@Host.COM/X'), 'https://User:PW@host.com/X');
});

test('non-https schemes still rejected (incl. uppercase variants)', () => {
  for (const u of ['HTTP://example.com/a', 'http://example.com', 'JAVASCRIPT:alert(1)', 'javascript://x/%0aalert(1)', 'DATA:text/html,x', 'FTP://example.com/a', 'example.com/a', '']) {
    if (u === '') continue;
    const r = parseUrl(u);
    assert.equal(r.success, false, u);
  }
});

test('existing behavior unchanged for already-lowercase https urls', () => {
  const u = 'https://example.com/a/B%20c?x=1';
  const r = parseUrl(u);
  assert.ok(r.success);
  assert.equal(r.data.url, u);
  assert.equal(isHttpsUrl(u), true);
  assert.equal(parseUrl('https://' + 'a'.repeat(2048)).success, false);
  assert.equal(Certification.safeParse({ name: 'FSC' }).success, false);
  assert.ok(Certification.safeParse({ name: 'FSC', certNo: 'X-1' }).success);
});

test('client form normalizes identically before submit', () => {
  assert.equal(clientNorm('HTTPS://Example.COM/P'), normalizeUrlSchemeHost('HTTPS://Example.COM/P'));
  const f = emptyForm();
  f.certifications = [newCertRow({ name: 'FSC', url: 'HTTPS://Example.COM/P' })];
  const out = toBody(f);
  assert.deepEqual(out.errors, {});
  const certs = out.body?.certifications as { url?: string }[];
  assert.equal(certs[0].url, 'https://example.com/P');
});

test('SpecInput passes normalized url through', () => {
  const r = SpecInput.safeParse({ certifications: [{ name: 'ISO', url: 'HTTPS://ISO.ORG/x' }] });
  assert.ok(r.success);
  assert.equal(r.data.certifications?.[0].url, 'https://iso.org/x');
});
