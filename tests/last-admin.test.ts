import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotLastActiveAdmin, LastAdminError } from '../src/lib/server/admin/last-admin';

/** 模拟数据库：FOR UPDATE 用互斥锁表示，锁在事务结束时释放；读到的是提交后的最新状态 */
function fakeDb(users: { id: string; role: string; disabled: boolean }[]) {
  let lock: Promise<void> = Promise.resolve();
  const sqls: string[] = [];
  async function transaction<T>(fn: (tx: never) => Promise<T>) {
    let release!: () => void;
    let locked = false;
    const tx = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        sqls.push(strings.join('?'));
        if (!locked) { const prev = lock; lock = new Promise((r) => (release = r)); await prev; locked = true; }
        return users.filter((u) => u.role === 'ADMIN' && !u.disabled).map((u) => ({ id: u.id }));
      },
    };
    try { return await fn(tx as never); } finally { if (locked) release(); }
  }
  const disable = (id: string) => { users.find((u) => u.id === id)!.disabled = true; };
  return { transaction, disable, sqls };
}

test('only active ADMIN -> LastAdminError; uses FOR UPDATE', async () => {
  const db = fakeDb([{ id: 'a1', role: 'ADMIN', disabled: false }, { id: 'a2', role: 'ADMIN', disabled: true }, { id: 's1', role: 'SALES', disabled: false }]);
  await assert.rejects(db.transaction((tx) => assertNotLastActiveAdmin(tx, 'a1')), LastAdminError);
  assert.match(db.sqls[0], /FOR UPDATE/);
});

test('non-admin / already disabled / one of two admins -> ok', async () => {
  const db = fakeDb([{ id: 'a1', role: 'ADMIN', disabled: false }, { id: 'a2', role: 'ADMIN', disabled: false }, { id: 's1', role: 'SALES', disabled: false }, { id: 'a3', role: 'ADMIN', disabled: true }]);
  for (const id of ['s1', 'a3', 'a1']) await db.transaction((tx) => assertNotLastActiveAdmin(tx, id));
});

test('concurrent disable of the last two ADMINs: exactly one succeeds', async () => {
  const db = fakeDb([{ id: 'a1', role: 'ADMIN', disabled: false }, { id: 'a2', role: 'ADMIN', disabled: false }]);
  const run = (id: string) => db.transaction(async (tx) => {
    await assertNotLastActiveAdmin(tx, id);
    await new Promise((r) => setTimeout(r, 10)); // 写入前让出，给另一个事务机会
    db.disable(id);
  });
  const res = await Promise.allSettled([run('a1'), run('a2')]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  const rej = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rej.reason instanceof LastAdminError);
});
