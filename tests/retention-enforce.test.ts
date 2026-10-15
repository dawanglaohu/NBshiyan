import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { anonymizeExpiredInquiries, disableInactiveUsers } from '../src/lib/server/retention-enforce';

const NOW = new Date('2026-10-13T00:00:00Z');
const DAY = 86_400_000;
afterEach(() => { delete process.env.ADMIN_INACTIVE_DAYS; });

type Inq = { id: string; contactId: string; retainUntil: Date; anonymizedAt: Date | null; message: string | null };
function inquiryDb(inqs: Inq[], logos: { id: string; path: string; inquiryId: string }[]) {
  const contacts: Record<string, { name: string }> = { c1: { name: 'Anna' }, c2: { name: 'Boris' } };
  const ops: string[] = [];
  const audits: any[] = [];
  const db = {
    auditLog: { create: async (a: any) => { audits.push(a.data); return {}; } },
    inquiry: {
      findMany: async (a: any) => {
        const w = a.where;
        let r = inqs.filter((i) => (w.anonymizedAt === null ? i.anonymizedAt === null : true));
        if (w.retainUntil) r = r.filter((i) => i.retainUntil < w.retainUntil.lt);
        if (w.id?.in) r = r.filter((i) => w.id.in.includes(i.id));
        if (w.id?.notIn) r = r.filter((i) => !w.id.notIn.includes(i.id));
        if (w.contactId?.in) r = r.filter((i) => w.contactId.in.includes(i.contactId));
        return r.slice(0, a.take ?? 1e9);
      },
      update: async () => ({}),
      updateMany: async (a: any) => { let n = 0; for (const i of inqs) if (a.where.id.in.includes(i.id)) { i.message = a.data.message; i.anonymizedAt = a.data.anonymizedAt; n++; } ops.push('inquiry'); return { count: n }; },
    },
    contact: { update: async (a: any) => { contacts[a.where.id].name = a.data.name; return {}; } },
    inquiryItem: { updateMany: async () => ({ count: 0 }), findMany: async () => [], update: async () => ({}) },
    inquiryNote: { updateMany: async () => ({ count: 0 }) },
    inquiryMessage: { updateMany: async () => ({ count: 0 }) },
    sampleRequest: { updateMany: async () => ({ count: 0 }) },
    logoUpload: {
      findMany: async (a: any) => logos.filter((l) => a.where.inquiryId.in.includes(l.inquiryId)).map(({ id, path }) => ({ id, path })),
      deleteMany: async (a: any) => { const before = logos.length; for (const id of a.where.id.in) logos.splice(logos.findIndex((l) => l.id === id), 1); return { count: before - logos.length }; },
    },
    async $transaction(x: any) { return typeof x === 'function' ? x(this) : Promise.all(x); },
  };
  return { db, contacts, ops, audits };
}

test('expired inquiries anonymized once, bound logos deleted (row + file), contact kept while it has a live inquiry', async () => {
  const inqs: Inq[] = [
    { id: 'i1', contactId: 'c1', retainUntil: new Date(NOW.getTime() - DAY), anonymizedAt: null, message: 'secret' },
    { id: 'i2', contactId: 'c2', retainUntil: new Date(NOW.getTime() - DAY), anonymizedAt: null, message: 'x' },
    { id: 'i3', contactId: 'c2', retainUntil: new Date(NOW.getTime() + DAY), anonymizedAt: null, message: 'live' },
  ];
  const logos = [{ id: 'l1', path: 'logos/2026-10/abcdefghijklmnop.png', inquiryId: 'i1' }, { id: 'l3', path: 'logos/2026-10/qrstuvwxyzabcdef.png', inquiryId: 'i3' }];
  const files: string[] = [];
  const storage = { delete: async (k: string) => { files.push(k); } } as never;
  const { db, contacts } = inquiryDb(inqs, logos);
  assert.equal(await anonymizeExpiredInquiries(db as never, NOW, 20_000, storage), 2);
  assert.equal(inqs[0].message, null); assert.ok(inqs[0].anonymizedAt);
  assert.equal(inqs[2].message, 'live'); assert.equal(inqs[2].anonymizedAt, null);
  assert.equal(contacts.c1.name, '[deleted]');
  assert.equal(contacts.c2.name, 'Boris'); // 还有未到期的询盘
  assert.deepEqual(logos.map((l) => l.id), ['l3']);
  assert.deepEqual(files, ['logos/2026-10/abcdefghijklmnop.png']);
  // 幂等：再跑一次不处理任何询盘
  assert.equal(await anonymizeExpiredInquiries(db as never, NOW, 20_000, storage), 0);
});

