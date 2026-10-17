import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('assertSameOrigin 非生产（本地 / CI）：与以前一样，APP_ORIGIN 和请求自身的 origin 都放行；其他 403', async () => {
  process.env.APP_ORIGIN = 'https://geiom.com';
  assert.equal(assertSameOrigin(post('https://geiom.com')), null);
  // 非生产：请求自身的 origin（req.url）仍在允许列表里（next dev / next start 在 localhost 上直接用）
  assert.equal(assertSameOrigin(post('http://0.0.0.0:3000')), null, 'non-prod: request own origin allowed');
  assert.equal(assertSameOrigin(post('http://0.0.0.0:3000'), { APP_ENV: 'preview', APP_ORIGIN: 'https://geiom.com' }), null);
  assert.equal(assertSameOrigin(new Request('http://localhost:3000/api/admin/x', { method: 'POST', headers: { origin: 'http://localhost:3000' } }), {}), null);
  for (const o of ['http://localhost:3000', 'https://evil.example', 'null', undefined]) assert.equal(assertSameOrigin(post(o))?.status, 403, String(o));
});

test('#323 assertSameOrigin 生产（APP_ENV=production）：只认 APP_ORIGIN；监听地址 origin 即使等于 req.url 也 403；缺 Origin 照旧 403', async () => {
  const PROD = { APP_ENV: 'production', NODE_ENV: 'production', APP_ORIGIN: 'https://geiom.com' };
  assert.equal(assertSameOrigin(post('https://geiom.com'), PROD), null);
  const bad = assertSameOrigin(post('http://0.0.0.0:3000'), PROD); // req.url 也是 http://0.0.0.0:3000
  assert.equal(bad?.status, 403); assert.deepEqual(await bad!.json(), { error: 'forbidden_origin' }); assert.equal(bad!.headers.get('cache-control'), 'no-store');
  for (const o of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://geiom.com', 'https://geiom.com:8443', 'https://www.geiom.com', 'https://geiom.com.evil.com', 'https://evil.example', 'null', '', undefined])
    assert.equal(assertSameOrigin(post(o), PROD)?.status, 403, String(o));
  // 请求 URL 就是正式域名时，正式域名照样放行（同一个 APP_ORIGIN），监听地址仍然拒绝
  const onSite = (o: string) => new Request('https://geiom.com/api/admin/x', { method: 'DELETE', headers: { origin: o } });
  assert.equal(assertSameOrigin(onSite('https://geiom.com'), PROD), null);
  assert.equal(assertSameOrigin(onSite('http://0.0.0.0:3000'), PROD)?.status, 403);
  // APP_ORIGIN 带末尾 / 时按 origin 规范化（与以前一样）
  assert.equal(assertSameOrigin(post('https://geiom.com'), { ...PROD, APP_ORIGIN: 'https://geiom.com/' }), null);
  // 生产缺 APP_ORIGIN 或无效：一律拒绝（不回落到请求自身的 origin）
  for (const a of [undefined, '', 'not a url']) {
    assert.equal(assertSameOrigin(post('http://0.0.0.0:3000'), { ...PROD, APP_ORIGIN: a })?.status, 403, String(a));
    assert.equal(assertSameOrigin(post('https://geiom.com'), { ...PROD, APP_ORIGIN: a })?.status, 403, String(a));
  }
  // VERCEL_ENV=production 同样按生产处理（isProdEnvFrom）
  assert.equal(assertSameOrigin(post('http://0.0.0.0:3000'), { VERCEL_ENV: 'production', APP_ORIGIN: 'https://geiom.com' })?.status, 403);
  // GET / HEAD / OPTIONS 不检查（与以前一样）
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(assertSameOrigin(new Request('http://0.0.0.0:3000/api/admin/x', { method: m }), PROD), null, m);
});

test('#323 assertSameOrigin 默认读 process.env：APP_ENV=production 时同样只认 APP_ORIGIN', () => {
  const savedEnv = process.env.APP_ENV;
  process.env.APP_ENV = 'production'; process.env.APP_ORIGIN = 'https://geiom.com';
  try {
    assert.equal(assertSameOrigin(post('https://geiom.com')), null);
    assert.equal(assertSameOrigin(post('http://0.0.0.0:3000'))?.status, 403);
  } finally { if (savedEnv === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = savedEnv; }
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

const PROD323 = { APP_ENV: 'production', NODE_ENV: 'production', APP_ORIGIN: 'https://geiom.com' };
const reqH = (method: string, headers: Record<string, string>) => new Request('http://0.0.0.0:3000/api/admin/x', { method, headers });

test('#323 审查 1：生产环境 Origin 必须与 APP_ORIGIN 完全相等（new URL(o).origin === o 且等于规范化后的 APP_ORIGIN），没有前缀 / 包含匹配', () => {
  for (const o of ['https://geiom.com.evil.com', 'https://geiom.com@evil.com', 'https://evil.com@geiom.com', 'https://geiom.com/', 'https://geiom.com/x', 'https://GEIOM.com',
    'https://geiom.com:443', 'https://geiom.co', 'https://xgeiom.com', 'https://sub.geiom.com', 'https://geiom.com#', 'geiom.com', 'https:geiom.com'])
    assert.equal(assertSameOrigin(reqH('POST', { origin: o }), PROD323)?.status, 403, o);
  assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://geiom.com' }), PROD323), null);
  // APP_ORIGIN 本身按 new URL().origin 规范化
  for (const a of ['https://geiom.com/', 'https://GEIOM.COM', 'https://geiom.com:443']) assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://geiom.com' }), { ...PROD323, APP_ORIGIN: a }), null, a);
  const src = readFileSync('src/lib/server/admin-guard.ts', 'utf8');
  const fn = src.slice(src.indexOf('function canonicalOrigin'), src.indexOf('export async function enforceAdminRateLimit')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(fn, /startsWith|endsWith|includes\(|\.test\(|\.match\(|referer/i);
});

test('#323 审查 2：生产环境 Origin: null → 403；无 Origin 只有 Sec-Fetch-Site: same-origin 放行；从不看 Referer；GET 不变', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(assertSameOrigin(reqH(m, { origin: 'null' }), PROD323)?.status, 403, `${m} null`);
    assert.equal(assertSameOrigin(reqH(m, { origin: 'null', 'sec-fetch-site': 'same-origin' }), PROD323)?.status, 403, `${m} null + sfs`);
    assert.equal(assertSameOrigin(reqH(m, {}), PROD323)?.status, 403, `${m} no origin`);
    for (const sfs of ['cross-site', 'same-site', 'none', 'SAME-ORIGIN', 'same-origin, cross-site', ''])
      assert.equal(assertSameOrigin(reqH(m, { 'sec-fetch-site': sfs }), PROD323)?.status, 403, `${m} sfs=${sfs}`);
    assert.equal(assertSameOrigin(reqH(m, { referer: 'https://geiom.com/admin' }), PROD323)?.status, 403, `${m} referer only`);
    assert.equal(assertSameOrigin(reqH(m, { 'sec-fetch-site': 'same-origin' }), PROD323), null, `${m} sfs same-origin`);
    // Origin 存在时以 Origin 为准，Sec-Fetch-Site 不能把错误的 Origin 救回来
    assert.equal(assertSameOrigin(reqH(m, { origin: 'http://0.0.0.0:3000', 'sec-fetch-site': 'same-origin' }), PROD323)?.status, 403, `${m} bad origin + sfs`);
  }
  // 生产缺 APP_ORIGIN：无 Origin + same-origin 也拒绝
  assert.equal(assertSameOrigin(reqH('POST', { 'sec-fetch-site': 'same-origin' }), { ...PROD323, APP_ORIGIN: undefined })?.status, 403);
  // GET / HEAD / OPTIONS 不检查（不变）
  for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(assertSameOrigin(reqH(m, {}), PROD323), null, m);
});

test('#323 审查 2：非生产行为不变：缺 Origin（含 Sec-Fetch-Site: same-origin）和 Origin: null 都 403；请求自身 origin 放行', () => {
  const DEV = { APP_ORIGIN: 'https://geiom.com' };
  assert.equal(assertSameOrigin(reqH('POST', {}), DEV)?.status, 403);
  assert.equal(assertSameOrigin(reqH('POST', { 'sec-fetch-site': 'same-origin' }), DEV)?.status, 403);
  assert.equal(assertSameOrigin(reqH('POST', { origin: 'null' }), DEV)?.status, 403);
  assert.equal(assertSameOrigin(reqH('POST', { origin: 'http://0.0.0.0:3000' }), DEV), null);
  assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://geiom.com' }), DEV), null);
  assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://geiom.com.evil.com' }), DEV)?.status, 403);
});

test('#323 审查 3：APP_ORIGIN 每次调用时从 env 读取（改 env 立刻生效，没有缓存、不内联）', () => {
  const saved = { APP_ENV: process.env.APP_ENV, APP_ORIGIN: process.env.APP_ORIGIN };
  try {
    process.env.APP_ENV = 'production';
    process.env.APP_ORIGIN = 'https://a.example';
    assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://a.example' })), null);
    assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://b.example' }))?.status, 403);
    process.env.APP_ORIGIN = 'https://b.example';
    assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://b.example' })), null);
    assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://a.example' }))?.status, 403);
    delete process.env.APP_ORIGIN;
    assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://b.example' }))?.status, 403);
    // 显式传入的 env 同样逐次生效
    const env: Record<string, string | undefined> = { APP_ENV: 'production', APP_ORIGIN: 'https://a.example' };
    assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://a.example' }), env), null);
    env.APP_ORIGIN = 'https://c.example';
    assert.equal(assertSameOrigin(reqH('POST', { origin: 'https://a.example' }), env)?.status, 403);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // 源码：读的是 env.APP_ORIGIN（env 默认 process.env），next.config 的 env 里没有 APP_ORIGIN（不会被内联）
  assert.match(readFileSync('src/lib/server/admin-guard.ts', 'utf8'), /env: Record<string, string \| undefined> = process\.env\)/);
  assert.doesNotMatch(readFileSync('next.config.ts', 'utf8'), /APP_ORIGIN/);
});
