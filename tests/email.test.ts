import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail, summarizeItems, cleanText, safeGreetingName, looksLinky, replyTimeText, productName } from '../src/lib/server/email/render';
import { sendMail, sendSafely, sendAdminAlert, customerAckMail, inquiryNotifyMail, errorSummary, setMailTransportFactory } from '../src/lib/server/mail';
import { setRateLimitStore, MemoryStore } from '../src/lib/server/ratelimit';
import { TEMPLATES } from '../src/lib/server/email/templates.generated';

// mock SMTP：记录 nodemailer 的传输参数和每封信，不连网络（#74 §16：发信从 Resend 换成 Gmail SMTP）
type Call = { opts: Record<string, any>; body: Record<string, any> };
let calls: Call[] = [];
let failWith: Record<string, unknown> | null = null;
setMailTransportFactory((opts) => ({
  async sendMail(m) {
    if (failWith && (m as { to?: unknown }).to !== 'sales@example.com') throw Object.assign(new Error('raw smtp response with secrets'), failWith);
    calls.push({ opts: opts as Record<string, any>, body: m as Record<string, any> });
    return {} as never;
  },
}));

beforeEach(() => {
  calls = []; failWith = null;
  setRateLimitStore(new MemoryStore());
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'fake-user@example.test', SMTP_PASS: 'fake-app-password' });
  process.env.MAIL_FROM = 'PackJoyU <no-reply@example.com>';
  process.env.INQUIRY_NOTIFY_EMAIL = 'sales@example.com';
  process.env.CONTACT_EMAIL = 'hello@example.com';
  process.env.CONTACT_WHATSAPP = '+8613800000000';
  process.env.CONTACT_REPLY_TIME = '12h';
  delete process.env.ADMIN_ALERT_EMAIL;
  delete process.env.REPLY_DOMAIN;
});

const EVIL = '<script>alert(1)</script>\r\nBcc: x@evil.com {{siteUrl}}';
const vars = { name: EVIL, company: 'A&B "Co"', product: 'gift-box', quantity: '5,000', inquiryId: 'PJ-2610-ABC123', locale: 'en' as const };

