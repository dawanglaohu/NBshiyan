// #340：GET /api/admin/inquiries/:id/mail 往来邮件列表。内存假库，不连任何数据库。
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import * as authStub from './fixtures/auth-stub';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit';
import { decodeThreadCursor, encodeThreadCursor, MAIL_SELECT, LEGACY_SELECT, parseThreadQuery } from '../src/lib/server/mail/thread';

const authFile = path.resolve('src/auth.ts');
const m = new Module(authFile); m.filename = authFile; m.loaded = true; m.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = m;

type Row = Record<string, unknown>;
const INQ = 'cminquiry00000000000001';
const OTHER = 'cminquiry00000000000002';
const ANON = 'cminquiry00000000000003';
const SALES_INQ = 'cminquiry00000000000004';
const users: Row[] = [
  { id: 'useradmin000000000001', name: 'Admin A', role: 'ADMIN', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 },
  { id: 'usersales000000000001', name: 'Sales S', role: 'SALES', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 },
];
const ADMIN_SESSION = { user: { id: 'useradmin000000000001' }, sv: 1 };
const SALES_SESSION = { user: { id: 'usersales000000000001' }, sv: 1 };
const g = globalThis as { prisma?: unknown; __testSession?: unknown };

/** 只实现本路由用到的 Prisma 子集：AND / OR / 等值（含 Date）/ in / lt / lte；orderBy createdAt desc, id desc；take；select */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') { if (!(v as Row[]).every((w) => matches(row, w))) return false; continue; }
    if (k === 'OR') { if (!(v as Row[]).some((w) => matches(row, w))) return false; continue; }
    const cur = row[k] as unknown;
    const val = (x: unknown) => (x instanceof Date ? x.getTime() : x);
    if (v instanceof Date || v === null || typeof v !== 'object') { if (val(cur) !== val(v)) return false; continue; }
    const o = v as Row;
    if ('in' in o && !(o.in as unknown[]).includes(cur)) return false;
    if ('lt' in o && !((val(cur) as number | string) < (val(o.lt) as number | string))) return false;
    if ('lte' in o && !((val(cur) as number | string) <= (val(o.lte) as number | string))) return false;
  }
  return true;
}
const pick = (r: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r });
const desc = (a: Row, b: Row) => ((b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()) || (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0);

let mails: Row[] = [], legacy: Row[] = [], inquiries: Row[] = [];
const selects: Row[] = [];
const db = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => users.find((u) => u.id === where.id) ?? null,
    findMany: async ({ where, select }: { where: Row; select?: Row }) => users.filter((u) => matches(u, where)).map((u) => pick(u, select)),
  },
  inquiry: { findFirst: async ({ where, select }: { where: Row; select?: Row }) => { const r = inquiries.find((i) => matches(i, where)); return r ? pick(r, select) : null; } },
  mailMessage: { findMany: async ({ where, take, select }: { where: Row; take?: number; select?: Row }) => { selects.push(select ?? {}); return mails.filter((r) => matches(r, where)).sort(desc).slice(0, take ?? 1e9).map((r) => pick(r, select)); } },
  inquiryMessage: { findMany: async ({ where, take, select }: { where: Row; take?: number; select?: Row }) => { selects.push(select ?? {}); return legacy.filter((r) => matches(r, where)).sort(desc).slice(0, take ?? 1e9).map((r) => pick(r, select)); } },
  auditLog: { create: async () => ({}) },
};
g.prisma = db;

const T = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min, 0));
let seq = 0;
const mid = () => `cmmail${String(++seq).padStart(18, '0')}`;
const lid = () => `cmlegacy${String(++seq).padStart(16, '0')}`;
function mail(o: Row): Row {
  return {
    id: mid(), direction: 'INBOUND', status: 'RECEIVED', inquiryId: INQ, messageId: '<secret-msgid@reply.example>', sendKey: 'sendkeySECRET', inReplyTo: '<x@y>', references: '<x@y>',
    remoteMailId: 'worker-secret-id', idemKey: 'idemSECRET', fromAddr: 'buyer@customer.example', fromHash: 'hashSECRET', toAddr: 'r+replytokenSECRET@reply.example',
    subject: 'Hello', bodyHtml: '<p>hi</p>', bodyText: 'hi', hasRemoteImages: false, authSpf: 'pass', authDkim: 'pass', authDmarc: 'pass', senderVerified: true,
    authorId: null, errorCode: null, retryable: false, attempts: 1, retryCount: 0, lockedUntil: null, requestStartedAt: null, capDay: null, deferredUntil: null,
    deliveryStatus: 'UNKNOWN', redactedAt: null, flags: [], sentAt: null, receivedAt: T(0), createdAt: T(0), updatedAt: T(0), ...o,
  };
}
const leg = (o: Row): Row => ({ id: lid(), inquiryId: INQ, direction: 'OUTBOUND', subject: 'Old', bodyHtml: '<p>old</p>', authorId: 'useradmin000000000001', createdAt: T(0), ...o });

