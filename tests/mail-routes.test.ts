import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import * as authStub from './fixtures/auth-stub';
import { createMailDb } from './fixtures/mail-db';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit';

// '@/auth' 换成测试桩；prisma 换成内存库
const authFile = path.resolve('src/auth.ts');
const m = new Module(authFile); m.filename = authFile; m.loaded = true; m.exports = authStub;
(createRequire(authFile).cache as Record<string, unknown>)[authFile] = m;

const INQ = 'cminquiry00000000000003';
const TOKEN = 'tokenBBBBBBBBBBBBBBBBBBB';
const admin = { id: 'a1', role: 'ADMIN', disabled: false, totpEnabled: true, lockedUntil: null, sessionVersion: 1 };
let mem: ReturnType<typeof createMailDb>;
const g = globalThis as { prisma?: unknown; __testSession?: unknown };
function resetDb() {
  mem = createMailDb({ inquiries: [{ id: INQ, ref: 'PJ-1', replyToken: TOKEN, anonymizedAt: null, assigneeId: null, retainUntil: new Date(), contact: { email: 'buyer@customer.example' } }] });
  Object.assign(mem.db, {
    user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === admin.id ? admin : null) },
    auditLog: { create: async () => ({}) },
  });
  g.prisma = new Proxy({}, { get: (_t, k) => (mem.db as Record<string | symbol, unknown>)[k] });
}
resetDb();
g.__testSession = { user: { id: 'a1' }, sv: 1 };

const SECRET = 'w'.repeat(40); // 假的 webhook 密钥
const MAIL_ENV = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'fake-user@example.test', SMTP_PASS: 'fake-pass', MAIL_FROM: 'PackJoyU <s@gmail.example>', REPLY_DOMAIN: 'geiom.example', MAIL_SEND_ADAPTER: 'mock', APP_ENV: 'test', MAIL_WEBHOOK_SECRET: SECRET, CRON_SECRET: 'c'.repeat(40) };

type H = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
let routes: Record<string, { GET?: H; POST?: H }> = {};
before(async () => {
  routes = {
    config: await import('../src/app/api/admin/mail/config/route'),
    status: await import('../src/app/api/admin/mail/[messageId]/status/route'),
    retry: await import('../src/app/api/admin/mail/[messageId]/retry/route'),
    send: await import('../src/app/api/admin/inquiries/[id]/mail/route'),
    webhook: await import('../src/app/api/mail/inbound-webhook/route'),
    cron: await import('../src/app/api/admin/cron/mail-queue/route'),
  } as never;
});
beforeEach(() => {
  resetDb();
  setRateLimitStore(new MemoryStore());
  Object.assign(process.env, MAIL_ENV, { NEXT_PUBLIC_ADMIN_MAIL: 'http' });
});

const P = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://localhost${url}`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string> = {}) => new Request(`http://localhost${url}`, { headers });

test('邮件开关：未设置 / 空 / off / mock → 所有邮件接口 404（在鉴权之前判断）', async () => {
  for (const v of [undefined, '', 'off', 'mock']) {
    if (v === undefined) delete process.env.NEXT_PUBLIC_ADMIN_MAIL; else process.env.NEXT_PUBLIC_ADMIN_MAIL = v;
    g.__testSession = null; // 未登录也一样是 404，不暴露接口存在
    const rs = [
      await routes.config.GET!(get('/api/admin/mail/config'), P({})),
      await routes.status.GET!(get('/api/admin/mail/x/status'), P({ messageId: 'cmmail000000000000000001' })),
      await routes.retry.POST!(post('/api/admin/mail/x/retry', {}), P({ messageId: 'cmmail000000000000000001' })),
      await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 's', body: 'b' }), P({ id: INQ })),
      await routes.webhook.POST!(post('/api/mail/inbound-webhook', {}), P({})),
      await routes.cron.GET!(get('/api/admin/cron/mail-queue', { authorization: `Bearer ${'c'.repeat(40)}` }), P({})),
    ];
    for (const r of rs) { assert.equal(r.status, 404, String(v)); assert.deepEqual(await r.json(), { error: 'not_found' }); }
  }
  g.__testSession = { user: { id: 'a1' }, sv: 1 };
});

