import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appOriginProblems, prodEnvProblems } from '../prod-env-check';
import { assertSameOrigin } from '../src/lib/server/admin-guard';

const SITE = 'https://geiom.com';
const env = (APP_ORIGIN: string | undefined, NEXT_PUBLIC_SITE_URL = SITE) => ({ APP_ORIGIN, NEXT_PUBLIC_SITE_URL });

test('APP_ORIGIN valid: bare https origin equal to SITE_URL origin (normalized with new URL().origin)', () => {
  for (const v of ['https://geiom.com', 'https://geiom.com/', 'https://GEIOM.com', 'https://Geiom.Com/', ' https://geiom.com ', 'https://geiom.com:443'])
    assert.deepEqual(appOriginProblems(env(v)), [], v);
  assert.deepEqual(appOriginProblems(env('https://geiom.com', 'https://GEIOM.COM/en')), []);
});

test('APP_ORIGIN missing / http / path / query / hash / userinfo / IP / localhost / mismatch -> one problem, names only', () => {
  const cases: Array<[string | undefined, RegExp]> = [
    [undefined, /未设置/], ['', /未设置/], ['   ', /未设置/],
    ['http://geiom.com', /https/], ['geiom.com', /有效|https/], ['javascript:alert(1)', /https/],
    ['https://geiom.com/en', /裸 origin/], ['https://geiom.com/?x=1', /裸 origin/], ['https://geiom.com?', /裸 origin/], ['https://geiom.com/#a', /裸 origin/],
    ['https://user:pw@geiom.com', /裸 origin/], ['https://user@geiom.com', /裸 origin/],
    ['https://203.0.113.5', /IP 或 localhost/], ['https://[::1]', /IP 或 localhost/], ['https://localhost', /IP 或 localhost/], ['https://app.localhost', /IP 或 localhost/],
    ['https://www.geiom.com', /一致/], ['https://geiom.com:8443', /一致/], ['https://evil.example', /一致/],
  ];
  for (const [v, re] of cases) {
    const p = appOriginProblems(env(v));
    assert.equal(p.length, 1, String(v));
    assert.match(p[0], /^APP_ORIGIN/);
    assert.match(p[0], re, String(v));
    if (v?.trim()) assert.ok(!p[0].includes(v.trim()), 'value must not be printed');
  }
});

test('APP_ORIGIN is checked at runtime only, not at build', () => {
  const base = { APP_ENV: 'production', NEXT_PUBLIC_ADMIN_API: 'http', NEXT_PUBLIC_SITE_URL: SITE, NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0x4AAAAAAArealSiteKey' };
  assert.deepEqual(prodEnvProblems(base, 'build'), []);
  assert.ok(prodEnvProblems(base, 'runtime').some((p) => p.startsWith('APP_ORIGIN')));
  assert.ok(!prodEnvProblems({ ...base, APP_ORIGIN: SITE }, 'runtime').some((p) => p.startsWith('APP_ORIGIN')));
});

const saved = process.env.APP_ORIGIN;
afterEach(() => { if (saved === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved; });
// standalone 下 req.url 是监听地址 http://0.0.0.0:3000
const post = (origin?: string) => new Request('http://0.0.0.0:3000/api/admin/x', { method: 'POST', headers: origin ? { origin } : {} });

test('assertSameOrigin (logic unchanged): with APP_ORIGIN=https://geiom.com, Origin https://geiom.com passes; other origins 403; own listen origin still allowed', async () => {
  process.env.APP_ORIGIN = 'https://geiom.com';
  assert.equal(assertSameOrigin(post('https://geiom.com')), null);
  const bad = assertSameOrigin(post('http://0.0.0.0:3000'));
  // 现有逻辑：请求自身的 origin（req.url，standalone 下是 http://0.0.0.0:3000）也在允许列表里；按要求不改逻辑，这里如实记录
  assert.equal(bad, null, 'request own origin is still allowed by the unchanged logic');
  for (const o of ['http://localhost:3000', 'https://evil.example', 'null', undefined]) assert.equal(assertSameOrigin(post(o))?.status, 403, String(o));
});

test('assertSameOrigin without APP_ORIGIN rejects the real browser Origin under standalone (why APP_ORIGIN is required)', () => {
  delete process.env.APP_ORIGIN;
  assert.equal(assertSameOrigin(post('https://geiom.com'))?.status, 403);
});

test('assertSameOrigin: Origin http://0.0.0.0:3000 is rejected when it is not the request own origin', () => {
  process.env.APP_ORIGIN = 'https://geiom.com';
  const r = new Request('http://localhost:3000/api/admin/x', { method: 'POST', headers: { origin: 'http://0.0.0.0:3000' } });
  assert.equal(assertSameOrigin(r)?.status, 403);
});
