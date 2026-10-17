import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WEBHOOK_MAX_BODY, ingestRaw, parseInbound, senderVerification, verifyWebhookSignature, replyTokens } from '../src/lib/server/mail/inbound';
import { anonymizeInquiriesTx, redactMsgId } from '../src/lib/server/privacy';
import { createMailDb } from './fixtures/mail-db';

const TOKEN = 'tokenCCCCCCCCCCCCCCCCCCC';
const INQ = 'cminquiry00000000000004';
const db = () => createMailDb({ inquiries: [{ id: INQ, replyToken: TOKEN, anonymizedAt: null, retainUntil: new Date(), contact: { email: 'b@c.example' } }] });
const mime = (headers: string[], body = 'hello') => Buffer.from([...headers, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'));
const D = 'geiom.example';

test('签名：常量时间比较，±5 分钟，绑定 mailId 和原始字节', () => {
  const secret = 's'.repeat(40), body = Buffer.from('{"id":"a1","raw":"x"}'), now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const sig = createHmac('sha256', secret).update(`${ts}.a1.`).update(body).digest('hex');
  assert.equal(verifyWebhookSignature({ timestamp: ts, mailId: 'a1', signature: sig }, body, secret, now), true);
  assert.equal(verifyWebhookSignature({ timestamp: ts, mailId: 'a2', signature: sig }, body, secret, now), false);
  assert.equal(verifyWebhookSignature({ timestamp: ts, mailId: 'a1', signature: sig }, Buffer.from(body.toString() + ' '), secret, now), false);
  assert.equal(verifyWebhookSignature({ timestamp: ts, mailId: 'a1', signature: sig }, body, secret, now + 301_000), false);
  assert.equal(verifyWebhookSignature({ timestamp: ts, mailId: 'a1', signature: sig.slice(2) }, body, secret, now), false);
  assert.equal(verifyWebhookSignature({ timestamp: null, mailId: 'a1', signature: sig }, body, secret, now), false);
});

test('Authentication-Results：只信最上面一条且 authserv-id 为 Cloudflare；伪造的下层头不算', () => {
  const h = (v: string[]) => v.map((value) => ({ key: 'authentication-results', value }));
  assert.equal(senderVerification(h(['mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass'])).verified, true);
  assert.equal(senderVerification(h(['mx.cloudflare.net; spf=pass; dkim=fail; dmarc=pass'])).verified, false);
  assert.equal(senderVerification(h(['evil.example; spf=pass; dkim=pass', 'mx.cloudflare.net; spf=fail; dkim=fail'])).verified, null);
  assert.equal(senderVerification(h(['mx.cloudflare.net; spf=fail; dkim=fail', 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass'])).verified, false);
  assert.equal(senderVerification([]).verified, null);
});

test('匹配：reply+token → 询盘；token 区分大小写；只认 REPLY_DOMAIN', async () => {
  assert.deepEqual(replyTokens([`reply+${TOKEN}@GEIOM.example`, `reply+${TOKEN}@other.example`], D), [TOKEN]);
  const m = db();
  const r = await ingestRaw(m.db as never, 'r1', mime(['From: b@c.example', `To: Sales <reply+${TOKEN}@${D}>`, 'Subject: hi', 'Message-ID: <m1@c.example>']), { replyDomain: D });
  assert.equal(r.result, 'stored'); assert.equal(r.inquiryId, INQ);
  const r2 = await ingestRaw(m.db as never, 'r2', mime(['From: b@c.example', `To: reply+${TOKEN.toLowerCase()}@${D}`, 'Message-ID: <m2@c.example>']), { replyDomain: D });
  assert.equal(r2.inquiryId, null);
});

test('线程头只匹配我们发出的（OUTBOUND）信：用入站信的 Message-ID 伪造不会挂到询盘', async () => {
  const m = db();
  await m.db.mailMessage.create({ data: { direction: 'OUTBOUND', status: 'SENT', inquiryId: INQ, messageId: `<out1@${D}>`, fromAddr: 'x', toAddr: 'y', subject: '', bodyHtml: '', bodyText: '' } });
  await m.db.mailMessage.create({ data: { direction: 'INBOUND', status: 'RECEIVED', inquiryId: INQ, messageId: '<cust1@c.example>', fromAddr: 'x', toAddr: 'y', subject: '', bodyHtml: '', bodyText: '' } });
  const viaOut = await ingestRaw(m.db as never, 't1', mime(['From: z@q.example', `To: sales@${D}`, `In-Reply-To: <out1@${D}>`, 'Message-ID: <t1@q.example>']), { replyDomain: D });
  assert.equal(viaOut.inquiryId, INQ);
  const viaIn = await ingestRaw(m.db as never, 't2', mime(['From: z@q.example', `To: sales@${D}`, 'References: <cust1@c.example>', 'Message-ID: <t2@q.example>']), { replyDomain: D });
  assert.equal(viaIn.inquiryId, null);
  const noLocalRcpt = await ingestRaw(m.db as never, 't3', mime(['From: z@q.example', 'To: other@q.example', `In-Reply-To: <out1@${D}>`, 'Message-ID: <t3@q.example>']), { replyDomain: D });
  assert.equal(noLocalRcpt.inquiryId, null, '保守：线程头命中时还要求收件人含本域');
});

test('去重：同一 Worker id / 同一 Message-ID 跳过，绝不覆盖已有行', async () => {
  const m = db();
  await ingestRaw(m.db as never, 'd1', mime(['From: b@c.example', `To: sales@${D}`, 'Message-ID: <dup@c.example>', 'Subject: first']), { replyDomain: D });
  assert.equal((await ingestRaw(m.db as never, 'd1', mime(['From: x@evil.example', 'Subject: second']), { replyDomain: D })).result, 'duplicate');
  assert.equal((await ingestRaw(m.db as never, 'd2', mime(['From: x@evil.example', 'Message-ID: <dup@c.example>', 'Subject: forged']), { replyDomain: D })).result, 'duplicate');
  assert.equal(m.mails.length, 1); assert.equal(m.mails[0].subject, 'first');
});

test('已匿名化询盘的来信：token 失效 → 未归类；写入时被匿名化 → 丢弃正文，只记审计（无地址和内容）', async () => {
  const m = db();
  m.inquiries[0].anonymizedAt = new Date();
  const r = await ingestRaw(m.db as never, 'a1', mime(['From: b@c.example', `To: reply+${TOKEN}@${D}`, 'Message-ID: <a1@c.example>']), { replyDomain: D });
  assert.equal(r.inquiryId, null);
  const m2 = db();
  const audits: unknown[] = [];
  const origUpd = m2.db.inquiry.updateMany;
  m2.db.inquiry.updateMany = async (a: never) => { m2.inquiries[0].anonymizedAt = new Date(); return origUpd(a); };
  const r2 = await ingestRaw(m2.db as never, 'a2', mime(['From: b@c.example', `To: reply+${TOKEN}@${D}`, 'Message-ID: <a2@c.example>', 'Subject: secret subj'], 'secret body'), { replyDomain: D, audit: async (e) => { audits.push(e); } });
  assert.equal(r2.result, 'dropped_anonymized'); assert.equal(m2.mails.length, 0);
  const dump = JSON.stringify(audits);
  assert.ok(dump.includes('mail.inbound_dropped_anonymized') && !dump.includes('b@c.example') && !dump.includes('secret'));
});

test('flags：auto / bounce（退信一律未归类）/ attachment_rejected；parse_error 与超大件只存占位', async () => {
  const m = db();
  const auto = await parseInbound(mime(['From: b@c.example', 'Auto-Submitted: auto-replied', 'Message-ID: <x1@c.example>']));
  assert.deepEqual(auto.flags, ['auto']);
  const bounce = await ingestRaw(m.db as never, 'b1', mime(['From: MAILER-DAEMON@mx.example', `To: reply+${TOKEN}@${D}`, 'Message-ID: <b1@mx.example>']), { replyDomain: D });
  assert.equal(bounce.inquiryId, null); assert.deepEqual(m.mails.at(-1)!.flags, ['bounce']);
  const att = await parseInbound(Buffer.from(['From: b@c.example', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'hi', '--B', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="a.pdf"', 'Content-Transfer-Encoding: base64', '', 'JVBERi0=', '--B--', ''].join('\r\n')));
  assert.ok(att.flags.includes('attachment_rejected'));
  let deep = 'From: b@c.example\r\n';
  for (let i = 0; i < 12; i++) deep += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
  const r = await ingestRaw(m.db as never, 'p1', Buffer.from(deep), { replyDomain: D });
  assert.equal(r.result, 'parse_error'); assert.deepEqual(m.mails.at(-1)!.flags, ['parse_error']); assert.equal(m.mails.at(-1)!.bodyHtml, '');
  const hdr = Buffer.from(`From: b@c.example\r\nX-Pad: ${'a'.repeat(70 * 1024)}\r\n\r\nx`);
  assert.equal((await ingestRaw(m.db as never, 'p2', hdr, { replyDomain: D })).result, 'parse_error');
});

test('匿名化：MailMessage 主题正文地址清空、redactedAt；messageId / inReplyTo 换哈希', async () => {
  const calls: [string, any][] = [];
  const rec = (n: string) => async (a: any) => { calls.push([n, a]); return { count: 0 }; };
  const tx = {
    inquiry: { updateMany: rec('x'), update: rec('x') }, inquiryItem: { updateMany: rec('x'), update: rec('x'), findMany: async () => [] },
    inquiryMessage: { updateMany: rec('x') }, inquiryNote: { updateMany: rec('x') }, sampleRequest: { updateMany: rec('x') }, logoUpload: { deleteMany: rec('x'), findMany: async () => [] },
    mailMessage: { updateMany: rec('mail.updateMany'), update: rec('mail.update'), findMany: async () => [{ id: 'm1', messageId: '<abc@customer.example>', inReplyTo: null }] },
  };
  await anonymizeInquiriesTx(tx as never, ['i1']);
  const u = calls.find((c) => c[0] === 'mail.updateMany')![1];
  assert.deepEqual(u.where, { inquiryId: { in: ['i1'] } });
  for (const k of ['subject', 'bodyHtml', 'bodyText', 'fromAddr', 'toAddr']) assert.equal(u.data[k], '', k);
  assert.ok(u.data.redactedAt instanceof Date); assert.equal(u.data.references, null);
  const h = calls.find((c) => c[0] === 'mail.update')![1];
  assert.match(h.data.messageId, /^<[0-9a-f]{64}@redacted\.invalid>$/);
  assert.ok(!h.data.messageId.includes('customer.example'));
  assert.equal(redactMsgId(h.data.messageId), h.data.messageId, '幂等');
});

test('webhook 请求体上限固定为 36,700,160 字节（25 MiB × 1.4，含 JSON/base64 开销；运维 nginx 另配 location 限制）', () => {
  assert.equal(WEBHOOK_MAX_BODY, 36_700_160);
});