test('静态检查：src/app/api/admin/mail/** 下每个路由、发信路由、webhook、邮件 cron 都先调用 mailSwitchGate()', async () => {
  async function walk(d: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out.push(...await walk(p)); else if (e.name === 'route.ts') out.push(p);
    }
    return out;
  }
  const files = [...await walk('src/app/api/admin/mail'), 'src/app/api/admin/inquiries/[id]/mail/route.ts', 'src/app/api/mail/inbound-webhook/route.ts', 'src/app/api/admin/cron/mail-queue/route.ts'];
  assert.ok(files.length >= 6);
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    const bodies = src.split(/export async function (?:GET|POST|DELETE|PUT|PATCH)\(|async function handle\(/).slice(1);
    assert.ok(bodies.length >= 1, f);
    for (const b of bodies) assert.match(b, /^[^\n]*\{\n\s*const off = mailSwitchGate\(\);\n\s*if \(off\) return off;/, `${f}: mailSwitchGate must be first`);
  }
});

test('GET /mail/config → sendingEnabled 由配置决定', async () => {
  assert.deepEqual(await (await routes.config.GET!(get('/api/admin/mail/config'), P({}))).json(), { sendingEnabled: true });
  process.env.SMTP_PORT = '25';
  assert.deepEqual(await (await routes.config.GET!(get('/api/admin/mail/config'), P({}))).json(), { sendingEnabled: false });
});

test('发信：201；请求体带 to / cc / headers → 400 unknown_field；主题含换行 → 400 newline；关闭发信 → 409 sending_disabled', async () => {
  const ok = await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 'Hello', body: 'Body' }, { 'idempotency-key': '6f1c2a8e-1111-4222-8333-944455556666' }), P({ id: INQ }));
  assert.equal(ok.status, 201);
  const b = await ok.json();
  assert.equal(b.status, 'SENT'); assert.equal(mem.mails[0].toAddr, 'buyer@customer.example');
  for (const extra of [{ to: 'attacker@evil.example' }, { cc: 'x@evil.example' }, { headers: { Bcc: 'x' } }, { attachments: [] }]) {
    const r = await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 's', body: 'b', ...extra }), P({ id: INQ }));
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'invalid', fields: { [Object.keys(extra)[0]]: 'unknown_field' } });
  }
  const nl = await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 'Hi\r\nBcc: x@evil.example', body: 'b' }), P({ id: INQ }));
  assert.deepEqual([nl.status, await nl.json()], [400, { error: 'invalid', fields: { subject: 'newline' } }]);
  const long = await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 'x'.repeat(201), body: 'b' }), P({ id: INQ }));
  assert.deepEqual(await long.json(), { error: 'invalid', fields: { subject: 'too_long' }, limits: { subject: 200 } });
  assert.equal(mem.mails.length, 1);
  delete process.env.SMTP_PASS;
  const off = await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 's', body: 'b' }), P({ id: INQ }));
  assert.deepEqual([off.status, await off.json()], [409, { error: 'sending_disabled' }]);
});

test('状态接口返回 8.3a 结构；每日上限满 → 202 QUEUED + deferredUntil，状态接口也带 deferredUntil', async () => {
  process.env.MAIL_DAILY_CAP = '1';
  try {
    await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 's', body: 'b' }), P({ id: INQ }));
    const r = await routes.send.POST!(post(`/api/admin/inquiries/${INQ}/mail`, { subject: 's', body: 'b' }), P({ id: INQ }));
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.equal(body.errorCode, 'daily_cap_deferred'); assert.match(body.deferredUntil, /T\d\d:00:00\.000Z$/);
    const st = await (await routes.status.GET!(get('/x'), P({ messageId: body.id }))).json();
    assert.deepEqual(Object.keys(st).sort(), ['deferredUntil', 'deliveryStatus', 'errorCode', 'id', 'maxRetries', 'retryCount', 'retryable', 'sentAt', 'status']);
    assert.equal(st.status, 'QUEUED');
  } finally { delete process.env.MAIL_DAILY_CAP; }
});