function reset() {
  seq = 0; selects.length = 0;
  inquiries = [
    { id: INQ, anonymizedAt: null, assigneeId: null, replyToken: 'replytokenSECRET' },
    { id: OTHER, anonymizedAt: null, assigneeId: null, replyToken: 'other' },
    { id: ANON, anonymizedAt: T(50), assigneeId: null, replyToken: 'anon' },
    { id: SALES_INQ, anonymizedAt: null, assigneeId: 'usersales000000000001', replyToken: 's' },
  ];
  mails = []; legacy = [];
}

type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let GET: H;
before(async () => { ({ GET } = await import('../src/app/api/admin/inquiries/[id]/mail/route') as unknown as { GET: H }); });
beforeEach(() => {
  reset();
  setRateLimitStore(new MemoryStore());
  process.env.NEXT_PUBLIC_ADMIN_MAIL = 'http';
  g.__testSession = ADMIN_SESSION;
});

const call = (id: string, qs = '', headers: Record<string, string> = {}) => GET(new Request(`http://localhost/api/admin/inquiries/${id}/mail${qs}`, { headers }), { params: Promise.resolve({ id }) });
const body = async (r: Response) => r.json() as Promise<{ anonymizedAt: string | null; items: Row[]; nextCursor: string | null; error?: string; fields?: Row }>;

const ITEM_KEYS = ['attachments', 'authorName', 'bodyHtml', 'bodyText', 'bouncedAt', 'createdAt', 'deferredUntil', 'deliveryStatus', 'direction', 'errorCode', 'flags', 'from',
  'hasRemoteImages', 'id', 'maxRetries', 'receivedAt', 'redacted', 'retryCount', 'retryable', 'senderVerified', 'sentAt', 'source', 'status', 'subject', 'to'].sort();

test('邮件开关关闭（未设置 / 空 / off / mock）→ 404 not_found，且在鉴权之前', async () => {
  mails.push(mail({}));
  for (const v of [undefined, '', 'off', 'mock']) {
    if (v === undefined) delete process.env.NEXT_PUBLIC_ADMIN_MAIL; else process.env.NEXT_PUBLIC_ADMIN_MAIL = v;
    g.__testSession = null;
    const r = await call(INQ);
    assert.equal(r.status, 404, String(v));
    assert.deepEqual(await r.json(), { error: 'not_found' });
  }
});

test('未登录 → 401 unauthorized；GET 不带 Origin 也不会 403', async () => {
  g.__testSession = null;
  const r = await call(INQ);
  assert.equal(r.status, 401);
  assert.equal((await body(r)).error, 'unauthorized');
  g.__testSession = ADMIN_SESSION;
  const ok = await call(INQ); // 没有 Origin / Referer 头
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control') ?? '', /no-store/);
});

test('不存在 / 非法 id / 已匿名化 / SALES 越权 → 一律 404 not_found（不 403）', async () => {
  mails.push(mail({ inquiryId: ANON }), mail({ inquiryId: INQ }));
  for (const id of ['cminquiry00000000000099', 'BAD-ID', ANON]) {
    const r = await call(id);
    assert.equal(r.status, 404, id);
    assert.deepEqual(await r.json(), { error: 'not_found' });
  }
  g.__testSession = SALES_SESSION;
  const r = await call(INQ); // 没分配给该 SALES
  assert.equal(r.status, 404);
  const own = await call(SALES_INQ);
  assert.equal(own.status, 200);
});

