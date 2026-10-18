import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import * as authStub from './fixtures/auth-stub';
import { buildHistory, pageHistory, decodeCursor, plainCustomerText, HISTORY_MAIL_SELECT, type MailHistoryRow, type HistoryEntry } from '../src/lib/server/admin/history';

// #74 跟进：/history 合并新表 MailMessage + actorKind（customer | user | deleted_user | system）
const t = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 13, 10, m, s));
const users = [{ id: 'u1', name: '王经理', role: 'ADMIN' as const }, { id: 'u2', name: '小李', role: 'SALES' as const }];
const ADDR = { line1: 'Hauptstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' };
const INQ = { id: 'inq1', createdAt: t(0), source: 'FORM', anonymizedAt: null, customerName: 'Anna <b>Müller</b>\u202e' };
const mail = (o: Partial<MailHistoryRow> & { id: string }): MailHistoryRow => ({ direction: 'OUTBOUND', status: 'SENT', subject: 'Re: quote', authorId: 'u2', redactedAt: null, createdAt: t(10), ...o });
const ENTRY_KEYS = ['actor', 'actorKind', 'at', 'cursor', 'summary', 'type'];

test('new MailMessage rows merged: outbound → reply (status marked), inbound → inbound; UNASSIGNED / IGNORED skipped', () => {
  const mails = [
    mail({ id: 'cmmail01', status: 'SENT', createdAt: t(5) }),
    mail({ id: 'cmmail02', status: 'FAILED', subject: 'Price list', createdAt: t(6) }),
    mail({ id: 'cmmail03', status: 'QUEUED', subject: 'Later', createdAt: t(7) }),
    mail({ id: 'cmmail04', direction: 'INBOUND', status: 'RECEIVED', authorId: null, subject: 'Re: Re: quote', createdAt: t(8) }),
    mail({ id: 'cmmail05', direction: 'INBOUND', status: 'UNASSIGNED', authorId: null, createdAt: t(9) }),
    mail({ id: 'cmmail06', direction: 'INBOUND', status: 'IGNORED', authorId: null, createdAt: t(9) }),
  ];
  const h = buildHistory(INQ, [], [], users, ADDR, mails);
  assert.deepEqual(h.map((e) => [e.type, e.summary]), [
    ['inbound', '收到客户来信：Re: Re: quote'],
    ['reply', '回复客户（排队待发）：Later'],
    ['reply', '回复客户（发送失败）：Price list'],
    ['reply', '已回复客户：Re: quote'],
    ['created', '客户提交询盘（FORM）'],
  ]);
  for (const e of h) assert.deepEqual(Object.keys(e).sort(), ENTRY_KEYS);
  assert.deepEqual(h[3].actor, { name: '小李', role: 'SALES' });
  assert.equal(h[3].actorKind, 'user');
  // 新表游标带 mm: 前缀，格式仍是 base64url("<ISO>|<key>")
  assert.equal(decodeCursor(h[0].cursor)!.key, 'mm:cmmail04');
  assert.equal(Buffer.from(h[0].cursor, 'base64url').toString(), `${t(8).toISOString()}|mm:cmmail04`);
});

test('actorKind mapping: created/inbound → customer (sanitized name), user, deleted_user (actor null), system (actorId null)', () => {
  const audits = [
    { id: 'a1', action: 'inquiry.update', actorId: 'u1', createdAt: t(1), meta: { before: { status: 'NEW' }, after: { status: 'FOLLOWING' } } },
    { id: 'a2', action: 'inquiry.update', actorId: 'gone-user', createdAt: t(2), meta: { before: { status: 'FOLLOWING' }, after: { status: 'QUOTED' } } },
    { id: 'a3', action: 'inquiry.update', actorId: null, createdAt: t(3), meta: { before: { status: 'QUOTED' }, after: { status: 'INVALID' } } },
  ];
  const legacy = [
    { id: 'm1', direction: 'OUTBOUND' as const, subject: 'old reply', authorId: 'gone-user', createdAt: t(4) },
    { id: 'm2', direction: 'INBOUND' as const, subject: 'old inbound', authorId: null, createdAt: t(5) },
  ];
  const h = buildHistory(INQ, audits, legacy, users, ADDR, [mail({ id: 'cmmail07', direction: 'INBOUND', status: 'RECEIVED', authorId: null, createdAt: t(6) })]);
  const by = (summary: string) => h.find((e) => e.summary.includes(summary))!;
  const customer = { name: 'Anna Müller', role: null };
  assert.deepEqual([by('客户提交询盘').actorKind, by('客户提交询盘').actor], ['customer', customer]);
  assert.deepEqual([by('old inbound').actorKind, by('old inbound').actor], ['customer', customer]);
  assert.deepEqual([by('Re: quote').actorKind, by('Re: quote').actor], ['customer', customer]);
  assert.deepEqual([by('新询盘 → 跟进中').actorKind, by('新询盘 → 跟进中').actor], ['user', { name: '王经理', role: 'ADMIN' }]);
  assert.deepEqual([by('跟进中 → 已报价').actorKind, by('跟进中 → 已报价').actor], ['deleted_user', null]);
  assert.deepEqual([by('old reply').actorKind, by('old reply').actor], ['deleted_user', null]);
  assert.deepEqual([by('已报价 → 无效').actorKind, by('已报价 → 无效').actor], ['system', null]);
  assert.ok(!JSON.stringify(h).includes('gone-user'), 'no user ids');
});

