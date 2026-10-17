import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import * as authStub from './fixtures/auth-stub';

// 回信已发出、写库前询盘被匿名化 → 仍返回 409，但要留 inquiry.reply.sent_but_rejected 审计（不含 PII）
const authFile = path.resolve('src/auth.ts');
const m = new Module(authFile); m.filename = authFile; m.loaded = true; m.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = m;

const INQ = 'cminquiry00000000000002';
const DAY = 86_400_000;
const admin = { id: 'a1', role: 'ADMIN', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 };
const sales = { id: 's1xxxxxxxxxxxxxxxxxxxx', role: 'SALES', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 };
type Inq = { id: string; status: string; assigneeId: string | null; anonymizedAt: Date | null; retainUntil: Date; replyToken: string; ref: string; contact: { email: string } };
type AuditRow = { actorId: string | null; action: string; target: string | null; meta?: unknown; ip: string };
let audits: AuditRow[] = [];
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
  auditLog: { create: async ({ data }: { data: AuditRow }) => { audits.push(data); return {}; }, findMany: async () => [] },
  async $transaction(fn: (tx: unknown) => unknown) { return fn(db); },
};
(globalThis as { prisma?: unknown }).prisma = db;
(globalThis as { __testSession?: unknown }).__testSession = { user: { id: 'a1' }, sv: 1 };

type H = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let reply: { POST: H };
before(async () => {
  reply = await import('../src/app/api/admin/inquiries/[id]/reply/route');
  const origInfo = console.info;
  console.info = (...a: unknown[]) => { if (a[0] === '[mail:dev]') mailsSent++; else origInfo(...a); };
});
beforeEach(() => {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
  messages = []; mailsSent = 0; audits = [];
  inq = { id: INQ, status: 'NEW', assigneeId: null, anonymizedAt: null, retainUntil: new Date(Date.now() + 10 * DAY), replyToken: 'tok', ref: 'PJ-1', contact: { email: 'anna@example.com' } };
});
const P = { params: Promise.resolve({ id: INQ }) };
const req = (suffix: string, method: string, body: unknown) => new Request(`http://localhost/api/admin/inquiries/${INQ}${suffix}`, {
  method, headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('mail sent then inquiry anonymized before DB write → 409 + sent_but_rejected audit without PII', async () => {
  // 模拟竞态：findFirst 时未匿名化，发信后、事务前被匿名化
  const orig = inquiryModel.findFirst;
  inquiryModel.findFirst = async () => { const r = { ...inq, updatedAt: new Date() }; inq.anonymizedAt = new Date(); return r; };
  try {
    const r = await reply.POST(req('/reply', 'POST', { subject: 'Secret subj', body: 'Secret body' }), P);
    assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: 'anonymized' });
    assert.equal(mailsSent, 1); assert.equal(messages.length, 0);
    const a = audits.filter((x) => x.action === 'inquiry.reply.sent_but_rejected');
    assert.equal(a.length, 1);
    assert.equal(a[0].actorId, admin.id); assert.equal(a[0].target, INQ);
    assert.deepEqual(a[0].meta, { inquiryId: INQ, reason: 'anonymized' });
    const dump = JSON.stringify(audits);
    for (const s of ['anna@example.com', 'Secret subj', 'Secret body', 'tok']) assert.ok(!dump.includes(s), s);
    assert.ok(!audits.some((x) => x.action === 'inquiry.reply'));
  } finally { inquiryModel.findFirst = orig; }
});

test('already anonymized before send → 409, no mail, no sent_but_rejected audit', async () => {
  inq.anonymizedAt = new Date();
  const r = await reply.POST(req('/reply', 'POST', { subject: 'Hi', body: 'x' }), P);
  assert.equal(r.status, 409); assert.equal(mailsSent, 0);
  assert.ok(!audits.some((x) => x.action === 'inquiry.reply.sent_but_rejected'));
});

test('normal reply → 201, only inquiry.reply audit', async () => {
  const r = await reply.POST(req('/reply', 'POST', { subject: 'Hi', body: 'x' }), P);
  assert.equal(r.status, 201);
  assert.deepEqual(audits.map((x) => x.action), ['inquiry.reply']);
});