test('形状与前端 ThreadPage 一致：字段集合白名单、deliveryStatus 小写、正序、attachments []、anonymizedAt null', async () => {
  mails.push(
    mail({ createdAt: T(1), receivedAt: T(1), bodyHtml: '<p onclick="x()">in<script>alert(1)</script><img src="https://t.example/p.gif"></p>' }),
    mail({ direction: 'OUTBOUND', status: 'FAILED', createdAt: T(2), authorId: 'useradmin000000000001', fromAddr: 'shop@reply.example', toAddr: 'buyer@customer.example', errorCode: 'provider_throttled', retryable: true, retryCount: 2, deliveryStatus: 'BOUNCED', subject: 'Re: Hello', bodyHtml: 'a&lt;b<br>c', bodyText: 'a<b\nc' }),
    mail({ direction: 'OUTBOUND', status: 'QUEUED', createdAt: T(3), errorCode: 'daily_cap_deferred', deferredUntil: T(90), authorId: 'useradmin000000000001' }),
  );
  const r = await call(INQ, '?limit=50');
  assert.equal(r.status, 200);
  const b = await body(r);
  assert.deepEqual(Object.keys(b).sort(), ['anonymizedAt', 'items', 'nextCursor']);
  assert.equal(b.anonymizedAt, null);
  assert.equal(b.nextCursor, null);
  assert.equal(b.items.length, 3);
  for (const it of b.items) assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS);
  assert.deepEqual(b.items.map((i) => i.createdAt), [T(1), T(2), T(3)].map((d) => d.toISOString()));
  const [inb, out, queued] = b.items;
  assert.equal(inb.source, 'mail'); assert.equal(inb.direction, 'INBOUND'); assert.equal(inb.status, 'RECEIVED');
  assert.equal(inb.deliveryStatus, 'unknown'); assert.equal(inb.authorName, null);
  assert.doesNotMatch(String(inb.bodyHtml), /script|onclick| src="https:/);
  assert.match(String(inb.bodyHtml), /data-remote-src="https:\/\/t\.example\/p\.gif"/);
  assert.equal(inb.hasRemoteImages, true);
  assert.deepEqual(inb.attachments, []);
  assert.equal(out.deliveryStatus, 'bounced'); assert.equal(out.status, 'FAILED'); assert.equal(out.authorName, 'Admin A');
  assert.equal(out.retryable, true); assert.equal(out.retryCount, 2); assert.equal(out.maxRetries, 5); assert.equal(out.bouncedAt, null);
  assert.equal(out.bodyText, 'a<b\nc');
  assert.equal(queued.status, 'QUEUED'); assert.equal(queued.deferredUntil, T(90).toISOString());
  // 任何内部字段 / token 都不出现在响应里
  const raw = JSON.stringify(b);
  for (const s of ['secret-msgid', 'sendkeySECRET', 'worker-secret-id', 'idemSECRET', 'hashSECRET', 'authSpf', 'authDkim', 'authDmarc', 'messageId', 'inReplyTo', 'references', 'lockedUntil', 'capDay', 'attempts', 'requestStartedAt'])
    assert.ok(!raw.includes(s), s);
});

test('DB 层 select 白名单：不读 Message-ID / sendKey / Reply-To token / 认证结果等列', async () => {
  for (const k of ['messageId', 'sendKey', 'inReplyTo', 'references', 'remoteMailId', 'idemKey', 'fromHash', 'authSpf', 'authDkim', 'authDmarc', 'lockedUntil', 'requestStartedAt', 'capDay', 'attempts', 'inquiryId'])
    assert.ok(!(k in MAIL_SELECT), k);
  assert.deepEqual(Object.keys(LEGACY_SELECT).sort(), ['authorId', 'bodyHtml', 'createdAt', 'direction', 'id', 'subject']);
  await call(INQ);
  for (const s of selects) for (const k of Object.keys(s)) assert.ok(k in MAIL_SELECT || k in LEGACY_SELECT, k);
});

test('已删除（redacted）条目：不返回发件人、主题、正文', async () => {
  mails.push(mail({ redactedAt: T(5), flags: ['auto'] }));
  const b = await body(await call(INQ));
  const [it] = b.items;
  assert.equal(it.redacted, true);
  for (const k of ['from', 'to', 'subject', 'bodyHtml', 'bodyText', 'senderVerified']) assert.equal(it[k], null, k);
  assert.deepEqual(it.flags, []);
  assert.equal(it.hasRemoteImages, false);
});

test('旧 InquiryMessage 以 source:"legacy" 合并，按时间与新表交错；正文同样净化', async () => {
  legacy.push(leg({ createdAt: T(1), bodyHtml: '<p>old<script>x</script></p>' }), leg({ direction: 'INBOUND', createdAt: T(3), authorId: null }));
  mails.push(mail({ createdAt: T(2) }));
  const b = await body(await call(INQ));
  assert.deepEqual(b.items.map((i) => `${i.source}:${i.direction}`), ['legacy:OUTBOUND', 'mail:INBOUND', 'legacy:INBOUND']);
  const [l1, , l3] = b.items;
  assert.equal(l1.status, 'SENT'); assert.equal(l1.authorName, 'Admin A'); assert.equal(l1.sentAt, T(1).toISOString());
  assert.doesNotMatch(String(l1.bodyHtml), /script/); assert.equal(l1.bodyText, 'old');
  assert.equal(l3.status, 'RECEIVED'); assert.equal(l3.receivedAt, T(3).toISOString()); assert.equal(l3.authorName, null);
  for (const it of b.items) assert.deepEqual(Object.keys(it).sort(), ITEM_KEYS);
});

