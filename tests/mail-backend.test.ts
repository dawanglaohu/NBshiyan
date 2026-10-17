import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { capWindow, dailyCap, mailApiEnabled, smtpBaseConfig, smtpConfig, sendingEnabled, mockAdapterAllowed } from '../src/lib/server/mail/config';
import { classifySmtpError, headerInjection, mailLog, redactedError } from '../src/lib/server/mail/adapter';
import { createSmtpAdapter, smtpTransportOptions } from '../src/lib/server/mail/smtp';
import { createMockAdapter } from '../src/lib/server/mail/mock';
import { findInquiryRecipient, processMailQueue, retryMail, sendInquiryMail, statusBody } from '../src/lib/server/mail/send';
import { createMailDb } from './fixtures/mail-db';

// 全是假值：测试里不出现任何真实凭据；SMTP 一律用 mock 传输，不连网络
const FAKE_USER = 'fake-smtp-user@example.test';
const FAKE_PASS = 'fake-app-password-xyz';
const ENV = { NEXT_PUBLIC_ADMIN_MAIL: 'http', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: FAKE_USER, SMTP_PASS: FAKE_PASS, MAIL_FROM: 'PackJoyU <sender@gmail.example>', REPLY_DOMAIN: 'geiom.example' };
const INQ = 'cminquiry00000000000001';
const TOKEN = 'tokenAAAAAAAAAAAAAAAAAAA';
const inquiry = (o: Record<string, unknown> = {}) => ({ id: INQ, replyToken: TOKEN, anonymizedAt: null, assigneeId: null, retainUntil: new Date(), contact: { email: 'buyer@customer.example' }, ...o });

let logs: string[] = [];
const origErr = console.error, origInfo = console.info, origWarn = console.warn, origLog = console.log;
beforeEach(() => {
  logs = [];
  const cap = (...a: unknown[]) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, Object.getOwnPropertyNames(x ?? {})))).join(' ')); };
  console.error = cap; console.info = cap; console.warn = cap; console.log = cap;
});
afterEach(() => { console.error = origErr; console.info = origInfo; console.warn = origWarn; console.log = origLog; });

function setup(opts: { inquiries?: Record<string, unknown>[]; adapter?: ReturnType<typeof createMockAdapter>; env?: Record<string, string>; now?: Date } = {}) {
  const m = createMailDb({ inquiries: opts.inquiries ?? [inquiry()] });
  const adapter = opts.adapter ?? createMockAdapter();
  const alerts: { kind: string; lines: Record<string, string | number>; key: string }[] = [];
  const audits: { action: string; meta?: unknown }[] = [];
  let now = opts.now ?? new Date('2026-10-16T10:00:00Z');
  const deps = {
    db: m.db as never, adapter, env: { ...ENV, ...opts.env }, now: () => now,
    alert: async (kind: string, lines: Record<string, string | number>, key: string) => { alerts.push({ kind, lines, key }); },
    audit: async (e: { action: string; meta?: unknown }) => { audits.push(e); },
  };
  return { ...m, adapter, alerts, audits, deps, setNow: (d: Date) => { now = d; } };
}
const send = (s: ReturnType<typeof setup>, o: Record<string, unknown> = {}) =>
  sendInquiryMail(s.deps, { userId: 'admin1', inquiryId: INQ, scope: {}, subject: 'Re: your inquiry', body: 'Hello\nworld', ...o });

// —— 1. TLS 强制 ——
test('TLS: 465 → secure:true；587 → requireTLS:true；其他端口 / 关证书校验 → insecure_tls；从不出现 rejectUnauthorized:false', () => {
  const c465 = smtpBaseConfig({ ...ENV, SMTP_PORT: '465' });
  assert.ok(c465.ok); const o465 = smtpTransportOptions(c465.cfg);
  assert.equal(o465.secure, true); assert.equal(o465.requireTLS, false);
  const c587 = smtpBaseConfig(ENV);
  assert.ok(c587.ok); const o587 = smtpTransportOptions(c587.cfg);
  assert.equal(o587.secure, false); assert.equal(o587.requireTLS, true); assert.equal(o587.ignoreTLS, false);
  for (const o of [o465, o587]) {
    assert.ok(!('rejectUnauthorized' in (o.tls ?? {})), 'never disables cert verification');
    assert.equal((o.tls as { minVersion?: string }).minVersion, 'TLSv1.2');
  }
  for (const port of ['25', '2525', '0', 'abc', '']) assert.deepEqual(smtpBaseConfig({ ...ENV, SMTP_PORT: port }).ok, false, port);
  assert.deepEqual(smtpBaseConfig({ ...ENV, SMTP_PORT: '25' }), { ok: false, error: 'insecure_tls' });
  assert.deepEqual(smtpBaseConfig({ ...ENV, NODE_TLS_REJECT_UNAUTHORIZED: '0' }), { ok: false, error: 'insecure_tls' });
  // 手工拼出不一致的组合也会被拒（防止以后有人改坏 config）
  assert.throws(() => smtpTransportOptions({ ...c587.cfg, requireTLS: false }), /insecure_tls/);
  assert.throws(() => smtpTransportOptions({ ...c465.cfg, secure: false }), /insecure_tls/);
  assert.throws(() => smtpTransportOptions({ ...c587.cfg, port: 25 as never }), /insecure_tls/);
});

