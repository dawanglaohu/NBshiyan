import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { withCleanupLock } from '../src/lib/server/cleanup-lock';

// 真实 Postgres：事务级 advisory lock 在 fn 抛错后随事务回滚释放，下一次能拿到；并发时第二个返回 409。没有 DATABASE_URL 就跳过。
// advisory lock 是库级的，不建表，不碰任何数据。
const url = process.env.DATABASE_URL?.startsWith('postgres') ? process.env.DATABASE_URL : null;
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : null;
after(async () => { await db?.$disconnect(); });

test('db: after fn throws, a second call still acquires the lock', { skip: !db }, async () => {
  await assert.rejects(withCleanupLock(async () => { throw new Error('boom'); }, db as never), /boom/);
  let ran = false;
  const r = await withCleanupLock(async () => { ran = true; return new Response('ok'); }, db as never);
  assert.equal(r.status, 200); assert.ok(ran);
  const [{ n }] = await db!.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`;
  assert.equal(n, 0, 'no advisory lock left behind');
});

test('db: concurrent run gets 409 cleanup_running; lock free again afterwards', { skip: !db }, async () => {
  let release!: () => void;
  let started!: () => void;
  const isStarted = new Promise<void>((r) => { started = r; });
  const first = withCleanupLock(() => new Promise<Response>((r) => { started(); release = () => r(new Response('ok')); }), db as never);
  await isStarted;
  const second = await withCleanupLock(async () => new Response('should not run'), db as never);
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: 'cleanup_running' });
  release();
  assert.equal((await first).status, 200);
  assert.equal((await withCleanupLock(async () => new Response('ok'), db as never)).status, 200);
});
