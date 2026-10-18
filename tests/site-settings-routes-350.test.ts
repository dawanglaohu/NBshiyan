import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import * as authStub from './fixtures/auth-stub';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit';

// #350 真实路由文件：'@/auth' 换成测试桩，prisma 换成内存对象；requireAdmin / assertSameOrigin / 限流都是真实实现
const authFile = path.resolve('src/auth.ts');
const m = new Module(authFile); m.filename = authFile; m.loaded = true; m.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = m;
// next/cache 换成记录调用的桩（Next 运行时外 revalidateTag 会抛 static generation store missing）
const revalidated: string[] = [];
const req = createRequire(path.resolve('src/lib/server/site-settings-admin-deps.ts'));
const cacheFile = req.resolve('next/cache');
const realCache = req('next/cache') as Record<string, unknown>;
const cm = new Module(cacheFile); cm.filename = cacheFile; cm.loaded = true;
cm.exports = { ...realCache, revalidateTag: (t: string) => { revalidated.push(`tag:${t}`); }, revalidatePath: (p: string) => { revalidated.push(`path:${p}`); } };
(req.cache as Record<string, unknown>)[cacheFile] = cm;

const users: Record<string, Record<string, unknown>> = {
  a1: { id: 'a1', name: 'Ryan', role: 'ADMIN', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 },
  s1: { id: 's1', name: 'Sales', role: 'SALES', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 },
  e1: { id: 'e1', name: 'Ed', role: 'EDITOR', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 },
};
let rows: Map<string, unknown>;
let audits: { action: string; meta: unknown }[];
const g = globalThis as { prisma?: unknown; __testSession?: unknown };
const siteSetting = {
  findMany: async ({ where }: { where: { key: { in: string[] } } }) => where.key.in.filter((k) => rows.has(k)).map((k) => ({ key: k, value: structuredClone(rows.get(k)) })),
  findUnique: async ({ where }: { where: { key: string } }) => (rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null),
  create: async ({ data }: { data: { key: string; value: unknown } }) => { rows.set(data.key, structuredClone(data.value)); },
  update: async ({ where, data }: { where: { key: string }; data: { value: unknown } }) => { rows.set(where.key, structuredClone(data.value)); },
};
const db = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null,
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.filter((i) => users[i]).map((i) => ({ id: i, name: users[i].name })),
  },
  auditLog: { create: async ({ data }: { data: { action: string; meta: unknown } }) => { audits.push({ action: data.action, meta: data.meta }); return {}; } },
  siteSetting,
  $transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({
    siteSetting,
    $queryRaw: async (_s: TemplateStringsArray, key: string) => (rows.has(key) ? [{ value: JSON.stringify(rows.get(key)) }] : []),
  }),
};
g.prisma = db;

type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let r: { list: { GET: H }; locale: { PUT: H }; enabled: { PUT: H } };
before(async () => {
  r = {
    list: await import('../src/app/api/admin/site-settings/about/route'),
    locale: await import('../src/app/api/admin/site-settings/about/[locale]/route'),
    enabled: await import('../src/app/api/admin/site-settings/about/enabled/route'),
  } as never;
});
beforeEach(() => {
  rows = new Map(); audits = []; revalidated.length = 0;
  setRateLimitStore(new MemoryStore());
  g.__testSession = { user: { id: 'a1' }, sv: 1 };
  process.env.APP_ENV = 'test';
});

const P = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const put = (url: string, body: unknown, origin: string | null = 'http://localhost') =>
  new Request(`http://localhost${url}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
const BODY = '<p>We make packaging in our own factory and check quality before shipping.</p>';
const content = { expectedVersion: 0, title: 'About', bodyHtml: BODY };

test('SALES / EDITOR 403、未登录 401：三个接口都拒绝，不写库', async () => {
  for (const [sess, status] of [[{ user: { id: 's1' }, sv: 1 }, 403], [{ user: { id: 'e1' }, sv: 1 }, 403], [null, 401]] as const) {
    g.__testSession = sess;
    assert.equal((await r.list.GET(new Request('http://localhost/api/admin/site-settings/about'), P())).status, status);
    assert.equal((await r.locale.PUT(put('/api/admin/site-settings/about/en', content), P({ locale: 'en' }))).status, status);
    assert.equal((await r.enabled.PUT(put('/api/admin/site-settings/about/enabled', { enabled: true }), P())).status, status);
  }
  assert.equal(rows.size, 0); assert.equal(audits.length, 0);
});

test('跨站 Origin / 缺 Origin：403 forbidden_origin，不写库', async () => {
  for (const origin of ['https://evil.example', null, 'null']) {
    const a = await r.locale.PUT(put('/api/admin/site-settings/about/en', content, origin), P({ locale: 'en' }));
    assert.equal(a.status, 403); assert.deepEqual(await a.json(), { error: 'forbidden_origin' });
    assert.equal((await r.enabled.PUT(put('/api/admin/site-settings/about/enabled', { enabled: true }, origin), P())).status, 403);
  }
  assert.equal(rows.size, 0);
});

test('ADMIN 完整流程：保存 → 409 → 开关 → GET；响应 no-store；审计只记字段名', async () => {
  const s1 = await r.locale.PUT(put('/api/admin/site-settings/about/en', content), P({ locale: 'en' }));
  assert.equal(s1.status, 200); assert.equal(s1.headers.get('cache-control'), 'no-store');
  assert.equal((await s1.json()).content.version, 1);
  const c = await r.locale.PUT(put('/api/admin/site-settings/about/en', { ...content, title: 'Changed' }), P({ locale: 'en' }));
  assert.equal(c.status, 409); assert.deepEqual(await c.json(), { error: 'version_conflict', currentVersion: 1 });
  assert.equal((await r.locale.PUT(put('/api/admin/site-settings/about/ja', content), P({ locale: 'ja' }))).status, 400);
  const e = await r.enabled.PUT(put('/api/admin/site-settings/about/enabled', { enabled: true }), P());
  assert.equal(e.status, 200);
  const g1 = await r.list.GET(new Request('http://localhost/api/admin/site-settings/about'), P());
  assert.equal(g1.headers.get('cache-control'), 'no-store');
  const body = await g1.json();
  assert.equal(body.enabled, true); assert.equal(body.locales.en.title, 'About'); assert.equal(body.locales.en.updatedByName, 'Ryan'); assert.equal(body.locales.ru, null);
  assert.deepEqual(audits.map((a) => a.action), ['site.about.update', 'site.about.visibility']);
  assert.ok(!JSON.stringify(audits).includes('own factory'));
  // 每次成功写入都刷新 site-settings 标签和 sitemap；409 / 400 不刷新
  assert.deepEqual(revalidated, ['tag:site-settings', 'path:/sitemap.xml', 'tag:site-settings', 'path:/sitemap.xml']);
});