test('配置：缺项 → 发信关闭；From 不能用 REPLY_DOMAIN；开关只认 http', () => {
  assert.equal(sendingEnabled(ENV), true);
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'REPLY_DOMAIN']) assert.equal(sendingEnabled({ ...ENV, [k]: '' }), false, k);
  assert.deepEqual(smtpConfig({ ...ENV, MAIL_FROM: 'PackJoyU <no-reply@geiom.example>' }), { ok: false, error: 'bad_from' });
  assert.deepEqual(smtpConfig({ ...ENV, MAIL_FROM: 'x@y.z\r\nBcc: e@evil.example' }), { ok: false, error: 'bad_from' });
  for (const v of [undefined, '', 'off', 'mock', 'HTTP', 'true']) { assert.equal(mailApiEnabled({ NEXT_PUBLIC_ADMIN_MAIL: v }), false, String(v)); assert.equal(sendingEnabled({ ...ENV, NEXT_PUBLIC_ADMIN_MAIL: v as string }), false); }
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock' }), false, 'APP_ENV 未设 → 不用 mock');
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock', APP_ENV: 'production' }), false);
  assert.equal(mockAdapterAllowed({ MAIL_SEND_ADAPTER: 'mock', APP_ENV: 'development' }), true);
  assert.equal(dailyCap({}), 450); assert.equal(dailyCap({ MAIL_DAILY_CAP: '10' }), 10); assert.equal(dailyCap({ MAIL_DAILY_CAP: '-1' }), 450);
});

// —— 2. nodemailer 日志关闭、错误脱敏 ——
test('nodemailer logger / debug 关闭；SMTP 错误日志只留码，不含原始响应、命令参数和凭据', async () => {
  const opts = smtpTransportOptions((smtpBaseConfig(ENV) as { ok: true; cfg: never }).cfg);
  assert.equal(opts.logger, false); assert.equal(opts.debug, false);
  const secretErr = Object.assign(new Error(`Invalid login: 535-5.7.8 Username and Password not accepted for ${FAKE_USER} ${FAKE_PASS}`), {
    code: 'EAUTH', responseCode: 535, response: `535-5.7.8 Username and Password not accepted ${FAKE_USER}`, command: 'AUTH PLAIN AGZha2UtdXNlcgBmYWtlLXBhc3M=',
  });
  const adapter = createSmtpAdapter((smtpBaseConfig(ENV) as { ok: true; cfg: never }).cfg, { createTransport: () => ({ sendMail: async () => { throw secretErr; } }) });
  const s = setup({ adapter: adapter as never });
  const r = await send(s);
  assert.equal(r.status, 502);
  const dump = logs.join('\n') + JSON.stringify(s.alerts) + JSON.stringify(s.audits) + JSON.stringify(r) + JSON.stringify(s.mails.map((m) => m.errorCode));
  for (const leak of [FAKE_USER, FAKE_PASS, 'AGZha2UtdXNlcgBmYWtlLXBhc3M', 'Username and Password', 'Invalid login']) assert.ok(!dump.includes(leak), `leaked: ${leak}`);
  assert.ok(logs.some((l) => l.includes('"code":"535"')), 'only the code is logged');
  assert.equal(redactedError(secretErr), '535');
  // 通用日志出口：未知键丢掉，长串 / 含空格的值换成 redacted
  mailLog('error', 'mail.test', { mailId: 'abc', response: FAKE_PASS, code: `535 ${FAKE_USER}`, pass: FAKE_PASS });
  const last = logs[logs.length - 1];
  assert.ok(!last.includes(FAKE_PASS) && !last.includes(FAKE_USER) && last.includes('"code":"redacted"'));
});