test('不串询盘：其他询盘的新表 / 旧表记录不出现；未归类 / 已忽略状态不出现', async () => {
  mails.push(mail({ subject: 'mine' }), mail({ inquiryId: OTHER, subject: 'theirs' }), mail({ inquiryId: null, status: 'UNASSIGNED', subject: 'loose' }), mail({ status: 'IGNORED', subject: 'ignored' }));
  legacy.push(leg({ inquiryId: OTHER, subject: 'their-legacy' }));
  const b = await body(await call(INQ));
  assert.deepEqual(b.items.map((i) => i.subject), ['mine']);
  const o = await body(await call(OTHER));
  assert.deepEqual(o.items.map((i) => i.subject).sort(), ['their-legacy', 'theirs']);
});

test('limit：默认 20，上限 50；0 / 51 / -1 / abc / 1.5 → 400 invalid', async () => {
  for (let i = 0; i < 60; i++) mails.push(mail({ createdAt: T(i) }));
  const d = await body(await call(INQ));
  assert.equal(d.items.length, 20);
  const max = await body(await call(INQ, '?limit=50'));
  assert.equal(max.items.length, 50);
  assert.ok(max.nextCursor);
  // 第一页是最新的 50 条（前端只拉第一页，仍能看到最新来信）
  assert.equal(max.items[max.items.length - 1].createdAt, T(59).toISOString());
  for (const l of ['0', '51', '-1', 'abc', '1.5', '', '1000']) {
    const r = await call(INQ, `?limit=${encodeURIComponent(l)}`);
    assert.equal(r.status, 400, l);
    assert.deepEqual(await r.json(), { error: 'invalid', fields: { limit: 'bad_format' } });
  }
});

test('cursor：非法 → 400；合法游标往更早翻页', async () => {
  for (const c of ['x', 'not*base64', Buffer.from('v1|bad|m|cmmail000000000000000001').toString('base64url'), Buffer.from(`v2|${T(1).toISOString()}|m|cmmail000000000000000001`).toString('base64url'),
    Buffer.from(`v1|${T(1).toISOString()}|z|cmmail000000000000000001`).toString('base64url'), Buffer.from(`v1|${T(1).toISOString()}|m|BAD`).toString('base64url'), 'a'.repeat(300)]) {
    const r = await call(INQ, `?cursor=${encodeURIComponent(c)}`);
    assert.equal(r.status, 400, c);
    assert.deepEqual(await r.json(), { error: 'invalid', fields: { cursor: 'bad_format' } });
  }
  assert.equal(decodeThreadCursor(encodeThreadCursor({ at: T(1), source: 'legacy', id: 'cmlegacy0000000000000001' }))?.source, 'legacy');
  assert.equal(parseThreadQuery(new URLSearchParams('')).ok, true);
});

test('复合游标 (createdAt, source, id)：同一时刻的 mail 与 legacy 行跨页恰好各出现一次、顺序稳定', async () => {
  // 5 条同一毫秒：3 mail + 2 legacy，另加前后各一条
  mails.push(mail({ createdAt: T(9), subject: 'after' }));
  for (let i = 0; i < 3; i++) mails.push(mail({ createdAt: T(5), subject: `m${i}` }));
  for (let i = 0; i < 2; i++) legacy.push(leg({ createdAt: T(5), subject: `l${i}` }));
  legacy.push(leg({ createdAt: T(1), subject: 'before' }));
  const all = await body(await call(INQ, '?limit=50'));
  const expected = all.items.map((i) => i.id);
  assert.equal(expected.length, 7);
  assert.deepEqual(all.items.map((i) => i.subject), ['before', 'l0', 'l1', 'm0', 'm1', 'm2', 'after']);
  for (const size of [1, 2, 3, 4]) {
    const seen: string[][] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 20; n++) {
      const b = await body(await call(INQ, `?limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      seen.unshift(b.items.map((i) => i.id as string));
      cursor = b.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(seen.flat(), expected, `limit=${size}`);
    assert.equal(new Set(seen.flat()).size, expected.length);
  }
});