test('customer ack: escaped vars, subject only inquiry id, no message echo, env contact info', () => {
  const m = customerAckMail('inquiry', vars);
  assert.equal(m.subject, 'We received your inquiry #PJ-2610-ABC123');
  assert.ok(!m.html.includes('<script>') && !m.html.includes('evil.com'), 'unsafe name replaced by generic greeting');
  const short = customerAckMail('inquiry', { ...vars, name: '<b>Bob</b>' });
  assert.ok(short.html.includes('&#60;b&#62;Bob&#60;/b&#62;') && !short.html.includes('<b>Bob</b>'));
  const n = inquiryNotifyMail({ ...vars, adminId: 'cm1', score: 80 });
  assert.ok(n.html.includes('&#60;script&#62;') && !n.html.includes('<script>'));
  assert.ok(!m.html.includes('A&#38;B') && !m.text.includes('A&B'), 'company removed from customer mail');
  assert.ok(!m.text.includes('Company'));
  assert.ok(!m.html.includes('{{'), 'no unfilled or re-expanded placeholders');
  assert.ok(m.html.includes('{{siteUrl}}') === false);
  assert.ok(m.text.includes('hello@example.com') && m.text.includes('+8613800000000') && m.text.includes('12 hours'));
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

test('sendMail: SMTP (TLS enforced, logger off), CRLF stripped from subject/reply-to, bad address rejected', async () => {
  await sendMail({ to: 'a@example.com', subject: 'Hi\r\nBcc: x@evil.com', html: '<p>x</p>', text: 'x', replyTo: 'r@example.com' });
  assert.equal(calls.length, 1);
  const o = calls[0].opts;
  assert.equal(o.port, 587); assert.equal(o.secure, false); assert.equal(o.requireTLS, true);
  assert.equal(o.logger, false); assert.equal(o.debug, false);
  assert.ok(!('rejectUnauthorized' in (o.tls ?? {})));
  assert.deepEqual(calls[0].body.from, { name: 'PackJoyU', address: 'no-reply@example.com' });
  assert.equal(calls[0].body.subject, 'Hi Bcc: x@evil.com');
  assert.equal(calls[0].body.replyTo, 'r@example.com');
  assert.equal(calls[0].body.text, 'x');
  await assert.rejects(sendMail({ to: 'a@example.com', subject: 's', html: '', replyTo: 'r@example.com\r\nBcc: x@evil.com' }));
  await assert.rejects(sendMail({ to: 'a@example.com, b@example.com', subject: 's', html: '' }));
});

test('sendMail: no SMTP_* configured → dev log only; insecure port → SmtpError without sending', async () => {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];
  await sendMail({ to: 'a@example.com', subject: 's', html: '' });
  assert.equal(calls.length, 0);
  Object.assign(process.env, { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '25', SMTP_USER: 'u', SMTP_PASS: 'p' });
  await assert.rejects(sendMail({ to: 'a@example.com', subject: 's', html: '' }), (e: Error & { code?: string }) => e.name === 'SmtpError' && e.code === 'SMTP_CONFIG_INSECURE_TLS');
  assert.equal(calls.length, 0);
});

test('sendSafely: SMTP failure returns false and sends one admin alert (deduped)', async () => {
  failWith = { responseCode: 451 };
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

test('customer greeting: name only if <=40 chars and not link-like, else generic', () => {
  assert.equal(safeGreetingName('Anna Müller'), 'Anna Müller');
  for (const bad of ['x'.repeat(41), 'Visit evil.com', 'http://x', 'www.spam', 'a@b.c', 'Win at shop.ru now', '//evil'])
    assert.equal(safeGreetingName(bad), null, bad);
  const en = customerAckMail('inquiry', { ...vars, name: 'Claim prize at evil.com' });
  assert.match(en.text, /^Hello,/m); assert.ok(!en.text.includes('evil.com') && !en.html.includes('evil.com'));
  const ru = customerAckMail('sample', { ...vars, locale: 'ru', name: 'Иван' });
  assert.match(ru.text, /Здравствуйте, Иван!/);
  const ruGeneric = customerAckMail('inquiry', { ...vars, locale: 'ru', name: 'x'.repeat(50) });
  assert.match(ruGeneric.text, /^Здравствуйте!$/m);
  assert.match(customerAckMail('inquiry', { ...vars, name: 'Bob' }).html, /Hi Bob,/);
});

test('internal notification keeps company and name', () => {
  const n = inquiryNotifyMail({ ...vars, name: 'Claim prize at evil.com', adminId: 'cm1', score: 80 });
  assert.ok(n.text.includes('A&B "Co"') && n.text.includes('evil.com'));
});

test('errorSummary: only name/code, never message', async () => {
  const e = Object.assign(new Error('connect postgres://user:pass@db/x failed'), { code: 'ECONNREFUSED' });
  assert.deepEqual(errorSummary(e), { 错误类型: 'Error', 错误码: 'ECONNREFUSED' });
  assert.ok(!JSON.stringify(errorSummary(e)).includes('pass'));
  failWith = { responseCode: 503, response: '503 secret-detail', command: 'AUTH PLAIN c2VjcmV0' };
  await sendSafely('x', { to: 'a@example.com', subject: 's', html: '' });
  const alert = calls.find((c) => c.body.to === 'sales@example.com')!;
  assert.match(String(alert.body.text), /SMTP_503/);
  for (const leak of ['raw smtp response', 'secret-detail', 'c2VjcmV0', 'fake-app-password']) assert.ok(!String(alert.body.text).includes(leak), leak);
});

test('sample ack copy: no inquiry wording left, sample sentences, preheader/footer/labels', () => {
  const en = customerAckMail('sample', vars);
  for (const part of [en.html, en.text]) {
    assert.ok(part.includes('Any costs will be confirmed by email before dispatch.'));
    assert.ok(!/free of charge|free/i.test(part), 'no free-samples claim');
    assert.ok(part.includes('Sample qty') && part.includes('because you requested samples on'));
    assert.ok(!/inquiry|reply within/i.test(part), 'no inquiry wording');
  }
  assert.ok(en.html.includes("Thanks — we'll confirm your sample shipping within 12 hours."));
  const ru = customerAckMail('sample', { ...vars, locale: 'ru' });
  for (const part of [ru.html, ru.text]) {
    assert.ok(part.includes('Все расходы мы подтвердим по email до отправки.'));
    assert.ok(!/бесплатн/i.test(part), 'no free-samples claim');
    assert.ok(part.includes('Номер заявки') && part.includes('Количество образцов') && part.includes('оставили заявку на образцы на сайте'));
    assert.ok(!/запрос|Тираж|ответит/.test(part), 'no inquiry wording');
  }
  assert.ok(ru.html.includes('Спасибо! Подтвердим доставку образцов в течение 12 часов.'));
});

test('reply time localized when CONTACT_REPLY_TIME set; RU never shows raw "24h"', () => {
  process.env.CONTACT_REPLY_TIME = '24';
  assert.ok(customerAckMail('inquiry', { ...vars, locale: 'ru' }).text.includes('24 часа'));
  assert.ok(customerAckMail('inquiry', vars).text.includes('24 hours'));
  assert.ok(!customerAckMail('sample', { ...vars, locale: 'ru' }).html.includes('24h'));
  process.env.CONTACT_REPLY_TIME = '12';
  const en = customerAckMail('inquiry', vars);
  assert.ok(en.html.includes('will reply within <b>12 hours</b>.') && en.text.includes('will reply within 12 hours.'));
  assert.ok(en.html.includes('Thanks — our team will reply within 12 hours.'));
  assert.ok(!en.html.includes('by email.</div>'), 'neutral preheader not shown when set');
  assert.equal(replyTimeText(1, 'ru'), '1 час'); assert.equal(replyTimeText(48, 'ru'), '48 часов'); assert.equal(replyTimeText(22, 'ru'), '22 часа');
});

test('reply time unset/invalid: whole sentence neutral, no "within", no 24, preheader neutral', () => {
  for (const v of [undefined, '', 'soon', '0', '9999', '24 days', '<b>1</b>']) {
    if (v === undefined) delete process.env.CONTACT_REPLY_TIME; else process.env.CONTACT_REPLY_TIME = v;
    for (const [kind, loc] of [['inquiry', 'en'], ['inquiry', 'ru'], ['sample', 'en'], ['sample', 'ru']] as const) {
      const m = customerAckMail(kind, { ...vars, locale: loc });
      for (const part of [m.html, m.text]) {
        assert.ok(!/within|в течение/i.test(part), `${kind}.${loc} ${v}: no reply-time sentence`);
        assert.ok(!/\b24\b|24 ?h|24 час/.test(part.replace(/padding:24px|margin:24px|\{2,24\}/g, '')), `${kind}.${loc} ${v}: no 24`);
        assert.ok(!/free of charge|бесплатн/i.test(part));
        assert.ok(!part.includes('{{') && !part.includes('<b></b>'));
      }
    }
  }
  delete process.env.CONTACT_REPLY_TIME;
  const en = customerAckMail('inquiry', vars), ru = customerAckMail('inquiry', { ...vars, locale: 'ru' });
  const se = customerAckMail('sample', vars), sr = customerAckMail('sample', { ...vars, locale: 'ru' });
  for (const p of [en.html, en.text]) assert.ok(p.includes('We have received your inquiry and a packaging specialist will reply by email.'));
  for (const p of [ru.html, ru.text]) assert.ok(p.includes('Мы получили ваш запрос — специалист по упаковке ответит вам по email.'));
  for (const p of [se.html, se.text]) assert.ok(p.includes('We have received your sample request. A packaging specialist will review it and confirm shipping by email.'));
  for (const p of [sr.html, sr.text]) assert.ok(p.includes('Мы получили вашу заявку на образцы — специалист проверит её и подтвердит доставку по email.'));
  assert.ok(en.html.includes('opacity:0">Thanks — our team will reply by email.</div>'));
  assert.ok(ru.html.includes('opacity:0">Спасибо! Мы ответим вам по email.</div>'));
  assert.ok(se.html.includes("opacity:0\">Thanks — we'll confirm your sample shipping by email.</div>"));
  assert.ok(sr.html.includes('opacity:0">Спасибо! Подтвердим доставку образцов по email.</div>'));
});

test('no free-samples claim in any generated template', () => {
  for (const t of Object.values(TEMPLATES)) for (const p of [t.subject, t.html, t.text]) assert.ok(!/free of charge|бесплатн|免费/i.test(p));
});

test('dark mode + nowrap in all customer templates', () => {
  for (const m of [customerAckMail('inquiry', vars), customerAckMail('sample', vars), customerAckMail('sample', { ...vars, locale: 'ru' })]) {
    assert.ok(m.html.includes('class="card px ink"'));
    assert.ok(m.html.includes('.card{background:#1B1B1F!important;color:#F2E9D8!important}'));
    assert.ok(m.html.includes('body,.bg{background:#121214!important}') && m.html.includes('<body class="bg"'));
    assert.ok(m.html.includes('<span style="white-space:nowrap">+8613800000000</span>'));
  }
});

test('product names localized from categoryMeta; notify keeps slugs', () => {
  assert.equal(productName('gift-boxes', 'en'), 'Custom gift boxes');
  assert.equal(productName('gift-box', 'ru'), 'Подарочные коробки на заказ');
  assert.equal(productName('wine-box', 'en'), productName('wine-boxes', 'en'));
  assert.equal(productName('mystery-thing', 'ru'), 'Mystery thing');
  assert.equal(productName('eco-paper-cups', 'en'), 'Printed Coffee Cups');
  assert.equal(productName('eco-paper-cups', 'ru'), 'Стаканы для кофе с печатью');
  assert.equal(productName('eco-paper-cup', 'en'), 'Printed Coffee Cups');
  assert.equal(productName('eco-paper-cup', 'ru'), 'Стаканы для кофе с печатью');
  assert.equal(summarizeItems([{ productSlug: 'gift-boxes', quantity: 500 }], 'ru').product, 'Подарочные коробки на заказ');
  assert.equal(summarizeItems([{ productSlug: 'gift-boxes' }]).product, 'gift-boxes');
});

// 安全复审 #171：各种变形的域名写法都要识别成链接，每种一条用例
for (const [label, name] of [
  ['spaces around dot', 'example . com'],
  ['space before dot', 'example .com'],
  ['space after dot', 'example. com'],
  ['bracket dot', 'example[.]com'],
  ['word joiner', 'example\u2060.com'],
  ['BOM', 'example\uFEFF.com'],
  ['invisible times', 'example\u2062.com'],
  ['paren dot', 'example(.)com'],
  ['brace dot', 'example{.}com'],
  ['[dot]', 'example[dot]com'],
  ['" dot "', 'example dot com'],
  ['fullwidth', 'ｅｘａｍｐｌｅ．ｃｏｍ'],
  ['ideographic full stop', 'example。com'],
  ['halfwidth ideographic stop', 'example｡com'],
  ['cyrillic IDN', 'пример.рф'],
  ['cyrillic IDN spaced', 'пример . рф'],
  ['punycode', 'xn--e1afmkfd.xn--p1ai'],
  ['fullwidth at', 'ａ＠ｂ．ｃｏ'],
  ['uppercase', 'EXAMPLE.COM'],
] as const) {
  test(`greeting rejects link-like name: ${label}`, () => {
    assert.ok(looksLinky(name), name);
    assert.equal(safeGreetingName(name), null);
  });
}

test('greeting keeps ordinary names (incl. initials and Cyrillic)', () => {
  for (const ok of ['Anna Müller', 'J. Smith', 'Anna M. Smith', 'Иван Петров', 'Мария-Анна', "O'Brien", '王小明'])
    assert.equal(safeGreetingName(ok), ok, ok);
});

test('logo: text wordmark in every template, no <img> / logo.png', () => {
  for (const key of Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]) {
    const h = TEMPLATES[key].html;
    assert.ok(!h.includes('<img'), key);
    assert.ok(!h.includes('logo.png'), key);
    assert.ok(h.includes('class="logo"') && h.includes('>PackJoyU</span>'), key);
    assert.ok(h.includes('font-family:Manrope,Arial,Helvetica,sans-serif;font-size:20px;line-height:32px;font-weight:700;color:#1C1C1C;'), key);
    assert.ok(h.includes('.logo{color:#FFFFFF!important}') && !h.includes('.logo{background'), key);
    assert.ok(h.includes('body,.bg{background:#121214!important}') && h.includes('<body class="bg"'), key);
  }
});

test('quantities: en 1,000 / ru 1 000', () => {
  const items = [{ productSlug: 'gift-boxes', quantity: 1000 }, { productSlug: 'wine-boxes', quantity: 25000 }];
  assert.equal(summarizeItems(items, 'en').quantity, '1,000 / 25,000');
  assert.equal(summarizeItems(items, 'ru').quantity, '1 000 / 25 000');
  assert.equal(summarizeItems([{ productSlug: 'gift-boxes', quantity: 500 }], 'ru').quantity, '500');
  const ru = customerAckMail('inquiry', { ...vars, locale: 'ru', ...summarizeItems(items, 'ru') });
  assert.ok(ru.text.includes('1 000 / 25 000') && ru.html.includes('1 000 / 25 000'));
});

test('eco-paper-cups: customer emails show card name, escaped, never the raw slug', () => {
  for (const locale of ['en', 'ru'] as const) {
    for (const slug of ['eco-paper-cups', 'eco-paper-cup']) {
      const s = summarizeItems([{ productSlug: slug, quantity: 1000 }], locale);
      for (const kind of ['inquiry-ack', 'sample-ack'] as const) {
        const out = renderEmail(`${kind}.${locale}`, { ...vars, ...s, locale });
        for (const part of [out.subject, out.text, out.html]) assert.ok(!/eco[- ]paper[- ]cup/i.test(part), `${kind}.${locale} ${slug}`);
        const name = locale === 'ru' ? 'Стаканы для кофе с печатью' : 'Printed Coffee Cups';
        assert.ok(out.text.includes(name) || out.html.includes(name), `${kind}.${locale} name`);
      }
    }
  }
  // HTML 部分对产品名做转义
  const evil = renderEmail('inquiry-ack.en', { ...vars, product: '<b>x</b>&' });
  assert.ok(!evil.html.includes('<b>x</b>'));
});

test('email productName ignores prototype keys', () => {
  for (const locale of ['en', 'ru'] as const) {
    for (const k of ['constructor', '__proto__', 'toString']) {
      const n = productName(k, locale);
      assert.equal(typeof n, 'string');
      assert.ok(!n.includes('function') && !n.includes('[object'), `${k} ${locale}: ${n}`);
      assert.equal(n.toLowerCase(), k.replace(/-/g, ' ').toLowerCase());
    }
  }
});
