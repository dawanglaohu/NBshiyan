import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import * as authStub from './fixtures/auth-stub';

// 隐私审计第 7 条：最后活动规则（回信 / 改状态顺延 retainUntil 到 now + INQUIRY_RETAIN_DAYS）；已匿名化询盘回信、改派返回 409
const authFile = path.resolve('src/auth.ts');
const m = new Module(authFile); m.filename = authFile; m.loaded = true; m.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = m;

const INQ = 'cminquiry00000000000002';
const DAY = 86_400_000;
const admin = { id: 'a1', role: 'ADMIN', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 };
const sales = { id: 's1xxxxxxxxxxxxxxxxxxxx', role: 'SALES', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 };
type Inq = { id: string; status: string; assigneeId: string | null; anonymizedAt: Date | null; retainUntil: Date; replyToken: string; ref: string; contact: { email: string } };
let inq: Inq; let messages: unknown[]; let mailsSent = 0;
const matchesAnon = (w: { anonymizedAt?: null }) => !('anonymizedAt' in w) || inq.anonymizedAt === null;
const inquiryModel = {
  findFirst: async () => ({ ...inq, updatedAt: new Date() }),
  updateMany: async ({ where, data }: { where: { id: string; anonymizedAt?: null }; data: Partial<Inq> }) => {
    if (where.id !== inq.id || !matchesAnon(where)) return { count: 0 };
    Object.assign(inq, data); return { count: 1 };
  },
};
const db = {
  user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === admin.id ? admin : where.id === sales.id ? sales : null), findMany: async () => [] },
  inquiry: inquiryModel,
  inquiryMessage: { create: async ({ data }: { data: unknown }) => { messages.push(data); return { id: 'm1', ...(data as object) }; } },
  auditLog: { create: async () => ({}), findMany: async () => [] },
  async $transaction(fn: (tx: unknown) => unknown) { return fn(db); },
};
(globalThis as { prisma?: unknown }).prisma = db;
(globalThis as { __testSession?: unknown }).__testSession = { user: { id: 'a1' }, sv: 1 };

type H = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let detail: { PATCH: H }; let reply: { POST: H };
before(async () => {
  detail = await import('../src/app/api/admin/inquiries/[id]/route');
  reply = await import('../src/app/api/admin/inquiries/[id]/reply/route');
  const origInfo = console.info;
  console.info = (...a: unknown[]) => { if (a[0] === '[mail:dev]') mailsSent++; else origInfo(...a); };
});
beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  messages = []; mailsSent = 0;
  inq = { id: INQ, status: 'NEW', assigneeId: null, anonymizedAt: null, retainUntil: new Date(Date.now() + 10 * DAY), replyToken: 'tok', ref: 'PJ-1', contact: { email: 'anna@example.com' } };
});
const P = { params: Promise.resolve({ id: INQ }) };
const req = (suffix: string, method: string, body: unknown) => new Request(`http://localhost/api/admin/inquiries/${INQ}${suffix}`, {
  method, headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const near730 = (d: Date) => Math.abs(d.getTime() - (Date.now() + 730 * DAY)) < 60_000;

test('status change extends retainUntil to now + 730 days', async () => {
  const r = await detail.PATCH(req('', 'PATCH', { status: 'FOLLOWING' }), P);
  assert.equal(r.status, 200);
  assert.ok(near730(inq.retainUntil), inq.retainUntil.toISOString());
});

test('assignment alone does not extend retainUntil', async () => {
  const before = inq.retainUntil.getTime();
  const r = await detail.PATCH(req('', 'PATCH', { assigneeId: sales.id }), P);
  assert.equal(r.status, 200);
  assert.equal(inq.retainUntil.getTime(), before);
});

test('reply extends retainUntil to now + 730 days', async () => {
  const r = await reply.POST(req('/reply', 'POST', { subject: 'Hi', body: 'Quote attached' }), P);
  assert.equal(r.status, 201);
  assert.ok(near730(inq.retainUntil));
  assert.equal(messages.length, 1);
});

test('assign/status PATCH on anonymized inquiry → 409, nothing written', async () => {
  inq.anonymizedAt = new Date(); const before = inq.retainUntil.getTime();
  const r = await detail.PATCH(req('', 'PATCH', { assigneeId: sales.id }), P);
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'anonymized' });
  assert.equal(inq.assigneeId, null); assert.equal(inq.retainUntil.getTime(), before);
});

