import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMockAdapter } from '../src/lib/server/mail/mock';
import { retryMail, sendInquiryMail, responseFor } from '../src/lib/server/mail/send';
import { createMailDb } from './fixtures/mail-db';

// #344：发信 / 重试成功的 201 响应不带 messageId（Message-ID 的本地部分就是 sendKey）
const ENV = { NEXT_PUBLIC_ADMIN_MAIL: 'http', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'fake-user@example.test', SMTP_PASS: 'fake-pass', MAIL_FROM: 'PackJoyU <sender@gmail.example>', REPLY_DOMAIN: 'geiom.example' };
const INQ = 'cminquiry00000000000001';
const inquiry = { id: INQ, replyToken: 'tokenAAAAAAAAAAAAAAAAAAA', anonymizedAt: null, assigneeId: null, retainUntil: new Date(), contact: { email: 'buyer@customer.example' } };
const KEYS_201 = ['id', 'maxRetries', 'retryCount', 'sentAt', 'status'];

function setup(script: Parameters<typeof createMockAdapter>[0] = []) {
  const m = createMailDb({ inquiries: [inquiry] });
  const adapter = createMockAdapter(script);
  const deps = { db: m.db as never, adapter, env: ENV, now: () => new Date('2026-10-16T10:00:00Z'), alert: async () => {}, audit: async () => {} };
  return { ...m, adapter, deps };
}
const quiet = async <T>(fn: () => Promise<T>) => { const e = console.error, i = console.info; console.error = () => {}; console.info = () => {}; try { return await fn(); } finally { console.error = e; console.info = i; } };
function assertNoMessageId(body: unknown, sendKey: string) {
  assert.deepEqual(Object.keys(body as object).sort(), KEYS_201);
  const json = JSON.stringify(body);
  assert.ok(!json.includes(sendKey), 'sendKey leaked');
  assert.ok(!json.includes('geiom.example') && !json.includes('<'), 'Message-ID leaked');
}

test('#344 send 201: body has no messageId / sendKey', async () => {
  const s = setup();
  const r = await quiet(() => sendInquiryMail(s.deps, { userId: 'admin1', inquiryId: INQ, scope: {}, subject: 'Re: quote', body: 'Hello' }));
  assert.equal(r.status, 201);
  const sendKey = s.adapter.sent[0].sendKey;
  assert.ok(sendKey && s.mails[0].messageId?.includes(sendKey), 'Message-ID still generated and stored server-side');
  assertNoMessageId(r.body, sendKey);
  // 幂等重放 / 并发时按当前状态回给客户端（responseFor）也一样
  assertNoMessageId(responseFor(s.mails[0] as never).body, sendKey);
});

test('#344 retry 201: body has no messageId / sendKey', async () => {
  const s = setup([{ ok: false, reason: 'provider_throttled', retryable: true, code: '421', alert: false }]);
  const first = await quiet(() => sendInquiryMail(s.deps, { userId: 'admin1', inquiryId: INQ, scope: {}, subject: 'Re: quote', body: 'Hello' }));
  assert.equal(first.status, 502);
  const r = await quiet(() => retryMail(s.deps, { userId: 'admin1', messageId: s.mails[0].id, scope: {} }));
  assert.equal(r.status, 201);
  assertNoMessageId(r.body, s.adapter.sent[1].sendKey);
});

test('#344 frontend does not read messageId from the send / retry response', () => {
  const src = readFileSync('src/lib/admin/mail/http.ts', 'utf8');
  assert.ok(!/\.messageId\b/.test(src), 'frontend reads messageId');
});
