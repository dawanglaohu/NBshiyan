import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// 询盘通知信（发给销售）和客户自动确认信：每次尝试一行 mail.notification 结构化日志（运维查不到 PJ-2610-JES8VU 的日志）。
// 日志只有对外编号、类型、结果、Message-ID 的 sha256 前 16 位 / 跳过原因 / 错误码；不出现收件人、主题、正文、sendKey。
// 走真实的 POST /api/inquiries：prisma 用内存 stub，SMTP 用 mock 传输，不连数据库也不连网络。

let created = 0;
let autoReplyTaken = new Set<string>();
const db = {
  sharedDesign: { findMany: async () => [] },
  inquiry: {
    create: async ({ data }: { data: { ref: string } }) => ({ id: `cminquiry${String(++created).padStart(15, '0')}`, ref: data.ref }),
    findFirst: async () => null,
    updateMany: async ({ where }: { where: { id: string } }) => { if (autoReplyTaken.has(where.id)) return { count: 0 }; autoReplyTaken.add(where.id); return { count: 1 }; },
  },
  $executeRaw: async () => 1,
  async $transaction(fn: (tx: unknown) => unknown) { return fn(db); },
};
(globalThis as { prisma?: unknown }).prisma = db;

const NOTIFY = 'sales-team@example.test';
const SMTP = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'fake-user@example.test', SMTP_PASS: 'fake-pass', MAIL_FROM: 'PackJoyU <no-reply@example.test>' };
type Outcome = { messageId?: string } | Error;
let outcomes: Outcome[] = [];
let sent: { to: string; subject: string }[] = [];
let lines: string[] = [];
const orig = { info: console.info, error: console.error, warn: console.warn, log: console.log };

let POST: (req: Request) => Promise<Response>;
before(async () => {
  const mail = await import('../src/lib/server/mail');
  mail.setMailTransportFactory((() => ({
    async sendMail(m: { to: string; subject: string }) {
      sent.push({ to: m.to, subject: m.subject });
      const o = outcomes.shift() ?? { messageId: `<gen-${sent.length}@smtp.example.test>` };
      if (o instanceof Error) throw o;
      return o as never;
    },
    close() {},
  })) as never);
  ({ POST } = await import('../src/app/api/inquiries/route'));
});
beforeEach(async () => {
  const { setRateLimitStore, MemoryStore } = await import('../src/lib/server/ratelimit');
  setRateLimitStore(new MemoryStore());
  Object.assign(process.env, SMTP, { INQUIRY_NOTIFY_EMAIL: NOTIFY, SITE_URL: 'https://site.example.test', CONTACT_EMAIL: 'hello@example.test' });
  delete process.env.TURNSTILE_SECRET_KEY; delete process.env.ADMIN_ALERT_EMAIL;
  outcomes = []; sent = []; lines = []; autoReplyTaken = new Set();
  const cap = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  console.info = cap; console.error = cap; console.warn = cap; console.log = cap;
});
afterEach(() => Object.assign(console, orig));