// —— 收信 webhook ——
const RAW = [
  'Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=buyer@customer.example; dkim=pass header.d=customer.example; dmarc=pass',
  'From: Buyer <buyer@customer.example>', `To: reply+${TOKEN}@geiom.example`, 'Subject: Re: quote', 'Message-ID: <in-1@customer.example>',
  'Content-Type: text/html; charset=utf-8', '', '<p>Hi<script>alert(1)</script></p><img src="https://t.example/p.gif">',
].join('\r\n');
function signed(id: string, raw: string, opts: { ts?: number; secret?: string; idHeader?: string } = {}) {
  const body = JSON.stringify({ id, raw, from: 'forged@evil.example', subject: 'forged' });
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(`${ts}.${opts.idHeader ?? id}.${body}`).digest('hex');
  return new Request('http://localhost/api/mail/inbound-webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), 'x-geiom-timestamp': ts, 'x-geiom-mail-id': opts.idHeader ?? id, 'x-geiom-signature': sig }, body });
}

test('webhook：签名正确 → 200 入库到询盘（按 raw 解析、净化，忽略 Worker 字段）；重复推送 → duplicate，不产生第二行', async () => {
  const r = await routes.webhook.POST!(signed('w-1', RAW), P({}));
  assert.equal(r.status, 200);
  assert.equal(mem.mails.length, 1);
  const row = mem.mails[0];
  assert.equal(row.inquiryId, INQ); assert.equal(row.status, 'RECEIVED'); assert.equal(row.fromAddr, 'buyer@customer.example');
  assert.equal(row.subject, 'Re: quote'); assert.ok(!row.bodyHtml.includes('script')); assert.equal(row.hasRemoteImages, true);
  assert.equal(row.senderVerified, true);
  const again = await routes.webhook.POST!(signed('w-1', RAW), P({}));
  assert.equal(again.status, 200); assert.equal((await again.json()).duplicate, true);
  assert.equal(mem.mails.length, 1);
});

test('webhook：缺头 / 签名错 / 密钥错 / 时间差 > 5 分钟 / 头和体 id 不一致 → 一律 401；没配密钥 → 404；超体积 → 413', async () => {
  const bad = [
    signed('w-2', RAW, { secret: 'x'.repeat(40) }),
    signed('w-2', RAW, { ts: Math.floor(Date.now() / 1000) - 301 }),
    signed('w-2', RAW, { ts: Math.floor(Date.now() / 1000) + 301 }),
    signed('w-2', RAW, { idHeader: 'w-3' }),
    new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  ];
  for (const req of bad) { const r = await routes.webhook.POST!(req, P({})); assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: 'unauthorized' }); }
  const tampered = signed('w-2', RAW);
  const body = (await tampered.clone().text()).replace('Re: quote', 'Re: quotX');
  const r2 = await routes.webhook.POST!(new Request(tampered.url, { method: 'POST', headers: tampered.headers, body }), P({}));
  assert.equal(r2.status, 401);
  assert.equal(mem.mails.length, 0);
  delete process.env.MAIL_WEBHOOK_SECRET;
  assert.equal((await routes.webhook.POST!(signed('w-2', RAW), P({}))).status, 404);
});

test('webhook：写库失败 → 503（Worker 重试）；之后同一签名重推成功入库（防重放不丢信）', async () => {
  const orig = mem.db.$transaction;
  mem.db.$transaction = async () => { throw Object.assign(new Error('db down'), { name: 'PrismaClientInitializationError' }); };
  const first = signed('w-9', RAW);
  const sameSig = new Request(first.url, { method: 'POST', headers: first.headers, body: await first.clone().text() });
  const r = await routes.webhook.POST!(first, P({}));
  assert.equal(r.status, 503);
  mem.db.$transaction = orig;
  // Worker 用同一签名重推：签名已见过但还没入库 → 照常处理，不因防重放丢信
  const again = await routes.webhook.POST!(sameSig, P({}));
  assert.deepEqual([again.status, await again.json()], [200, { ok: true }]);
  assert.equal(mem.mails.length, 1);
});

test('cron 邮件队列：需要 CRON_SECRET', async () => {
  assert.equal((await routes.cron.GET!(get('/x', { authorization: 'Bearer wrong' }), P({}))).status, 401);
  const ok = await routes.cron.GET!(get('/x', { authorization: `Bearer ${'c'.repeat(40)}` }), P({}));
  assert.deepEqual(await ok.json(), { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 });
});

// —— 审查要求：先验头再读体；411/413；限流 429 ——
/** 只有 headers 和一个“被读就记一笔”的 body；用来断言请求体从未被读取 */
function spyReq(headers: Record<string, string>) {
  const spy = { reads: 0 };
  const touch = () => { spy.reads++; throw new Error('body must not be read'); };
  const req = {
    url: 'http://localhost/api/mail/inbound-webhook', method: 'POST', headers: new Headers(headers),
    get body() { return touch(); }, get bodyUsed() { return false; },
    text: touch, json: touch, arrayBuffer: touch, blob: touch, formData: touch, clone: touch,
  } as unknown as Request;
  return { req, spy };
}
const goodHeaders = (over: Record<string, string | undefined> = {}) => {
  const h: Record<string, string | undefined> = {
    'content-type': 'application/json', 'content-length': '100', 'x-geiom-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-geiom-mail-id': 'w-spy', 'x-geiom-signature': 'a'.repeat(64), ...over,
  };
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v !== undefined)) as Record<string, string>;
};

