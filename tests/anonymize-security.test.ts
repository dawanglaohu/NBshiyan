import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { anonymizeInquiryOps, stripLogoKeys, findInquiryForReply, deleteLogoFiles } from '../src/lib/server/privacy';
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
    logoUpload: { deleteMany: rec('logoUpload.deleteMany') },
  };
  return { db, calls, get: (n: string) => calls.filter((c) => c[0] === n).map((c) => c[1]) };
}

test('anonymizeInquiryOps: notes body, attribution/trustReasons, replyToken, logo keys, trackingNo', async () => {
  const r = recDb([{ id: 'it1', config: { size: '10x10', logoKey: 'logos/2026-10/x.png', logoUploadId: 'abc', colors: { a: '#fff' } } }]);
  const ops = await anonymizeInquiryOps(r.db as never, ['i1', 'i2'], ['l1']);
  await Promise.all(ops);
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

function lockDb(locked: boolean) {
  const sql: string[] = [];
  const tx = { $queryRaw: async (s: TemplateStringsArray) => { const q = s.join('?'); sql.push(q); return q.includes('try_advisory') ? [{ locked }] : [{}]; } };
  return { db: { $transaction: async (fn: any) => fn(tx) }, sql };
}

test('6) cleanup lock: 409 when running, fn not called', async () => {
  const { db, sql } = lockDb(false);
  let ran = false;
  const r = await withCleanupLock(async () => { ran = true; return new Response('ok'); }, db as never);
  assert.equal(r.status, 409); assert.equal(ran, false);
  assert.equal(sql.length, 1); assert.match(sql[0], /pg_try_advisory_lock/);
});

test('6) cleanup lock: unlock in finally, even when fn throws', async () => {
  let { db, sql } = lockDb(true);
  assert.equal((await withCleanupLock(async () => new Response('ok'), db as never)).status, 200);
  assert.match(sql[1], /pg_advisory_unlock/);
  ({ db, sql } = lockDb(true));
  await assert.rejects(withCleanupLock(async () => { throw new Error('boom'); }, db as never));
  assert.match(sql[1], /pg_advisory_unlock/);
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
