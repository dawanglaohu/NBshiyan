import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { assertNotLastActiveAdmin } from '../src/lib/server/admin/last-admin'; // 后端提交提供，merge 前本测试无法运行

const isLast = (e: unknown) => e instanceof Error && (e.name === 'LastAdminError' || (e as { code?: unknown }).code === 'last_admin');

// 真实 Postgres 并发测试：在独立 schema 里建一张最小 "User" 表，不碰开发库里的数据。没有 DATABASE_URL 就跳过。
const base = process.env.DATABASE_URL;
const SCHEMA = `lastadmin_test_${process.pid}`;
const url = base?.startsWith('postgres') ? `${base}${base.includes('?') ? '&' : '?'}schema=${SCHEMA}` : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

after(async () => {
  if (!db) return;
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.$disconnect();
});

async function reset(admins: string[]) {
  await db!.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await db!.$executeRawUnsafe(`DROP TABLE IF EXISTS "${SCHEMA}"."User"`);
  await db!.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"."User" ("id" text PRIMARY KEY, "role" text NOT NULL, "disabled" boolean NOT NULL DEFAULT false)`);
  for (const id of admins) await db!.$executeRawUnsafe(`INSERT INTO "${SCHEMA}"."User" ("id","role") VALUES ($1,'ADMIN')`, id);
  await db!.$executeRawUnsafe(`INSERT INTO "${SCHEMA}"."User" ("id","role") VALUES ('s1','SALES')`);
}
const disable = (id: string, holdMs = 0) => db!.$transaction(async (tx) => {
  await assertNotLastActiveAdmin(tx, id);
  if (holdMs) await new Promise((r) => setTimeout(r, holdMs)); // 拉长窗口，确保两个事务真正重叠
  await tx.$executeRawUnsafe(`UPDATE "User" SET "disabled" = true WHERE "id" = $1`, id);
}, { timeout: 15_000 });
const activeAdmins = async () => Number((await db!.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${SCHEMA}"."User" WHERE "role"='ADMIN' AND NOT "disabled"`))[0].n);

test('single: last active admin cannot be removed; non-admin / other admin fine', { skip: !db && 'no DATABASE_URL' }, async () => {
  await reset(['a1']);
  await assert.rejects(disable('a1'), (e) => isLast(e));
  await disable('s1');
  await reset(['a1', 'a2']);
  await disable('a2');
  assert.equal(await activeAdmins(), 1);
  await assert.rejects(disable('a1'), (e) => isLast(e));
});

test('concurrent: two admins disabled in parallel → at most one succeeds', { skip: !db && 'no DATABASE_URL' }, async () => {
  for (let round = 0; round < 5; round++) {
    await reset(['a1', 'a2']);
    const res = await Promise.allSettled([disable('a1', 150), disable('a2', 150)]);
    const ok = res.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 1, `round ${round}`);
    const rej = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.ok(isLast(rej.reason), String(rej.reason));
    assert.equal(await activeAdmins(), 1);
  }
});
