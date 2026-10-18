// deploy-readiness：输出存储文件的接口共用响应头（file-response.ts），第二道防线。见 PR 正文安全审查清单第 1b 项。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storedFileHeaders, storedFileResponse, FILE_CSP, PRIVATE_NO_STORE } from '../src/lib/server/file-response';

const PRIV = { access: 'private' } as const;

test('Content-Type 只由存储 key（写入时检测的类型）决定，并在白名单内', () => {
  assert.equal(storedFileHeaders('logos/2026-10/abc.png', 'logo-abc', 5, PRIV)['Content-Type'], 'image/png');
  assert.equal(storedFileHeaders('models/m/poster.webp', 'm-poster', 5, PRIV)['Content-Type'], 'image/webp');
  assert.equal(storedFileHeaders('models/m/main.glb', 'm-glb', 5, PRIV)['Content-Type'], 'model/gltf-binary');
});

test('不认识的 / 非法 key → application/octet-stream + attachment，文件名不带扩展名', () => {
  for (const k of ['x.svg', 'x.html', '../x.png', 'x.png.exe', '', 'logos/x.PNG']) {
    const h = storedFileHeaders(k, 'id1', 1, PRIV);
    assert.equal(h['Content-Type'], 'application/octet-stream', k);
    assert.equal(h['Content-Disposition'], 'attachment; filename="id1"', k);
  }
});

test('一律 nosniff 和 CSP default-src none; sandbox', () => {
  for (const k of ['a.png', 'a.webp', 'a.glb', 'a.svg']) {
    const h = storedFileHeaders(k, 'id', 1, PRIV);
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Content-Security-Policy'], "default-src 'none'; sandbox");
  }
  assert.equal(FILE_CSP, "default-src 'none'; sandbox");
});

test('非图片 → attachment；图片 inline；文件名只用服务端 id，不合规的 id 换成 file', () => {
  assert.equal(storedFileHeaders('m/main.glb', 'mid-glb', 1, PRIV)['Content-Disposition'], 'attachment; filename="mid-glb.glb"');
  assert.equal(storedFileHeaders('l/a.png', 'logo-abc', 1, PRIV)['Content-Disposition'], 'inline; filename="logo-abc.png"');
  assert.equal(storedFileHeaders('l/a.png', 'evil"; x=".svg', 1, PRIV)['Content-Disposition'], 'inline; filename="file.png"');
});

test('私有文件 private, no-store；公开文件用调用方的缓存策略；Content-Length 正确', () => {
  assert.equal(storedFileHeaders('a.png', 'i', 7, PRIV)['Cache-Control'], PRIVATE_NO_STORE);
  assert.equal(PRIVATE_NO_STORE, 'private, no-store');
  const pub = storedFileHeaders('a.glb', 'i', 7, { access: 'public', cacheControl: 'public, max-age=300' });
  assert.equal(pub['Cache-Control'], 'public, max-age=300'); assert.equal(pub['Content-Length'], '7');
});

