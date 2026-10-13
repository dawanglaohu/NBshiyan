import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { anonymizeInquiriesTx, deleteCustomer, stripLogoKeys, findInquiryForReply, deleteLogoFiles } from '../src/lib/server/privacy';
import { disableUserTx } from '../src/lib/server/admin/accounts';
import { withCleanupLock } from '../src/lib/server/cleanup-lock';

/** 记录每个操作的参数（ops 被 $transaction 执行前就已构造，这里直接记录调用） */
function recDb(items: { id: string; config: unknown }[] = []) {
  const calls: [string, any][] = [];
  const rec = (n: string) => async (a: any) => { calls.push([n, a]); return { count: 0 }; };
  const db = {
    inquiry: { updateMany: rec('inquiry.updateMany'), update: rec('inquiry.update') },
    inquiryItem: { updateMany: rec('inquiryItem.updateMany'), update: rec('inquiryItem.update'), findMany: async () => items },
    inquiryMessage: { updateMany: rec('inquiryMessage.updateMany') },
    inquiryNote: { updateMany: rec('inquiryNote.updateMany') },
    sampleRequest: { updateMany: rec('sampleRequest.updateMany') },
    logoUpload: { deleteMany: rec('logoUpload.deleteMany'), findMany: async () => [{ id: 'l1', path: 'logos/2026-10/abcdefghijklmnop.png' }] },
  };
  return { db, calls, get: (n: string) => calls.filter((c) => c[0] === n).map((c) => c[1]) };
}

test('anonymizeInquiriesTx: notes body, attribution/trustReasons, replyToken, logo keys, trackingNo', async () => {
  const r = recDb([{ id: 'it1', config: { size: '10x10', logoKey: 'logos/2026-10/x.png', logoUploadId: 'abc', colors: { a: '#fff' } } }]);
  const logos = await anonymizeInquiriesTx(r.db as never, ['i1', 'i2']);
  assert.deepEqual(logos.map((l) => l.id), ['l1']);
  // 1) 内部备注
  assert.deepEqual(r.get('inquiryNote.updateMany')[0], { where: { inquiryId: { in: ['i1', 'i2'] } }, data: { body: '[deleted]' } });
  // 2) 归因、评分理由
  const inq = r.get('inquiry.updateMany')[0].data;
  assert.equal(inq.attribution, Prisma.DbNull); assert.equal(inq.trustReasons, Prisma.DbNull); assert.equal(inq.message, null); assert.ok(inq.anonymizedAt);
  // 3) 回信 token 每条换新的随机值
  const toks = r.get('inquiry.update');
  assert.deepEqual(toks.map((t) => t.where.id), ['i1', 'i2']);
  assert.ok(toks.every((t) => /^[A-Za-z0-9_-]{24}$/.test(t.data.replyToken)));
  assert.notEqual(toks[0].data.replyToken, toks[1].data.replyToken);
  // 4) 配置去掉 logo 键，物流单号清空
  assert.deepEqual(r.get('inquiryItem.update')[0], { where: { id: 'it1' }, data: { config: { size: '10x10', colors: { a: '#fff' } } } });
  assert.deepEqual(r.get('sampleRequest.updateMany')[0].data, { shippingAddress: Prisma.DbNull, normalizedEmail: null, trackingNo: null });
  assert.deepEqual(r.get('logoUpload.deleteMany')[0], { where: { id: { in: ['l1'] } } });
});

test('stripLogoKeys', () => {
  assert.deepEqual(stripLogoKeys({ LogoFile: 'x', logo: 'y', material: 'kraft' }), { material: 'kraft' });
  assert.equal(stripLogoKeys(null), Prisma.DbNull);
  assert.equal(stripLogoKeys(['a']), Prisma.DbNull);
});

test('3) reply lookup rejects anonymized inquiries and bad tokens', async () => {
  const seen: any[] = [];
  const db = { inquiry: { findFirst: async (a: any) => { seen.push(a.where); return null; } } };
  assert.equal(await findInquiryForReply(db as never, 'abcdefghijklmnopqrstuvwx'), null);
  assert.deepEqual(seen[0], { replyToken: 'abcdefghijklmnopqrstuvwx', anonymizedAt: null });
  assert.equal(await findInquiryForReply(db as never, '../x'), null);
  assert.equal(seen.length, 1);
});

