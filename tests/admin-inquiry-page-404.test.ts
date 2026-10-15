import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import * as authStub from './fixtures/auth-stub';
import * as React from 'react';
(globalThis as { React?: unknown }).React = React; // tsx 用经典 JSX 转换

// 询盘详情页服务端按 inquiryScope 检查：SALES 看自己的 200；看别人的 / 未分配的 / 不存在的 → 页面 404；ADMIN 200
const authFile = path.resolve('src/auth.ts');
const m = new Module(authFile); m.filename = authFile; m.loaded = true; m.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = m;

const OWN = 'cminquiry00000000000001', OTHER = 'cminquiry00000000000002', UNASSIGNED = 'cminquiry00000000000003', MISSING = 'cminquiry00000000000099';
const rows: Record<string, { id: string; assigneeId: string | null }> = {
  [OWN]: { id: OWN, assigneeId: 's1' }, [OTHER]: { id: OTHER, assigneeId: 's2' }, [UNASSIGNED]: { id: UNASSIGNED, assigneeId: null },
};
const users: Record<string, Record<string, unknown>> = { a1: { id: 'a1', role: 'ADMIN' }, s1: { id: 's1', role: 'SALES' } };
for (const u of Object.values(users)) Object.assign(u, { disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 });
let lastSelect: unknown;
let dbCalls = 0;
const env = process.env as Record<string, string | undefined>;
env.NEXT_PUBLIC_ADMIN_API = 'http'; // 默认按真实接口跑，下面单独测 mock
const withEnv = async (api: string | undefined, node: string, fn: () => Promise<void>) => {
  const [a, n] = [env.NEXT_PUBLIC_ADMIN_API, env.NODE_ENV];
  if (api === undefined) delete env.NEXT_PUBLIC_ADMIN_API; else env.NEXT_PUBLIC_ADMIN_API = api;
  env.NODE_ENV = node;
  try { await fn(); } finally { env.NEXT_PUBLIC_ADMIN_API = a; env.NODE_ENV = n; }
};
(globalThis as { prisma?: unknown }).prisma = {
  user: { findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null },
  inquiry: {
    findFirst: async ({ where, select }: { where: { AND: Record<string, unknown>[] }; select: unknown }) => {
      lastSelect = select; dbCalls++;
      const id = where.AND[0].id as string; const r = rows[id];
      return r && where.AND.every((c) => Object.entries(c).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ? { id: r.id } : null;
    },
  },
};
const as = (uid: string) => { (globalThis as { __testSession?: unknown }).__testSession = { user: { id: uid }, sv: 1 }; };

let Page: (p: { params: Promise<{ id: string }> }) => Promise<unknown>;
before(async () => { Page = (await import('../src/app/admin/inquiries/[id]/page')).default; });

/** 页面状态：notFound() 抛出 digest 含 404 的错误 → 404，正常返回 → 200 */
async function status(id: string): Promise<number> {
  try { await Page({ params: Promise.resolve({ id }) }); return 200; }
  catch (e) { const d = String((e as { digest?: string }).digest ?? ''); if (d.includes('404')) return 404; throw e; }
}

test('SALES：自己的询盘 200', async () => { as('s1'); assert.equal(await status(OWN), 200); });
test('SALES：别人的询盘 404', async () => { as('s1'); assert.equal(await status(OTHER), 404); });
test('SALES：未分配的询盘 404', async () => { as('s1'); assert.equal(await status(UNASSIGNED), 404); });
test('SALES：不存在的询盘 404', async () => { as('s1'); assert.equal(await status(MISSING), 404); });
test('ADMIN：别人的 / 未分配的询盘 200', async () => {
  as('a1'); assert.equal(await status(OTHER), 200); assert.equal(await status(UNASSIGNED), 200);
});
test('服务端只查 id', async () => { as('s1'); await status(OWN); assert.deepEqual(lastSelect, { id: true }); });
test('mock 模式 + 非生产：跳过查库，直接渲染', async () => {
  as('s1'); await withEnv(undefined, 'development', async () => {
    dbCalls = 0; assert.equal(await status(OTHER), 200); assert.equal(dbCalls, 0);
  });
});
test('NODE_ENV=production：开关不是 http 也照常查库，范围外 404', async () => {
  as('s1'); await withEnv('mock', 'production', async () => {
    dbCalls = 0; assert.equal(await status(OTHER), 404); assert.equal(dbCalls, 1);
    assert.equal(await status(OWN), 200);
  });
});