// —— 3. 头部注入、收件人只来自库 ——
test('头部注入：To / Reply-To / Subject 含 \\r 或 \\n 一律拒绝，不交给传输', async () => {
  let called = 0;
  const adapter = createSmtpAdapter((smtpBaseConfig(ENV) as { ok: true; cfg: never }).cfg, { createTransport: () => ({ sendMail: async () => { called++; return {} as never; } }) });
  const base = { to: 'a@b.example', replyTo: 'reply+x@geiom.example', subject: 'ok', text: 't', html: 'h', messageId: '<k@geiom.example>', sendKey: 'k' };
  for (const bad of [{ to: 'a@b.example\r\nBcc: e@evil.example' }, { replyTo: 'r@x.example\nBcc: e@evil.example' }, { subject: 'Hi\r\nBcc: e@evil.example' }, { subject: 'Hi\nX: y' }, { subject: 'a\0b' }]) {
    const r = await adapter.send({ ...base, ...bad });
    assert.deepEqual(r, { ok: false, reason: 'message_rejected', retryable: false, code: 'header_injection', alert: false });
    assert.ok(headerInjection({ ...base, ...bad }));
  }
  assert.equal(called, 0);
  const s = setup();
  const r = await send(s, { subject: 'Hi\r\nBcc: e@evil.example' });
  assert.equal(r.status, 400); assert.equal(s.mails.length, 0);
});

test('收件人：只取库里询盘联系人邮箱（经 findInquiryForReply）；已匿名化 / [deleted] / 权限外不发', async () => {
  const s = setup();
  const r = await send(s);
  assert.equal(r.status, 201);
  assert.equal(s.adapter.sent[0].to, 'buyer@customer.example');
  assert.equal(s.adapter.sent[0].replyTo, `reply+${TOKEN}@geiom.example`);
  assert.match(s.adapter.sent[0].messageId, /^<[A-Za-z0-9]{24}@geiom\.example>$/);
  for (const inq of [inquiry({ anonymizedAt: new Date() }), inquiry({ contact: { email: '[deleted]' } }), inquiry({ contact: { email: 'deleted+abcd@invalid.invalid' } }), inquiry({ contact: { email: 'a@b.example, c@evil.example' } })]) {
    const s2 = setup({ inquiries: [inq] });
    const r2 = await send(s2);
    assert.equal(r2.status, 409); assert.deepEqual(r2.body, { error: 'anonymized' });
    assert.equal(s2.adapter.sent.length, 0); assert.equal(s2.mails.length, 0);
  }
  const s3 = setup({ inquiries: [inquiry({ assigneeId: 'someone-else' })] });
  assert.equal((await sendInquiryMail(s3.deps, { userId: 'sales1', inquiryId: INQ, scope: { assigneeId: 'sales1' }, subject: 's', body: 'b' })).status, 404);
  assert.equal(await findInquiryRecipient(s3.db as never, INQ, { assigneeId: 'sales1' }), 'not_found');
});

// —— 4. 535 不是 provider_throttled ——
test('错误归类：535 → send_auth（不可重试 + 告警）；421 / 454 / 451 → provider_throttled（可重试）；连接 / DATA 之后 / 5xx / TLS', () => {
  const c = (e: Record<string, unknown>) => classifySmtpError(Object.assign(new Error('x'), e));
  assert.deepEqual(c({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }), { ok: false, reason: 'send_auth', retryable: false, code: '535', alert: true });
  for (const rc of [421, 450, 451, 452, 454]) { const r = c({ responseCode: rc, command: 'MAIL' }); assert.equal(r.reason, 'provider_throttled', String(rc)); assert.equal(r.retryable, true); }
  assert.equal(c({ code: 'EAUTH', responseCode: 454, command: 'AUTH PLAIN' }).reason, 'provider_throttled');
  assert.deepEqual(c({ responseCode: 550, response: '550-5.4.5 Daily user sending limit exceeded', command: 'DATA' }), { ok: false, reason: 'provider_throttled', retryable: true, code: '550', alert: true });
  assert.equal(c({ code: 'ECONNECTION' }).reason, 'send_unavailable');
  assert.equal(c({ code: 'ETIMEDOUT', command: 'CONN' }).reason, 'send_unavailable');
  assert.deepEqual(c({ code: 'ETIMEDOUT', command: 'DATA' }), { ok: false, reason: 'unknown_delivery', retryable: false, code: 'ETIMEDOUT', alert: false });
  assert.equal(c({ code: 'ESOCKET' }).reason, 'unknown_delivery', '阶段不明 → 按可能已送达');
  assert.equal(c({ responseCode: 550, command: 'RCPT TO' }).reason, 'recipient_rejected');
  assert.equal(c({ responseCode: 554, command: 'DATA' }).reason, 'message_rejected');
  assert.deepEqual(c({ code: 'CERT_HAS_EXPIRED' }), { ok: false, reason: 'smtp_tls', retryable: false, code: 'CERT_HAS_EXPIRED', alert: true });
});