test('anonymized inquiry: customer name and every subject (legacy + new) → [deleted]; redacted mail row → [deleted]', () => {
  const legacy = [{ id: 'm1', direction: 'INBOUND' as const, subject: 'Secret subject A', authorId: null, createdAt: t(4) }];
  const mails = [mail({ id: 'cmmail08', subject: 'Secret subject B', createdAt: t(5) })];
  const h = buildHistory({ ...INQ, anonymizedAt: t(30), customerName: 'Anna' }, [], legacy, users, ADDR, mails);
  const json = JSON.stringify(h);
  assert.ok(!/Secret subject|Anna/.test(json), json);
  assert.deepEqual(h.map((e) => e.summary), ['已回复客户：[deleted]', '收到客户来信：[deleted]', '客户提交询盘（FORM）']);
  for (const e of h.filter((x) => x.actorKind === 'customer')) assert.deepEqual(e.actor, { name: '[deleted]', role: null });
  // 未匿名化询盘里单条 redactedAt 的信也只显示 [deleted]；联系人名字已是 [deleted] 时同样
  const h2 = buildHistory({ ...INQ, customerName: '[deleted]' }, [], [], users, ADDR, [mail({ id: 'cmmail09', subject: 'leftover', redactedAt: t(20) })]);
  assert.equal(h2[0].summary, '已回复客户：[deleted]');
  assert.deepEqual(h2[1].actor, { name: '[deleted]', role: null });
});

test('subject §18 plain text: tags/script stripped, control + bidi chars removed, emails and address masked, ≤ 80 chars', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>Hi\u0000\u202e\r\nBcc: <b>bold</b> from anna@customer.example to Hauptstr 1, 10115 Berlin';
  const s = plainCustomerText(evil, ADDR);
  assert.equal(s, 'Hi Bcc: bold from ***@*** to ***, *** ***');
  const long = plainCustomerText('词'.repeat(200) + '😀'.repeat(5));
  assert.equal([...long].length, 80);
  const h = buildHistory(INQ, [], [], users, ADDR, [mail({ id: 'cmmail10', direction: 'INBOUND', status: 'RECEIVED', authorId: null, subject: evil })]);
  assert.equal(h[0].summary, '收到客户来信：Hi Bcc: bold from ***@*** to ***, *** ***');
  assert.equal(buildHistory(INQ, [], [], users, null, [mail({ id: 'cmmail11', subject: '  ' })])[0].summary, '已回复客户：（无主题）');
});

test('never includes body, counterpart address, Message-ID or sendKey even if rows carry them; DB select whitelist', () => {
  const row = { ...mail({ id: 'cmmail12' }), bodyHtml: '<p>BODY-SECRET</p>', bodyText: 'BODY-SECRET', toAddr: 'buyer@customer.example', fromAddr: 'sender@gmail.example', messageId: '<SENDKEY123@geiom.example>', sendKey: 'SENDKEY123' };
  const json = JSON.stringify(buildHistory(INQ, [], [], users, ADDR, [row as MailHistoryRow]));
  for (const leak of ['BODY-SECRET', 'buyer@', 'sender@', 'SENDKEY123', 'geiom.example']) assert.ok(!json.includes(leak), leak);
  assert.deepEqual(Object.keys(HISTORY_MAIL_SELECT).sort(), ['authorId', 'createdAt', 'direction', 'id', 'redactedAt', 'status', 'subject']);
});

test('no dedupe between legacy InquiryMessage and MailMessage (no shared server id): same subject + same time → both kept', () => {
  const legacy = [{ id: 'm1', direction: 'OUTBOUND' as const, subject: 'Re: quote', authorId: 'u2', createdAt: t(10) }];
  const h = buildHistory(INQ, [], legacy, users, ADDR, [mail({ id: 'cmmail13', subject: 'Re: quote', createdAt: t(10) })]);
  assert.equal(h.filter((e) => e.type === 'reply').length, 2);
});