test('storedFileResponse：额外头不能覆盖安全头', async () => {
  const r = storedFileResponse(Buffer.from('abc'), 'a.png', 'i', PRIV, { 'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src *" });
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('content-security-policy'), FILE_CSP);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(await r.text(), 'abc');
});

test('4 个输出存储文件的接口都用 storedFileResponse，不再自己拼 Content-Type / 用数据库 mime；next.config 把它们排除出全站 CSP', () => {
  const routes: [string, RegExp][] = [
    ['src/app/api/admin/uploads/[id]/route.ts', /access: 'private'/], ['src/app/api/designs/[id]/logo/route.ts', /access: 'private'/],
    ['src/app/api/models/[id]/[variant]/route.ts', /access: 'public'/], ['src/app/api/admin/models/[id]/file/route.ts', /access: 'private'/],
  ];
  for (const [f, acc] of routes) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /storedFileResponse\(/, f); assert.match(src, acc, f);
    assert.doesNotMatch(src, /'Content-Type':|\.mime\b|new Response\(new Uint8Array/, f);
  }
  const cfg = readFileSync('next.config.ts', 'utf8');
  for (const s of ['/api/admin/uploads/:path*', '/api/admin/models/:id/file', '/api/designs/:id/logo', '/api/models/:id/:variant']) assert.ok(cfg.includes(`'${s}'`), s);
  // 排除规则与 4 个路径一致（用同一个正则模拟 path-to-regexp 的负向前瞻）
  const ex = new RegExp(`^/((?!${cfg.match(/FILE_ROUTE_EXCLUDE = '([^']+)'/)![1]}).*)$`);
  for (const p of ['/api/admin/uploads/abc', '/api/admin/models/m1/file', '/api/designs/d1/logo', '/api/models/m1/glb']) assert.ok(!ex.test(p), p);
  for (const p of ['/en', '/api/health', '/api/admin/models', '/api/designs/d1', '/api/models']) assert.ok(ex.test(p), p);
});

test('#323 fileRoute：401 / 403 / 404 / 429 / 500 响应也带 FILE_CSP + nosniff，状态码、正文和其他头不变；抛错 → 500 internal，不回显异常', async () => {
  const { fileRoute, withFileSecurityHeaders } = await import('../src/lib/server/file-response');
  const { NextResponse } = await import('next/server');
  const cases: [number, () => Response][] = [
    [401, () => NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })],
    [403, () => NextResponse.json({ error: 'forbidden' }, { status: 403 })],
    [404, () => new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Security-Policy': 'default-src *' } })],
    [429, () => NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '600' } })],
    [500, () => new Response('x', { status: 500 })],
  ];
  for (const [status, make] of cases) {
    const ref = make();
    const r = await fileRoute(async () => make())(new Request('http://x/'), {});
    assert.equal(r.status, status);
    assert.equal(r.headers.get('content-security-policy'), FILE_CSP, String(status));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', String(status));
    for (const k of ['cache-control', 'retry-after', 'content-type']) assert.equal(r.headers.get(k), ref.headers.get(k), `${status} ${k}`);
    assert.equal(await r.text(), await ref.text());
  }
  const orig = console.error; const logged: unknown[] = [];
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    const r = await fileRoute(async () => { throw new Error('db exploded SECRET-XYZ'); })(new Request('http://x/'), {});
    assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'internal' });
    assert.equal(r.headers.get('content-security-policy'), FILE_CSP); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), PRIVATE_NO_STORE);
    assert.equal(logged.length, 1);
  } finally { console.error = orig; }
  // 成功的文件响应经过包装后头不变
  const ok = await fileRoute(async () => storedFileResponse(Buffer.from('abc'), 'a.png', 'i', PRIV))(new Request('http://x/'), {});
  assert.equal(ok.headers.get('content-type'), 'image/png'); assert.equal(ok.headers.get('content-security-policy'), FILE_CSP); assert.equal(await ok.text(), 'abc');
  assert.equal(withFileSecurityHeaders(new Response(null, { status: 204 })).headers.get('content-security-policy'), FILE_CSP);
});

test('#323 4 个文件接口的 GET 都是 fileRoute(...) 包起来的', () => {
  for (const f of ['src/app/api/admin/uploads/[id]/route.ts', 'src/app/api/designs/[id]/logo/route.ts', 'src/app/api/models/[id]/[variant]/route.ts', 'src/app/api/admin/models/[id]/file/route.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /^export const GET = fileRoute\(async \(/m, f);
    assert.doesNotMatch(src, /export (async )?function GET/, f);
  }
});

test('#323 真实路由：公开模型 / 方案 logo 的 404 带 FILE_CSP + nosniff', async () => {
  const { GET: modelGET } = await import('../src/app/api/models/[id]/[variant]/route');
  const { GET: logoGET } = await import('../src/app/api/designs/[id]/logo/route');
  const rs = [
    await modelGET(new Request('http://x/api/models/BAD/glb'), { params: Promise.resolve({ id: 'BAD', variant: 'glb' }) }),
    await modelGET(new Request('http://x/api/models/x/zzz'), { params: Promise.resolve({ id: 'a'.repeat(25), variant: 'zzz' }) }),
    await logoGET(new Request('http://x/api/designs/!/logo'), { params: Promise.resolve({ id: '!' }) }),
  ];
  for (const r of rs) {
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('content-security-policy'), FILE_CSP);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
});