test('535：FAILED send_auth、不可重试、发一次运维告警；重试接口返回 409 not_retryable', async () => {
  const s = setup({ adapter: createMockAdapter([{ ok: false, reason: 'send_auth', retryable: false, code: '535', alert: true }]) });
  const r = await send(s);
  assert.deepEqual(r.body, { error: 'mail_failed', id: s.mails[0].id, reason: 'send_auth', retryable: false });
  assert.equal(s.mails[0].status, 'FAILED'); assert.equal(s.mails[0].errorCode, 'send_auth');
  assert.deepEqual(s.alerts.map((a) => [a.key, a.lines]), [['mail-config:send_auth', { 原因: 'send_auth', 响应码: '535' }]]);
  const rr = await retryMail(s.deps, { userId: 'admin1', messageId: s.mails[0].id, scope: {} });
  assert.deepEqual(rr.body, { error: 'not_retryable' });
  assert.equal(s.adapter.sent.length, 1);
});

test('provider_throttled：可重试，重试计 n/5，5 次后 retry_limit；unknown_delivery 不可重试', async () => {
  const fail = { ok: false as const, reason: 'provider_throttled' as const, retryable: true, code: '421', alert: false };
  const s = setup({ adapter: createMockAdapter([fail, fail, fail, fail, fail, fail]) });
  await send(s);
  const id = s.mails[0].id;
  for (let i = 1; i <= 5; i++) { const r = await retryMail(s.deps, { userId: 'admin1', messageId: id, scope: {} }); assert.equal(r.status, 502); assert.equal(s.mails[0].retryCount, i); }
  assert.deepEqual((await retryMail(s.deps, { userId: 'admin1', messageId: id, scope: {} })).body, { error: 'retry_limit' });
  s.mails[0].errorCode = 'unknown_delivery'; s.mails[0].retryCount = 0;
  assert.deepEqual((await retryMail(s.deps, { userId: 'admin1', messageId: id, scope: {} })).body, { error: 'not_retryable' });
});

// —— 5. 每日上限按“信”计数 ——
test('§17 每日上限：满额 → 202 QUEUED daily_cap_deferred + deferredUntil（下一次 00:00 UTC），不调传输、不计 retryCount、告警一次', async () => {
  const s = setup({ env: { MAIL_DAILY_CAP: '2' } });
  assert.equal((await send(s)).status, 201);
  assert.equal((await send(s)).status, 201);
  const r = await send(s);
  assert.deepEqual(r.body, { id: s.mails[2].id, status: 'QUEUED', errorCode: 'daily_cap_deferred', deferredUntil: '2026-10-17T00:00:00.000Z' });
  assert.equal(r.status, 202);
  assert.equal(s.adapter.sent.length, 2);
  assert.equal(s.mails[2].retryCount, 0);
  assert.ok(!('pollAfterMs' in r.body));
  assert.deepEqual(statusBody(s.mails[2] as never).deferredUntil, '2026-10-17T00:00:00.000Z');
  await send(s);
  assert.equal(s.alerts.filter((a) => a.key.startsWith('mail-daily-cap:')).length, 2, 'alert hook deduped by key (sendAdminAlert 30 分钟去重)');
  assert.ok(s.alerts.every((a) => a.key === 'mail-daily-cap:2026-10-16'));
  assert.ok(s.calls.filter((c) => c === 'advisory_lock').length >= 4, '名额检查都在 advisory lock 事务里');
});

