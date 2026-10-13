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
  const db = {
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
    $transaction: async (p: Promise<unknown>[]) => Promise.all(p),
  };
  return { db, contacts, ops };
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
    user: { findMany: async (a: any) => { cutoff = a.where.createdAt.lt; return users.filter((u) => inactive(u, cutoff)).map((u) => ({ id: u.id })); } },
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