test('5) disableUserTx: disabled + session bump + unassign; PATCH uses it on disable', async () => {
  const calls: any[] = [];
  const tx = { user: { update: async (a: any) => { calls.push(['user', a]); return {}; } }, inquiry: { updateMany: async (a: any) => { calls.push(['inq', a]); return {}; } } };
  await disableUserTx(tx as never, 'u1');
  assert.deepEqual(calls, [['user', { where: { id: 'u1' }, data: { disabled: true, sessionVersion: { increment: 1 } } }], ['inq', { where: { assigneeId: 'u1' }, data: { assigneeId: null } }]]);
  const src = await readFile(new URL('../src/app/api/admin/users/[id]/route.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(b\.disabled === true\) await disableUserTx\(tx, id\);/);
  assert.match(src, /bumpsSession\(rest\)/); // 停用不重复 +1
});

/** 模拟 Postgres 事务级 advisory lock：锁归属于事务，事务结束（正常返回或抛错）即释放 */
function lockDb() {
  const sql: string[] = [];
  let holder: object | null = null;
  const db = {
    $transaction: async (fn: any, opts: any) => {
      const me = {};
      const tx = { $queryRaw: async (s: TemplateStringsArray) => { const q = s.join('?'); sql.push(q); if (q.includes('try_advisory')) { if (holder && holder !== me) return [{ locked: false }]; holder = me; return [{ locked: true }]; } return [{}]; } };
      try { return await fn(tx); } finally { if (holder === me) holder = null; }
    },
  };
  return { db, sql, opts: null as any };
}

test('6) cleanup lock: xact lock, 409 cleanup_running while another run holds it, fn not called', async () => {
  const { db, sql } = lockDb();
  let release!: () => void;
  const first = withCleanupLock(() => new Promise<Response>((r) => { release = () => r(new Response('ok')); }), db as never);
  await new Promise((r) => setImmediate(r));
  let ran = false;
  const r = await withCleanupLock(async () => { ran = true; return new Response('ok'); }, db as never);
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'cleanup_running' }); assert.equal(ran, false);
  release(); assert.equal((await first).status, 200);
  assert.ok(sql.every((q) => /pg_try_advisory_xact_lock\(hashtext\(\?\)\)/.test(q)), 'only xact lock, no session lock / manual unlock');
});

test('6) cleanup lock: after fn throws, next call still acquires (released with the transaction)', async () => {
  const { db } = lockDb();
  await assert.rejects(withCleanupLock(async () => { throw new Error('boom'); }, db as never), /boom/);
  let ran = false;
  assert.equal((await withCleanupLock(async () => { ran = true; return new Response('ok'); }, db as never)).status, 200);
  assert.ok(ran);
});

test('6) cleanup lock source: no session lock or manual unlock; route maxDuration 300 > tx timeout 290s', async () => {
  const src = await readFile(new URL('../src/lib/server/cleanup-lock.ts', import.meta.url), 'utf8');
  assert.ok(!/pg_try_advisory_lock\(|pg_advisory_unlock/.test(src));
  assert.match(src, /LOCK_TX_TIMEOUT_MS = 290_000/);
  const route = await readFile(new URL('../src/app/api/admin/cron/cleanup-uploads/route.ts', import.meta.url), 'utf8');
  assert.match(route, /export const maxDuration = 300;/);
});

test('3) anonymize reads (logos, item configs, contact checks) happen only inside the transaction', async () => {
  const outside: string[] = [];
  const txCalls: string[] = [];
  const mk = (sink: string[]) => new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_u, op: string) => async (a: any) => {
    sink.push(`${model}.${op}`);
    if (model === 'inquiry' && op === 'findMany') return a?.select?.contactId && a.where?.contactId ? [] : [{ id: 'i1', contactId: 'c1' }];
    if (model === 'contact' && op === 'findMany') return [{ id: 'c1' }];
    if (model === 'logoUpload' && op === 'findMany') return [];
    if (op === 'findMany') return [];
    return { count: 1 };
  } }) });
  const tx = mk(txCalls);
  const base = mk(outside) as any;
  const db = new Proxy(base, { get: (t, k) => (k === '$transaction' ? async (fn: any) => fn(tx) : t[k]) });
  process.env.PRIVACY_HASH_SECRET ??= 's'.repeat(32);
  await deleteCustomer(db as never, 'a@acme.de', { delete: async () => {} } as never);
  const { anonymizeExpiredInquiries } = await import('../src/lib/server/retention-enforce');
  // 到期 cron：取候选 id 的那次 findMany 是批次游标，其余读取都必须在事务里
  await anonymizeExpiredInquiries(db as never, new Date(), 1, { delete: async () => {} } as never);
  assert.deepEqual(outside, ['inquiry.findMany'], 'only the batch id cursor is read outside tx');
  for (const r of ['logoUpload.findMany', 'inquiryItem.findMany', 'contact.findMany']) assert.ok(txCalls.includes(r), r);
});

test('6) lock covers dry run too (route order: auth → lock → dry run → steps)', async () => {
  const src = await readFile(new URL('../src/app/api/admin/cron/cleanup-uploads/route.ts', import.meta.url), 'utf8');
  const [a, l, d, s] = ['secretMatches(token', 'withCleanupLock(async', 'if (isRetentionDryRun())', 'const steps'].map((x) => src.indexOf(x));
  assert.ok(a > 0 && l > a && d > l && s > d);
});

test('7) logo file delete failure logs only errorSummary', async () => {
  const logs: unknown[][] = [];
  const orig = console.error; console.error = (...a: unknown[]) => { logs.push(a); };
  try {
    const e = Object.assign(new Error('secret path logos/2026-10/abcdefghijkl.png'), { name: 'S3Error', code: 'AccessDenied' });
    await deleteLogoFiles([{ path: 'logos/2026-10/abcdefghijklmnop.png' }], { delete: async () => { throw e; } } as never);
  } finally { console.error = orig; }
  assert.deepEqual(logs, [['[privacy] logo file delete failed', { 错误类型: 'S3Error', 错误码: 'AccessDenied' }]]);
});