test('reply on anonymized inquiry → 409, no mail sent, no message stored', async () => {
  inq.anonymizedAt = new Date();
  const r = await reply.POST(req('/reply', 'POST', { subject: 'Hi', body: 'x' }), P);
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'anonymized' });
  assert.equal(mailsSent, 0); assert.equal(messages.length, 0);
});

// (8)(9) 列表/详情返回 anonymizedAt；列表 includeAnonymized 默认 false，服务端过滤（count 与 findMany 同一 where），并保留 inquiryScope
test('list: default filters anonymizedAt IS NULL in count + findMany, keeps scope, selects anonymizedAt; includeAnonymized=true drops filter', async () => {
  const list: { GET: (r: Request) => Promise<Response> } = await import('../src/app/api/admin/inquiries/route');
  const seen: { op: string; where: any; select?: any }[] = [];
  const rowsAll = [{ id: 'r1', anonymizedAt: null }, { id: 'r2', anonymizedAt: new Date('2026-01-01') }];
  const filt = (w: any) => (JSON.stringify(w).includes('"anonymizedAt":null') ? rowsAll.filter((r) => r.anonymizedAt === null) : rowsAll);
  const saved = { count: (db.inquiry as any).count, findMany: (db.inquiry as any).findMany, tx: db.$transaction };
  Object.assign(db.inquiry, {
    count: (a: any) => { seen.push({ op: 'count', where: a.where }); return filt(a.where).length; },
    findMany: (a: any) => { seen.push({ op: 'findMany', where: a.where, select: a.select }); return filt(a.where); },
  });
  (db as any).$transaction = async (x: any) => (Array.isArray(x) ? Promise.all(x) : x(db));
  (globalThis as { __testSession?: unknown }).__testSession = { user: { id: sales.id }, sv: 1 };
  try {
    const r = await list.GET(new Request('http://localhost/api/admin/inquiries'));
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.total, 1); assert.deepEqual(b.items.map((i: any) => i.id), ['r1']);
    for (const s of seen) {
      assert.ok(s.where.AND.some((c: any) => c.anonymizedAt === null && Object.keys(c).length === 1), `${s.op} filters anonymized`);
      assert.ok(s.where.AND.some((c: any) => c.assigneeId === sales.id), `${s.op} keeps inquiryScope`);
    }
    assert.equal(seen.find((s) => s.op === 'findMany')!.select.anonymizedAt, true);
    seen.length = 0;
    const r2 = await list.GET(new Request('http://localhost/api/admin/inquiries?includeAnonymized=true'));
    const b2 = await r2.json();
    assert.equal(b2.total, 2);
    for (const s of seen) {
      assert.ok(!s.where.AND.some((c: any) => 'anonymizedAt' in c), 'no anonymized filter');
      assert.ok(s.where.AND.some((c: any) => c.assigneeId === sales.id), 'scope still applied');
    }
    assert.equal((await list.GET(new Request('http://localhost/api/admin/inquiries?includeAnonymized=yes'))).status, 400);
  } finally {
    Object.assign(db.inquiry, { count: saved.count, findMany: saved.findMany }); (db as any).$transaction = saved.tx;
    (globalThis as { __testSession?: unknown }).__testSession = { user: { id: 'a1' }, sv: 1 };
  }
});

test('detail GET returns anonymizedAt (include → all scalars)', async () => {
  inq.anonymizedAt = new Date('2026-02-03T00:00:00Z');
  const saved = inquiryModel.findFirst;
  inquiryModel.findFirst = async () => ({ ...inq, sample: null, logoUploads: [], updatedAt: new Date() }) as never;
  try {
    const d: { GET: H } = await import('../src/app/api/admin/inquiries/[id]/route');
    const r = await d.GET(new Request(`http://localhost/api/admin/inquiries/${INQ}`), P);
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.anonymizedAt, '2026-02-03T00:00:00.000Z');
    assert.equal(b.replyToken, undefined);
  } finally { inquiryModel.findFirst = saved; }
});

test('(10) status change to INVALID (and other statuses) on anonymized inquiry → 409, status unchanged', async () => {
  inq.anonymizedAt = new Date();
  for (const status of ['INVALID', 'WON', 'FOLLOWING']) {
    const r = await detail.PATCH(req('', 'PATCH', { status }), P);
    assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'anonymized' });
  }
  assert.equal(inq.status, 'NEW');
});