test('batches of 500 and per-run cap respected', async () => {
  const inqs: Inq[] = Array.from({ length: 1200 }, (_, k) => ({ id: `i${k}`, contactId: 'c1', retainUntil: new Date(0), anonymizedAt: null, message: 'm' }));
  const { db, ops } = inquiryDb(inqs, []);
  assert.equal(await anonymizeExpiredInquiries(db as never, NOW, 1000, { delete: async () => {} } as never), 1000);
  assert.equal(ops.length, 2); // 2 批 × 500
  assert.equal(await anonymizeExpiredInquiries(db as never, NOW, 20_000, { delete: async () => {} } as never), 200);
});

type U = { id: string; role: string; disabled: boolean; createdAt: Date; lastLoginAt: Date | null; reactivatedAt: Date | null; sessionVersion: number };
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
function userDb(users: U[]) {
  const unassigned: string[] = [];
  const inactive = (u: U, cutoff: Date) => !u.disabled && u.createdAt < cutoff && (!u.lastLoginAt || u.lastLoginAt < cutoff) && (!u.reactivatedAt || u.reactivatedAt < cutoff);
  let cutoff = new Date(0);
  const tx = {
    $queryRaw: async () => users.filter((u) => u.role === 'ADMIN' && !u.disabled).map((u) => ({ id: u.id })),
    user: {
      findFirst: async (a: any) => users.find((u) => u.id === a.where.id && inactive(u, cutoff)) ?? null,
      update: async (a: any) => { const u = users.find((x) => x.id === a.where.id)!; u.disabled = a.data.disabled; u.sessionVersion += a.data.sessionVersion.increment; return u; },
    },
    inquiry: { updateMany: async (a: any) => { unassigned.push(a.where.assigneeId); return { count: 0 }; } },
  };
  const db = {
    user: { findMany: async (a: any) => { cutoff = a.where.createdAt.lt; const skip: string[] = a.where.id?.notIn ?? []; return users.filter((u) => inactive(u, cutoff) && !skip.includes(u.id)).slice(0, a.take).map((u) => ({ id: u.id })); } },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { db, unassigned };
}

test('inactive users disabled (not deleted), sessions revoked, inquiries unassigned, audited as system; last ADMIN kept', async () => {
  const users: U[] = [
    { id: 'old-admin', role: 'ADMIN', disabled: false, createdAt: ago(400), lastLoginAt: ago(100), reactivatedAt: null, sessionVersion: 0 }, // 唯一有效 ADMIN
    { id: 'never', role: 'SALES', disabled: false, createdAt: ago(91), lastLoginAt: null, reactivatedAt: null, sessionVersion: 2 }, // 从未登录，按 createdAt
    { id: 'new', role: 'SALES', disabled: false, createdAt: ago(30), lastLoginAt: null, reactivatedAt: null, sessionVersion: 0 },
    { id: 'active', role: 'EDITOR', disabled: false, createdAt: ago(400), lastLoginAt: ago(5), reactivatedAt: null, sessionVersion: 0 },
    { id: 'reenabled', role: 'SALES', disabled: false, createdAt: ago(400), lastLoginAt: ago(200), reactivatedAt: ago(3), sessionVersion: 0 },
  ];
  const { db, unassigned } = userDb(users);
  const audits: any[] = [];
  assert.equal(await disableInactiveUsers(db as never, async (e) => { audits.push(e); }, NOW), 1);
  const by = Object.fromEntries(users.map((u) => [u.id, u]));
  assert.equal(by.never.disabled, true); assert.equal(by.never.sessionVersion, 3);
  assert.deepEqual(unassigned, ['never']);
  for (const id of ['old-admin', 'new', 'active', 'reenabled']) assert.equal(by[id].disabled, false, id);
  assert.deepEqual(audits, [{ actorId: 'system', action: 'user.disable_inactive', target: 'never', meta: { inactiveDays: 90 } }]);
  assert.equal(users.length, 5); // 不删除
});

test('ADMIN_INACTIVE_DAYS override; second inactive ADMIN disabled when another active ADMIN remains', async () => {
  process.env.ADMIN_INACTIVE_DAYS = '30';
  const users: U[] = [
    { id: 'a1', role: 'ADMIN', disabled: false, createdAt: ago(400), lastLoginAt: ago(1), reactivatedAt: null, sessionVersion: 0 },
    { id: 'a2', role: 'ADMIN', disabled: false, createdAt: ago(400), lastLoginAt: ago(40), reactivatedAt: null, sessionVersion: 0 },
  ];
  const { db } = userDb(users);
  assert.equal(await disableInactiveUsers(db as never, async () => {}, NOW), 1);
  assert.equal(users[1].disabled, true);
});

test('inBatches: stops starting new batches once the run deadline passes (checked before each batch)', async () => {
  const { inBatches } = await import('../src/lib/server/retention');
  let t = 0; let calls = 0;
  const n = await inBatches(async (take) => Array.from({ length: take }, (_, k) => `x${k}`), async (ids) => { calls++; t += 15_000; return ids.length; }, 20_000, 40_000, () => t);
  assert.equal(calls, 3); assert.equal(n, 1500); // 0s、15s、30s 开始的批次跑完；45s 时已过 40s 截止时间，不再开始
});

test('runCleanupSteps: one deadline shared by all steps; later steps skipped and reported', async () => {
  const { runCleanupSteps } = await import('../src/lib/server/retention');
  let t = 0; const got: number[] = [];
  const step = (ms: number, n: number) => async (d: number) => { got.push(d); t += ms; return n; };
  const errs: string[] = [];
  const s = await runCleanupSteps([['a', step(100, 1)], ['b', async (d) => { got.push(d); t += 50; throw new Error('x'); }], ['c', step(900, 3)], ['d', step(1, 4)], ['e', step(1, 5)]], 1000, async (n) => { errs.push(n); }, () => t);
  assert.deepEqual(got, [1000, 1000, 1000], 'same absolute deadline passed to every step that ran');
  assert.deepEqual(s.result, { a: 1, c: 3 }); assert.deepEqual(s.failed, ['b']); assert.deepEqual(errs, ['b']);
  assert.deepEqual(s.skipped, ['d', 'e']); assert.equal(s.deadlineReached, true);
  t = 0;
  const ok = await runCleanupSteps([['a', step(1, 1)]], 1000, async () => {}, () => t);
  assert.deepEqual(ok, { result: { a: 1 }, failed: [], skipped: [], deadlineReached: false });
});

test('runDeadlineMs: default 270000, out-of-range ignored, always < 290s lock tx timeout', async () => {
  const { runDeadlineMs } = await import('../src/lib/server/retention');
  const { LOCK_TX_TIMEOUT_MS } = await import('../src/lib/server/cleanup-lock');
  const env = process.env.RETENTION_RUN_DEADLINE_MS;
  try {
    delete process.env.RETENTION_RUN_DEADLINE_MS; assert.equal(runDeadlineMs(), 270_000);
    for (const v of ['50000', '280000']) { process.env.RETENTION_RUN_DEADLINE_MS = v; assert.equal(runDeadlineMs(), Number(v)); }
    for (const v of ['290000', '999999', '5000', 'abc', '-1']) { process.env.RETENTION_RUN_DEADLINE_MS = v; assert.equal(runDeadlineMs(), 270_000, v); }
    assert.ok(280_000 < LOCK_TX_TIMEOUT_MS);
  } finally { if (env === undefined) delete process.env.RETENTION_RUN_DEADLINE_MS; else process.env.RETENTION_RUN_DEADLINE_MS = env; }
});

test('cleanupOrphanLogos: batched, checks the deadline between batches', async () => {
  const { cleanupOrphanLogos, ORPHAN_BATCH } = await import('../src/lib/server/uploads');
  const rows = Array.from({ length: ORPHAN_BATCH * 3 }, (_, k) => ({ id: `l${k}`, path: `logos/2026-10/abcdefgh${String(k).padStart(4, '0')}.png` }));
  let t = 0; const files: string[] = [];
  const db = { logoUpload: {
    findMany: async (a: { take: number }) => rows.slice(0, a.take),
    deleteMany: async (a: { where: { id: string } }) => { const i = rows.findIndex((r) => r.id === a.where.id); if (i < 0) return { count: 0 }; rows.splice(i, 1); t += 1; return { count: 1 }; },
  } };
  // 每条 1ms，每批 200ms；截止 250ms：第 1 批（0ms 开始）、第 2 批（200ms 开始）跑完，第 3 批（400ms）不开始
  const n = await cleanupOrphanLogos(new Date(), 250, { db: db as never, storage: { delete: async (k: string) => { files.push(k); } }, clock: () => t });
  assert.equal(n, ORPHAN_BATCH * 2); assert.equal(rows.length, ORPHAN_BATCH); assert.equal(files.length, ORPHAN_BATCH * 2);
  assert.equal(await cleanupOrphanLogos(new Date(), 0, { db: db as never, storage: { delete: async () => {} }, clock: () => t }), 0, 'past deadline: nothing fetched');
});

test('disableInactiveUsers: batched over all candidates, stops at the shared deadline', async () => {
  const mk = (k: number): U => ({ id: `s${k}`, role: 'SALES', disabled: false, createdAt: ago(400), lastLoginAt: null, reactivatedAt: null, sessionVersion: 0 });
  const users: U[] = [{ id: 'adm', role: 'ADMIN', disabled: false, createdAt: ago(1), lastLoginAt: ago(1), reactivatedAt: null, sessionVersion: 0 }, ...Array.from({ length: 1100 }, (_, k) => mk(k))];
  const { db } = userDb(users);
  assert.equal(await disableInactiveUsers(db as never, async () => {}, NOW), 1100, 'more than one batch of 500 processed');
  const more: U[] = [users[0], ...Array.from({ length: 10 }, (_, k) => mk(k))];
  const r = userDb(more);
  let t = 0;
  const n = await disableInactiveUsers(r.db as never, async () => { t += 10; }, NOW, 35, () => t);
  assert.equal(n, 4); // 0、10、20、30ms 时开始的账号处理完；40ms 已过 35ms 截止时间
  assert.equal(await disableInactiveUsers(r.db as never, async () => {}, NOW, 0, () => 1), 0, 'past deadline: nothing fetched');
});

test('retention.run audit: one entry per batch, only counts + createdAt range, no ids / PII; contact email random', async () => {
  const inqs: any[] = [
    { id: 'inq_secret_1', contactId: 'c1', retainUntil: new Date(NOW.getTime() - DAY), anonymizedAt: null, message: 'anna@example.com', createdAt: new Date('2024-01-02T00:00:00Z') },
    { id: 'inq_secret_2', contactId: 'c2', retainUntil: new Date(NOW.getTime() - 2 * DAY), anonymizedAt: null, message: 'x', createdAt: new Date('2024-03-04T00:00:00Z') },
  ];
  const { db, audits } = inquiryDb(inqs, []);
  const updates: any[] = [];
  db.contact.update = (async (a: any) => { updates.push(a.data); return {}; }) as never;
  assert.equal(await anonymizeExpiredInquiries(db as never, NOW, 20_000, { delete: async () => {} } as never), 2);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'retention.run');
  assert.equal(audits[0].target, null); assert.equal(audits[0].ip, null);
  assert.deepEqual(audits[0].meta, { step: 'inquiries', count: 2, createdFrom: '2024-01-02T00:00:00.000Z', createdTo: '2024-03-04T00:00:00.000Z' });
  const dump = JSON.stringify(audits);
  for (const pii of ['inq_secret', 'c1', 'c2', 'anna', 'Anna', 'Boris', 'example.com']) assert.ok(!dump.includes(pii), pii);
  // 联系人邮箱来自随机字节，两次不同，且不含原 id
  assert.equal(updates.length, 2);
  for (const u of updates) assert.match(u.email, /^deleted\+[0-9a-f]{16}@invalid\.invalid$/);
  assert.notEqual(updates[0].email, updates[1].email);
  // 重跑不再写审计
  assert.equal(await anonymizeExpiredInquiries(db as never, NOW, 20_000, { delete: async () => {} } as never), 0);
  assert.equal(audits.length, 1);
});