test('§17 重试不重复计数：同一条信重试只占一个名额；失败（未送达）的信不占名额，重试时重新检查，绕不过上限', async () => {
  const fail = { ok: false as const, reason: 'provider_throttled' as const, retryable: true, code: '421', alert: false };
  const s = setup({ env: { MAIL_DAILY_CAP: '2' }, adapter: createMockAdapter([fail]) });
  await send(s); // A：失败，不占名额
  assert.equal(s.mails[0].status, 'FAILED');
  assert.equal((await send(s)).status, 201); // B：成功，占 1
  assert.equal((await retryMail(s.deps, { userId: 'admin1', messageId: s.mails[0].id, scope: {} })).status, 201); // A 重试成功，占 2
  assert.equal(s.mails[0].retryCount, 1);
  const c = await send(s); // C：满额
  assert.equal(c.kind, 'deferred');
  // A 再失败（未送达）就释放名额：新信 D 能占到；之后 A 再重试时名额已满 → 延后，不计 retryCount，也不调传输
  s.mails[0].status = 'FAILED'; s.mails[0].retryable = true; s.mails[0].errorCode = 'provider_throttled';
  assert.equal((await send(s)).kind, 'sent');
  const before = s.adapter.sent.length;
  const ra = await retryMail(s.deps, { userId: 'admin1', messageId: s.mails[0].id, scope: {} });
  assert.equal(ra.kind, 'deferred'); assert.equal(s.mails[0].retryCount, 1); assert.equal(s.adapter.sent.length, before);
});

test('§17 unknown_delivery 占名额（可能已送达）；同一 Idempotency-Key 不建第二封、不重复计数', async () => {
  const s = setup({ env: { MAIL_DAILY_CAP: '2' }, adapter: createMockAdapter([{ ok: false, reason: 'unknown_delivery', retryable: false, code: 'ETIMEDOUT', alert: false }]) });
  await send(s);
  const k = '6f1c2a8e-1111-4222-8333-944455556666';
  const a = await send(s, { idempotencyKey: k });
  const b = await send(s, { idempotencyKey: k });
  assert.equal(a.status, 201); assert.deepEqual(b, a);
  assert.equal(s.mails.length, 2);
  assert.equal((await send(s)).kind, 'deferred', 'unknown_delivery + 1 sent = 2 = cap');
});

test('§17 并发：同时 5 封、上限 3 → 恰好 3 封发出（名额检查在同一锁内）', async () => {
  const s = setup({ env: { MAIL_DAILY_CAP: '3' } });
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => send(s)));
  assert.equal(rs.filter((r) => r.kind === 'sent').length, 3);
  assert.equal(rs.filter((r) => r.kind === 'deferred').length, 2);
  assert.equal(s.adapter.sent.length, 3);
});

test('§17 重置后 cron 自动发送延后的信；重置时间可配（MAIL_DAILY_CAP_RESET）', async () => {
  const s = setup({ env: { MAIL_DAILY_CAP: '1' } });
  await send(s); await send(s); await send(s);
  assert.deepEqual(s.mails.map((m) => m.status), ['SENT', 'QUEUED', 'QUEUED']);
  assert.deepEqual(await processMailQueue(s.deps), { stale: 0, sent: 0, failed: 0, deferred: 0, dropped: 0 }, '还没到 deferredUntil');
  s.setNow(new Date('2026-10-17T00:00:05Z'));
  const out = await processMailQueue(s.deps);
  assert.equal(out.sent, 1); assert.equal(out.deferred, 1);
  assert.deepEqual(s.mails.map((m) => m.status), ['SENT', 'SENT', 'QUEUED']);
  assert.equal(s.mails[2].deferredUntil.toISOString(), '2026-10-18T00:00:00.000Z');
  const w = capWindow(new Date('2026-10-16T06:00:00Z'), { MAIL_DAILY_CAP_RESET: '08:00' });
  assert.equal(w.start.toISOString(), '2026-10-15T08:00:00.000Z'); assert.equal(w.end.toISOString(), '2026-10-16T08:00:00.000Z');
});

test('cron：租约过期仍 SENDING → FAILED unknown_delivery（不自动重发）；延后期间被匿名化 → 不再发送', async () => {
  const s = setup({ env: { MAIL_DAILY_CAP: '1' } });
  await send(s); await send(s);
  s.mails[0].status = 'SENDING'; s.mails[0].lockedUntil = new Date('2026-10-16T09:00:00Z');
  s.inquiries[0].anonymizedAt = new Date();
  s.setNow(new Date('2026-10-17T01:00:00Z'));
  const out = await processMailQueue(s.deps);
  assert.equal(out.stale, 1); assert.equal(out.dropped, 1); assert.equal(out.sent, 0);
  assert.equal(s.mails[0].errorCode, 'unknown_delivery'); assert.equal(s.mails[0].retryable, false);
  assert.equal(s.adapter.sent.length, 1);
});

test('发信关闭（SMTP 不全或开关不是 http）→ 409 sending_disabled，不建记录', async () => {
  const s = setup({ env: { SMTP_PASS: '' } });
  assert.deepEqual((await send(s)).body, { error: 'sending_disabled' });
  assert.equal(s.mails.length, 0);
});