let n = 0;
function submit(o: { email?: string; message?: string } = {}) {
  const email = o.email ?? `buyer${++n}@customer-co.example`;
  const body = { source: 'FORM', locale: 'en', contact: { name: 'Anna Buyer', email, company: 'Customer Co', region: 'DE' }, ...(o.message ? { message: o.message } : {}) };
  return POST(new Request('http://localhost/api/inquiries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
type Rec = { inquiry: string; type: string; ok: boolean; msgIdHash?: string; skipped?: string; code?: string };
const notif = () => lines.filter((l) => l.startsWith('[mail] mail.notification ')).map((l) => JSON.parse(l.slice('[mail] mail.notification '.length)) as Rec);
const hash16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
function assertNoPii(extra: string[] = []) {
  const all = lines.join('\n');
  for (const leak of [NOTIFY, '@customer-co.example', 'Anna Buyer', 'We received your inquiry', ...sent.map((s) => s.subject), ...extra])
    assert.ok(!all.includes(leak), `log leaked: ${leak}`);
}

test('both mails sent: one line each with inquiry ref, type, ok:true, sha256 prefix of SMTP Message-ID', async () => {
  outcomes = [{ messageId: '<notify-1@smtp.example.test>' }, { messageId: '<ack-1@smtp.example.test>' }];
  const r = await submit();
  assert.equal(r.status, 201);
  const { ref } = await r.json() as { ref: string };
  assert.match(ref, /^PJ-\d{4}-[A-Za-z0-9_-]{6}$/);
  const recs = notif();
  assert.equal(recs.length, 2, lines.join('\n'));
  const byType = Object.fromEntries(recs.map((x) => [x.type, x]));
  assert.deepEqual(Object.keys(byType).sort(), ['auto_receipt', 'notify']);
  const ids = { notify: '<notify-1@smtp.example.test>', auto_receipt: '<ack-1@smtp.example.test>' };
  // 两封并发发出，哪封先到 mock 不固定：按 sent 的收件人对上 Message-ID
  const notifyIdx = sent.findIndex((s) => s.to === NOTIFY);
  const hashes = notifyIdx === 0 ? ids : { notify: ids.auto_receipt, auto_receipt: ids.notify };
  for (const t of ['notify', 'auto_receipt'] as const) {
    assert.deepEqual(byType[t], { inquiry: ref, type: t, ok: true, msgIdHash: hash16(hashes[t]) });
    assert.match(byType[t].msgIdHash!, /^[0-9a-f]{16}$/);
  }
  assertNoPii(['notify-1@', 'ack-1@']);
});

test('no INQUIRY_NOTIFY_EMAIL → notify skipped:no_recipient (still logged)', async () => {
  delete process.env.INQUIRY_NOTIFY_EMAIL;
  const { ref } = await (await submit()).json() as { ref: string };
  const recs = notif();
  assert.deepEqual(recs.find((x) => x.type === 'notify'), { inquiry: ref, type: 'notify', ok: false, skipped: 'no_recipient' });
  assert.equal(recs.find((x) => x.type === 'auto_receipt')?.ok, true);
  assertNoPii();
});

test('SMTP not configured → both skipped:mail_disabled; dev line has no recipient / subject', async () => {
  for (const k of Object.keys(SMTP)) delete process.env[k];
  const { ref } = await (await submit()).json() as { ref: string };
  const recs = notif().sort((a, b) => a.type.localeCompare(b.type));
  assert.deepEqual(recs, [
    { inquiry: ref, type: 'auto_receipt', ok: false, skipped: 'mail_disabled' },
    { inquiry: ref, type: 'notify', ok: false, skipped: 'mail_disabled' },
  ]);
  assert.equal(sent.length, 0);
  assertNoPii([`#${ref}`]);
});

test('low trust (has link) → auto_receipt skipped:low_trust; same email twice within 24h → rate_limited', async () => {
  const r1 = await (await submit({ message: 'see www.spam-site.example.xyz please' })).json() as { ref: string };
  assert.deepEqual(notif().find((x) => x.type === 'auto_receipt'), { inquiry: r1.ref, type: 'auto_receipt', ok: false, skipped: 'low_trust' });
  lines = [];
  const email = 'repeat@customer-co.example';
  await submit({ email });
  lines = [];
  const r3 = await (await submit({ email })).json() as { ref: string };
  assert.deepEqual(notif().find((x) => x.type === 'auto_receipt'), { inquiry: r3.ref, type: 'auto_receipt', ok: false, skipped: 'rate_limited' });
  assertNoPii(['repeat@']);
});

test('SMTP failure → ok:false with error code only (no raw response, no recipient)', async () => {
  const raw = Object.assign(new Error(`421 try later for ${NOTIFY} subject "We received your inquiry"`), { responseCode: 421, response: `421 4.7.0 ${NOTIFY}` });
  outcomes = [raw, raw, raw, raw]; // 失败后 sendAdminAlert 也会走同一个 mock 传输
  const { ref } = await (await submit()).json() as { ref: string };
  const recs = notif();
  assert.equal(recs.length, 2);
  for (const x of recs) assert.deepEqual(x, { inquiry: ref, type: x.type, ok: false, code: 'SMTP_421' });
  assertNoPii(['4.7.0', 'try later']);
});

test('logNotification drops unknown keys and unsafe values (mailLog whitelist)', async () => {
  const { logNotification, messageIdHash } = await import('../src/lib/server/mail');
  logNotification({ ref: 'PJ-2610-JES8VU', type: 'notify' }, { ok: true, messageId: '<x@y>' });
  logNotification({ ref: 'PJ-2610 <a@b.example>', type: 'notify' }, { ok: true, messageId: null });
  const recs = notif();
  assert.deepEqual(recs[0], { inquiry: 'PJ-2610-JES8VU', type: 'notify', ok: true, msgIdHash: messageIdHash('<x@y>') });
  assert.equal(recs[1].inquiry, 'redacted');
  assert.equal(recs[1].msgIdHash, 'none');
});