test('webhook：鉴权头缺失 / 格式错 / 超时窗 → 401，且请求体从未被读取（body 流 spy）', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    goodHeaders({ 'x-geiom-signature': undefined }), goodHeaders({ 'x-geiom-timestamp': undefined }), goodHeaders({ 'x-geiom-mail-id': undefined }),
    goodHeaders({ 'x-geiom-signature': 'zz' + 'a'.repeat(62) }), goodHeaders({ 'x-geiom-signature': 'a'.repeat(63) }),
    goodHeaders({ 'x-geiom-timestamp': String(now - 301) }), goodHeaders({ 'x-geiom-timestamp': String(now + 301) }), goodHeaders({ 'x-geiom-timestamp': 'abc' }),
    goodHeaders({ 'x-geiom-mail-id': 'bad id with spaces' }), goodHeaders({ 'content-type': 'text/plain' }),
    {},
  ];
  for (const h of cases) {
    const { req, spy } = spyReq(h);
    const r = await routes.webhook.POST!(req, P({}));
    assert.equal(r.status, 401, JSON.stringify(h)); assert.deepEqual(await r.json(), { error: 'unauthorized' });
    assert.equal(spy.reads, 0, 'body read before auth');
  }
});

test('webhook：缺 Content-Length → 411；Content-Length > 36,700,160 → 413，都不读请求体', async () => {
  for (const [h, status] of [
    [goodHeaders({ 'content-length': undefined }), 411], [goodHeaders({ 'content-length': '-1' }), 411],
    [goodHeaders({ 'content-length': '36700161' }), 413], [goodHeaders({ 'content-length': String(1e12) }), 413],
  ] as const) {
    const { req, spy } = spyReq(h);
    const r = await routes.webhook.POST!(req, P({}));
    assert.equal(r.status, status); assert.equal(spy.reads, 0);
  }
});

