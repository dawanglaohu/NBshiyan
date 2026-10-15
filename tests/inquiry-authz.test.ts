import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import * as authStub from './fixtures/auth-stub';

// #225：SALES 只能访问分配给自己的询盘（详情 / history 对他人询盘返回 404，不暴露是否存在）；改派负责人仅 ADMIN（SALES 403）
// 用 require.cache 预置 src/auth.ts（next-auth 依赖请求上下文，测试里替换为桩）
const authFile = path.resolve('src/auth.ts');
const m = new Module(authFile); m.filename = authFile; m.loaded = true; m.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = m;

const INQ = 'cminquiry00000000000001';
const users: Record<string, Record<string, unknown>> = {
  a1: { id: 'a1', role: 'ADMIN' }, s1: { id: 's1', role: 'SALES' }, s2: { id: 's2', role: 'SALES' },
};
for (const u of Object.values(users)) Object.assign(u, { disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 });
const inquiry = { id: INQ, assigneeId: 's1', replyToken: 'secret', createdAt: new Date('2026-01-01'), source: 'web', sample: null,
  contact: null, items: [], messages: [], notes: [], assignee: null, logoUploads: [], status: 'NEW' };

// 按 where 真实过滤：{ AND: [{ id }, inquiryScope(user)] }
function matches(where: { AND?: Record<string, unknown>[] }) {
  return (where.AND ?? []).every((c) => Object.entries(c).every(([k, v]) => (inquiry as Record<string, unknown>)[k] === v));
}
let updates = 0;
(globalThis as { prisma?: unknown }).prisma = {
  user: { findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null, findMany: async () => [] },
  inquiry: {
    findFirst: async ({ where }: { where: { AND?: Record<string, unknown>[] } }) => (matches(where) ? inquiry : null),
    update: async () => { updates++; return { id: INQ, status: 'NEW', assigneeId: 's1', updatedAt: new Date() }; },
    updateMany: async () => { updates++; return { count: 1 }; },
  },
  auditLog: { create: async () => ({}), findMany: async () => [] },
};
const as = (uid: string | null) => { (globalThis as { __testSession?: unknown }).__testSession = uid ? { user: { id: uid }, sv: 1 } : null; };

type H = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let detail: { GET: H; PATCH: H }; let history: { GET: H };
before(async () => {
  detail = await import('../src/app/api/admin/inquiries/[id]/route');
  history = await import('../src/app/api/admin/inquiries/[id]/history/route');
});
const P = { params: Promise.resolve({ id: INQ }) };
const get = (path = '') => new Request(`http://localhost/api/admin/inquiries/${INQ}${path}`);
const patch = (body: unknown) => new Request(`http://localhost/api/admin/inquiries/${INQ}`, {
  method: 'PATCH', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('未登录：详情 / history 401', async () => {
  as(null);
  assert.equal((await detail.GET(get(), P)).status, 401);
  assert.equal((await history.GET(get('/history'), P)).status, 401);
});

test('SALES 访问未分配给自己的询盘：详情 404、history 404（与不存在一致）', async () => {
  as('s2');
  const d = await detail.GET(get(), P);
  assert.equal(d.status, 404); assert.deepEqual(await d.json(), { error: 'not_found' });
  const h = await history.GET(get('/history'), P);
  assert.equal(h.status, 404); assert.deepEqual(await h.json(), { error: 'not_found' });
});

test('SALES 访问自己的询盘：详情 200、history 200；replyToken 不下发', async () => {
  as('s1');
  const d = await detail.GET(get(), P);
  assert.equal(d.status, 200);
  const body = await d.json(); assert.equal(body.id, INQ); assert.equal(body.replyToken, undefined);
  assert.equal((await history.GET(get('/history'), P)).status, 200);
});

test('ADMIN 访问任意询盘：详情 200、history 200', async () => {
  as('a1');
  assert.equal((await detail.GET(get(), P)).status, 200);
  assert.equal((await history.GET(get('/history'), P)).status, 200);
});

test('SALES 改派负责人 → 403，且不写库（自己的询盘也一样）', async () => {
  updates = 0;
  as('s1');
  const r = await detail.PATCH(patch({ assigneeId: 's2xxxxxxxxxxxxxxxxxxxx' }), P);
  assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'forbidden' });
  const r2 = await detail.PATCH(patch({ assigneeId: null }), P);
  assert.equal(r2.status, 403);
  assert.equal(updates, 0);
});