test('equal timestamps across sources: deterministic order independent of input order; paging with limit 1 visits each once', () => {
  const at = t(15);
  const audits = [{ id: 'a9', action: 'inquiry.update', actorId: 'u1', createdAt: at, meta: { before: { status: 'NEW', assigneeId: null }, after: { status: 'QUOTED', assigneeId: 'u2' } } }];
  const legacy = [{ id: 'm9', direction: 'INBOUND' as const, subject: 'L', authorId: null, createdAt: at }, { id: 'm8', direction: 'OUTBOUND' as const, subject: 'L2', authorId: 'u1', createdAt: at }];
  const mails = [mail({ id: 'cmmail20', createdAt: at }), mail({ id: 'cmmail19', direction: 'INBOUND', status: 'RECEIVED', authorId: null, createdAt: at }), mail({ id: 'cmmail21', createdAt: at })];
  const inq = { ...INQ, createdAt: at };
  const keys = (h: HistoryEntry[]) => h.map((e) => decodeCursor(e.cursor)!.key);
  const h1 = buildHistory(inq, audits, legacy, users, ADDR, mails);
  const h2 = buildHistory(inq, [...audits].reverse(), [...legacy].reverse(), [...users].reverse(), ADDR, [...mails].reverse());
  assert.deepEqual(keys(h1), keys(h2));
  assert.deepEqual(keys(h1), ['s:a9', 'mm:cmmail21', 'mm:cmmail20', 'mm:cmmail19', 'm:m9', 'm:m8', 'i:inq1', 'a:a9']);
  const seen: string[] = [];
  let before: string | undefined;
  for (let i = 0; i < 20; i++) {
    const p = pageHistory(h1, 1, before)!;
    if (!p.items.length) break;
    seen.push(decodeCursor(p.items[0].cursor)!.key); before = p.items[0].cursor;
  }
  assert.deepEqual(seen, keys(h1));
  // 旧版游标（旧表 m: 前缀）仍然能用
  const legacyCursor = Buffer.from(`${at.toISOString()}|m:m9`).toString('base64url');
  assert.deepEqual(pageHistory(h1, 2, legacyCursor)!.items.map((e) => decodeCursor(e.cursor)!.key), ['m:m8', 'i:inq1']);
});

// —— 路由：查新表时 where 只取询盘下可见状态、select 走白名单；客户名来自 contact.name ——
const authFile = path.resolve('src/auth.ts');
const mod = new Module(authFile); mod.filename = authFile; mod.loaded = true; mod.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = mod;
const ID = 'cminquiry00000000000009';
let lastSelect: Record<string, unknown> | null = null;
let anonymizedAt: Date | null = null;
(globalThis as { prisma?: unknown }).prisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'a1' ? { id: 'a1', role: 'ADMIN', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 } : null),
    findMany: async ({ where }: { where: { id: { in: string[] } } }) => [{ id: 'a1', name: '王经理', role: 'ADMIN' }].filter((u) => where.id.in.includes(u.id)),
  },
  inquiry: {
    findFirst: async ({ select }: { select: Record<string, unknown> }) => {
      lastSelect = select;
      return { id: ID, createdAt: t(0), source: 'FORM', anonymizedAt, contact: { name: 'Anna <i>B</i>' }, sample: null, messages: [],
        mailMessages: [{ id: 'cmmail30', direction: 'OUTBOUND', status: 'FAILED', subject: 'Quote <script>x</script>', authorId: 'a1', redactedAt: null, createdAt: t(3) },
          { id: 'cmmail31', direction: 'INBOUND', status: 'RECEIVED', subject: 'Thanks', authorId: null, redactedAt: null, createdAt: t(4) }] };
    },
  },
  auditLog: { findMany: async () => [] },
};
type H = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let route: { GET: H };
before(async () => { route = await import('../src/app/api/admin/inquiries/[id]/history/route'); });

test('route: merges MailMessage via whitelisted select, returns actorKind + sanitized customer name; anonymized → [deleted]', async () => {
  (globalThis as { __testSession?: unknown }).__testSession = { user: { id: 'a1' }, sv: 1 };
  const get = () => route.GET(new Request(`http://localhost/api/admin/inquiries/${ID}/history`), { params: Promise.resolve({ id: ID }) });
  const r = await get();
  assert.equal(r.status, 200);
  const body = await r.json() as { items: HistoryEntry[]; total: number };
  assert.equal(body.total, 3);
  assert.deepEqual(body.items.map((e) => [e.type, e.actorKind, e.actor, e.summary]), [
    ['inbound', 'customer', { name: 'Anna B', role: null }, '收到客户来信：Thanks'],
    ['reply', 'user', { name: '王经理', role: 'ADMIN' }, '回复客户（发送失败）：Quote'],
    ['created', 'customer', { name: 'Anna B', role: null }, '客户提交询盘（FORM）'],
  ]);
  const mm = (lastSelect as { mailMessages: { select: Record<string, true>; where: unknown } }).mailMessages;
  assert.deepEqual(mm.select, HISTORY_MAIL_SELECT);
  assert.deepEqual(mm.where, { status: { in: ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'RECEIVED'] } });
  assert.deepEqual((lastSelect as { contact: unknown }).contact, { select: { name: true } }, 'only contact name, never email');
  anonymizedAt = t(50);
  const anon = await (await get()).json() as { items: HistoryEntry[] };
  assert.ok(!/Anna|Thanks|Quote/.test(JSON.stringify(anon)));
  anonymizedAt = null;
});