test('webhook：Content-Length 谎报偏小 → 流式读取超过上限即中止 → 413', async () => {
  let pulled = 0, cancelled = false;
  const chunk = new Uint8Array(4 * 1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; if (pulled > 20) c.close(); else c.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const req = new Request('http://localhost/api/mail/inbound-webhook', { method: 'POST', headers: goodHeaders({ 'content-length': '100' }), body: stream, duplex: 'half' } as RequestInit);
  const r = await routes.webhook.POST!(req, P({}));
  assert.equal(r.status, 413);
  assert.ok(cancelled, 'stream cancelled'); assert.ok(pulled <= 11, `read stopped early (pulled ${pulled})`);
});

test('webhook 限流：同一来源超过每分钟上限 → 429；拿不到可信 IP 的请求进更严的 untrusted 桶', async () => {
  const { WEBHOOK_RATE } = await import('../src/lib/server/mail/inbound');
  assert.ok(WEBHOOK_RATE.untrusted < WEBHOOK_RATE.perSource);
  // 未设 BEHIND_CLOUDFLARE / TRUSTED_PROXY_HOPS 时 clientIp() 视部署而定；这里显式走 Cloudflare 模式拿到来源 IP
  process.env.BEHIND_CLOUDFLARE = '1';
  try {
    const statuses: number[] = [];
    for (let i = 0; i < WEBHOOK_RATE.perSource + 1; i++) {
      const { req } = spyReq(goodHeaders({ 'x-geiom-signature': undefined, 'cf-connecting-ip': '203.0.113.7' }));
      statuses.push((await routes.webhook.POST!(req, P({}))).status);
    }
    assert.equal(statuses.filter((s) => s === 401).length, WEBHOOK_RATE.perSource);
    const last = await routes.webhook.POST!(spyReq(goodHeaders({ 'cf-connecting-ip': '203.0.113.7' })).req, P({}));
    assert.equal(last.status, 429); assert.equal(last.headers.get('retry-after'), '60');
    assert.deepEqual(await last.json(), { error: 'rate_limited', retryAfter: 60 });
    // 别的来源不受影响
    assert.equal((await routes.webhook.POST!(spyReq(goodHeaders({ 'x-geiom-signature': undefined, 'cf-connecting-ip': '198.51.100.9' })).req, P({}))).status, 401);
    // 无可信 IP（Cloudflare 模式下缺 cf-connecting-ip）→ untrusted 桶，上限更低
    const un: number[] = [];
    for (let i = 0; i < WEBHOOK_RATE.untrusted + 1; i++) un.push((await routes.webhook.POST!(spyReq(goodHeaders({ 'x-geiom-signature': undefined })).req, P({}))).status);
    assert.equal(un.filter((s) => s === 401).length, WEBHOOK_RATE.untrusted);
    assert.equal(un.at(-1), 429);
  } finally { delete process.env.BEHIND_CLOUDFLARE; }
});

// —— 审查：HMAC 覆盖时间戳 + 体；所有 401 相同、日志只记原因码；签名 / Message-ID 防重放 ——
test('HMAC 覆盖时间戳和请求体：只改时间戳（仍在窗口内）或只改体 → 401', async () => {
  const req = signed('w-ts', RAW);
  const ts = Number(req.headers.get('x-geiom-timestamp'));
  const h = new Headers(req.headers); h.set('x-geiom-timestamp', String(ts - 1));
  const body = await req.text();
  assert.equal((await routes.webhook.POST!(new Request(req.url, { method: 'POST', headers: h, body }), P({}))).status, 401);
  assert.equal(mem.mails.length, 0);
});

test('所有 401 完全相同（状态 / 体 / 头）；日志只有原因码，不含请求内容', async () => {
  const origWarn = console.warn; const logs: string[] = [];
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try {
    const now = Math.floor(Date.now() / 1000);
    const good = signed('w-401', RAW);
    const goodBody = await good.clone().text();
    const withHeaders = (over: Record<string, string | null>, body = goodBody) => {
      const h = new Headers(good.headers);
      for (const [k, v] of Object.entries(over)) { if (v === null) h.delete(k); else h.set(k, v); }
      h.set('content-length', String(Buffer.byteLength(body)));
      return new Request(good.url, { method: 'POST', headers: h, body });
    };
    // 体不是合法 JSON / id 不一致：签名按篡改后的体重新算（证明是“签名通过之后”的失败也同样 401）
    const resign = (body: string, id = 'w-401') => {
      const ts = String(now);
      const sig = createHmac('sha256', SECRET).update(`${ts}.${id}.${body}`).digest('hex');
      return withHeaders({ 'x-geiom-timestamp': ts, 'x-geiom-mail-id': id, 'x-geiom-signature': sig }, body);
    };
    const cases: [string, Request][] = [
      ['missing_header', withHeaders({ 'x-geiom-signature': null })],
      ['bad_format', withHeaders({ 'x-geiom-signature': 'nothex' })],
      ['expired', withHeaders({ 'x-geiom-timestamp': String(now - 600) })],
      ['bad_content_type', withHeaders({ 'content-type': 'text/plain' })],
      ['bad_signature', withHeaders({ 'x-geiom-signature': 'b'.repeat(64) })],
      ['bad_body', resign('not json')],
      ['id_mismatch', resign(JSON.stringify({ id: 'other', raw: RAW }))],
    ];
    const seen = new Set<string>();
    for (const [reason, req] of cases) {
      logs.length = 0;
      const r = await routes.webhook.POST!(req, P({}));
      const headers = [...r.headers.entries()].filter(([k]) => k !== 'date').sort();
      seen.add(JSON.stringify([r.status, await r.text(), headers]));
      assert.equal(logs.length, 1, reason);
      assert.match(logs[0], new RegExp(`mail\\.webhook_unauthorized.*"reason":"${reason}"`));
      for (const leak of ['buyer@customer.example', 'Re: quote', 'w-401', 'bbbb', 'not json']) assert.ok(!logs[0].includes(leak), `log leaked ${leak}`);
    }
    assert.equal(seen.size, 1, 'every 401 identical');
    assert.deepEqual(JSON.parse([...seen][0])[0], 401);
    assert.equal(mem.mails.length, 0);
  } finally { console.warn = origWarn; }
});

test('防重放：同一签名请求再推一次 → 200 duplicate，不解析不写库；不同 Worker id 但同一 Message-ID → 200 duplicate，不写库', async () => {
  let creates = 0;
  const orig = mem.db.mailMessage.create;
  mem.db.mailMessage.create = (async (a: never) => { creates++; return orig(a); }) as never;
  const req = signed('w-rp', RAW);
  const replay = new Request(req.url, { method: 'POST', headers: req.headers, body: await req.clone().text() });
  assert.equal((await routes.webhook.POST!(req, P({}))).status, 200);
  const r2 = await routes.webhook.POST!(replay, P({}));
  assert.deepEqual([r2.status, await r2.json()], [200, { ok: true, duplicate: true }]);
  const r3 = await routes.webhook.POST!(signed('w-rp-2', RAW), P({}));
  assert.deepEqual([r3.status, await r3.json()], [200, { ok: true, duplicate: true }]);
  assert.equal(creates, 1); assert.equal(mem.mails.length, 1);
  mem.db.mailMessage.create = orig;
});
