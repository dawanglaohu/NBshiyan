import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail, summarizeItems, cleanText } from '../src/lib/server/email/render';
import { sendMail, sendSafely, sendAdminAlert, customerAckMail, inquiryNotifyMail } from '../src/lib/server/mail';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit';

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[] = [];
let status = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
  return new Response('{}', { status });
}) as typeof fetch;
void realFetch;

beforeEach(() => {
  calls = []; status = 200;
  setRateLimitStore(new MemoryStore());
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'PackJoyU <no-reply@example.com>';
  process.env.INQUIRY_NOTIFY_EMAIL = 'sales@example.com';
  process.env.CONTACT_EMAIL = 'hello@example.com';
  process.env.CONTACT_WHATSAPP = '+8613800000000';
  process.env.CONTACT_REPLY_TIME = '12h';
  delete process.env.ADMIN_ALERT_EMAIL;
});

const EVIL = '<script>alert(1)</script>\r\nBcc: x@evil.com {{siteUrl}}';
const vars = { name: EVIL, company: 'A&B "Co"', product: 'gift-box', quantity: '5,000', inquiryId: 'PJ-2610-ABC123', locale: 'en' as const };

test('customer ack: escaped vars, subject only inquiry id, no message echo, env contact info', () => {
  const m = customerAckMail('inquiry', vars);
  assert.equal(m.subject, 'We received your inquiry #PJ-2610-ABC123');
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('&#60;script&#62;'));
  assert.ok(m.html.includes('A&#38;B &#34;Co&#34;'));
  assert.ok(!m.html.includes('{{'), 'no unfilled or re-expanded placeholders');
  assert.ok(m.html.includes('{{siteUrl}}') === false);
  assert.ok(m.text.includes('hello@example.com') && m.text.includes('+8613800000000') && m.text.includes('12h'));
  assert.ok(!/\r|Bcc: x@evil.com\n/.test(m.text), 'no CRLF injection in text');
});

test('ru ack and sample ack variants', () => {
  assert.match(customerAckMail('inquiry', { ...vars, locale: 'ru' }).subject, /№PJ-2610-ABC123$/);
  assert.match(customerAckMail('sample', vars).subject, /sample request #PJ-2610-ABC123/);
  assert.match(customerAckMail('sample', { ...vars, locale: 'ru' }).html, /заявку на образцы/);
});

test('contact block hidden when CONTACT_* not configured', () => {
  delete process.env.CONTACT_WHATSAPP;
  const m = customerAckMail('inquiry', vars);
  assert.ok(!m.text.includes('WhatsApp'));
});

test('notify: risk block only below 40, admin link = SITE_URL + internal id, no token', () => {
  const low = inquiryNotifyMail({ ...vars, adminId: 'cmabc123', score: 39 });
  const high = inquiryNotifyMail({ ...vars, adminId: 'cmabc123', score: 40 });
  assert.ok(low.html.includes('待核实') && low.text.includes('待核实'));
  assert.ok(!high.html.includes('待核实') && !high.text.includes('待核实'));
  assert.match(low.text, /\/admin\/inquiries\/cmabc123\n/);
  assert.ok(!/token|replyToken/i.test(low.html));
});

test('sendMail: Resend payload, CRLF stripped from subject/reply-to, bad address rejected', async () => {
  await sendMail({ to: 'a@example.com', subject: 'Hi\r\nBcc: x@evil.com', html: '<p>x</p>', text: 'x', replyTo: 'r@example.com' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].headers.Authorization, 'Bearer re_test_key');
  assert.equal(calls[0].body.subject, 'Hi Bcc: x@evil.com');
  assert.equal(calls[0].body.reply_to, 'r@example.com');
  assert.equal(calls[0].body.text, 'x');
  await assert.rejects(sendMail({ to: 'a@example.com', subject: 's', html: '', replyTo: 'r@example.com\r\nBcc: x@evil.com' }));
  await assert.rejects(sendMail({ to: 'a@example.com, b@example.com', subject: 's', html: '' }));
});

test('sendSafely: Resend failure returns false and sends one admin alert (deduped)', async () => {
  status = 500;
  assert.equal(await sendSafely('inquiry-ack', { to: 'a@example.com', subject: 's', html: '' }), false);
  assert.equal(await sendSafely('inquiry-ack', { to: 'a@example.com', subject: 's', html: '' }), false);
  const alerts = calls.filter((c) => c.body.to === 'sales@example.com');
  assert.equal(alerts.length, 1);
  assert.match(String(alerts[0].body.subject), /告警/);
});

test('sendAdminAlert: ADMIN_ALERT_EMAIL preferred, escaped, rate-limited per key', async () => {
  process.env.ADMIN_ALERT_EMAIL = 'ops@example.com';
  await sendAdminAlert('后台账号被锁定', { IP: '<b>1.2.3.4</b>' }, 'lockout:u1');
  await sendAdminAlert('后台账号被锁定', { IP: '1.2.3.4' }, 'lockout:u1');
  await sendAdminAlert('后台账号被锁定', { IP: '1.2.3.4' }, 'lockout:u2');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.to, 'ops@example.com');
  assert.ok(!String(calls[0].body.html).includes('<b>1.2.3.4</b>'));
});

test('helpers', () => {
  assert.deepEqual(summarizeItems([]), { product: '—', quantity: '—' });
  assert.deepEqual(summarizeItems([{ productSlug: 'a', quantity: 5000 }, { productSlug: 'b' }]), { product: 'a, b', quantity: '5,000 / —' });
  assert.equal(summarizeItems([1, 2, 3, 4, 5].map((n) => ({ productSlug: `p${n}` }))).product, 'p1, p2, p3 +2');
  assert.equal(cleanText('a\u202eb\u0000c\r\nd'), 'abc d');
  assert.equal(renderEmail('inquiry-ack.en', vars).subject.includes('\n'), false);
});