test('(11) extendInquiryRetention never extends anonymized inquiries (helper guard)', async () => {
  const { extendInquiryRetention } = await import('../src/lib/server/admin/inquiries');
  const seen: any[] = [];
  const fake = { inquiry: { updateMany: async (a: any) => { seen.push(a.where); return { count: 0 }; } } };
  assert.equal(await extendInquiryRetention(fake, INQ), false);
  assert.deepEqual(seen[0], { id: INQ, anonymizedAt: null });
  inq.anonymizedAt = new Date(); const before = inq.retainUntil.getTime();
  assert.equal(await extendInquiryRetention(db as never, INQ), false);
  assert.equal(inq.retainUntil.getTime(), before);
  inq.anonymizedAt = null;
  assert.equal(await extendInquiryRetention(db as never, INQ), true);
  assert.ok(near730(inq.retainUntil));
});

test('(12) search path (q) also filters anonymized by default; includeAnonymized=true with q drops only that filter', async () => {
  const list: { GET: (r: Request) => Promise<Response> } = await import('../src/app/api/admin/inquiries/route');
  const seen: any[] = [];
  const saved = { count: (db.inquiry as any).count, findMany: (db.inquiry as any).findMany, tx: db.$transaction };
  Object.assign(db.inquiry, { count: (a: any) => { seen.push(a.where); return 0; }, findMany: (a: any) => { seen.push(a.where); return []; } });
  (db as any).$transaction = async (x: any) => (Array.isArray(x) ? Promise.all(x) : x(db));
  try {
    assert.equal((await list.GET(new Request('http://localhost/api/admin/inquiries?q=anna'))).status, 200);
    assert.equal(seen.length, 2);
    for (const w of seen) {
      assert.ok(w.AND.some((c: any) => c.OR), 'search clause present');
      assert.ok(w.AND.some((c: any) => c.anonymizedAt === null), 'anonymized filtered on search path');
    }
    seen.length = 0;
    await list.GET(new Request('http://localhost/api/admin/inquiries?q=anna&includeAnonymized=1'));
    for (const w of seen) { assert.ok(w.AND.some((c: any) => c.OR)); assert.ok(!w.AND.some((c: any) => 'anonymizedAt' in c)); }
  } finally { Object.assign(db.inquiry, { count: saved.count, findMany: saved.findMany }); (db as any).$transaction = saved.tx; }
});

// 内部备注：已匿名化 → 409；检查后被匿名化（FOR UPDATE 查不到）→ 409，不写入；正常写入不顺延保留期
let notesRoute: { POST: H }; let notes: unknown[] = []; let raceAnon = false;
before(async () => {
  Object.assign(db, {
    inquiryNote: { create: async ({ data }: { data: unknown }) => { notes.push(data); return { id: 'n1', ...(data as object) }; } },
    $queryRaw: async (strings: TemplateStringsArray) => {
      assert.match(strings.join('?'), /"anonymizedAt" IS NULL FOR UPDATE/);
      if (raceAnon) inq.anonymizedAt = new Date();
      return inq.anonymizedAt ? [] : [{ id: inq.id }];
    },
  });
  notesRoute = await import('../src/app/api/admin/inquiries/[id]/notes/route');
});
beforeEach(() => { notes = []; raceAnon = false; });

test('note on live inquiry → 201, stored, retainUntil unchanged', async () => {
  const before = inq.retainUntil.getTime();
  const r = await notesRoute.POST(req('/notes', 'POST', { body: '客户要样品' }), P);
  assert.equal(r.status, 201); assert.equal(notes.length, 1); assert.equal(inq.retainUntil.getTime(), before);
});

test('note on anonymized inquiry → 409 anonymized, nothing written', async () => {
  inq.anonymizedAt = new Date();
  const r = await notesRoute.POST(req('/notes', 'POST', { body: 'x' }), P);
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'anonymized' }); assert.equal(notes.length, 0);
});

test('note: anonymized between check and write → 409, nothing written', async () => {
  raceAnon = true;
  const r = await notesRoute.POST(req('/notes', 'POST', { body: 'x' }), P);
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'anonymized' }); assert.equal(notes.length, 0);
});
