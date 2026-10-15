// #74 邮件接口的示例数据（仅后台开发 / 演示用，接入真实接口后不再使用；切换见 api.ts）。
// 结构严格按 backend-plan v4 §8 返回，错误按 http.ts 同一个 MailError 抛出，页面不区分 mock 和真实接口。
//
// 演示开关（只在 mock 里生效）：
// - 正文里写 [mock:202] → 202 后台发送，两次轮询后 SENT；[mock:202-fail] → 后台发送后 FAILED(send_unavailable)
// - [mock:fail] → 502 send_unavailable（可重试）；[mock:unknown] → 502 unknown_delivery（可能已送达）；[mock:auth] → 502 send_auth
// - [mock:429] / [mock:429g] → 个人 / 全站限流；[mock:400] → 主题 too_long；[mock:413] → 请求过大；[mock:503] → mail_not_configured；[mock:409] → 不认识的 409
// - localStorage `pj-mock-mail-sending` = `off`（或地址栏 ?mockSending=off）→ GET /mail/config 返回 sendingEnabled:false
import type { MailApi, MailAttachment, SendStatus, ThreadItem, ThreadPage, UnassignedDetail } from './types';
import { MailError } from './types';
import { mockAdminApi } from '../mock';

const now = () => Date.now();
const ago = (min: number) => new Date(now() - min * 60_000).toISOString();
const later = (min: number) => new Date(now() + min * 60_000).toISOString();
const DAY = 24 * 60;
const delay = <T,>(v: T, ms = 150) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const textToHtml = (t: string) => t.split(/\r?\n/).map(esc).join('<br>');
let seq = 0;
const nid = (p: string) => `${p}_${now().toString(36)}${(seq++).toString(36)}`;

const att = (id: string, filename: string, sniffedType: string, size: number, expiresInMin = 5): MailAttachment =>
  ({ id, filename, sniffedType, size, downloadUrl: `mock:att/${id}?exp=${expiresInMin > 0 ? 'ok' : 'expired'}`, expiresAt: later(expiresInMin) });

const base = (p: Partial<ThreadItem> & Pick<ThreadItem, 'id' | 'direction' | 'createdAt'>): ThreadItem => ({
  source: 'mail', status: p.direction === 'INBOUND' ? 'RECEIVED' : 'SENT', deliveryStatus: 'unknown', bouncedAt: null,
  retryCount: 0, maxRetries: 5, redacted: false, from: null, to: null, authorName: null, subject: null, bodyHtml: null, bodyText: null,
  hasRemoteImages: false, senderVerified: null, flags: [], errorCode: null, retryable: false, sentAt: null, receivedAt: null, attachments: [], ...p
});
const inbound = (id: string, min: number, p: Partial<ThreadItem>) => base({ id, direction: 'INBOUND', createdAt: ago(min), receivedAt: ago(min), from: 'anna@acme.de', to: 'sales@geiom.com', ...p });
const outbound = (id: string, min: number, p: Partial<ThreadItem>) => base({ id, direction: 'OUTBOUND', createdAt: ago(min), sentAt: p.status && p.status !== 'SENT' ? null : ago(min), from: 'sales@geiom.com', to: 'anna@acme.de', authorName: '业务员 A', ...p });
const redacted = (p: ThreadItem): ThreadItem => ({ ...p, redacted: true, from: null, to: null, subject: null, bodyHtml: null, bodyText: null, attachments: [], hasRemoteImages: false });

/** inq_1：覆盖第 1 阶段全部显示状态的演示线程 */
function richThread(): ThreadItem[] {
  return [
    base({ id: 'lg1', source: 'legacy', direction: 'OUTBOUND', status: 'SENT', createdAt: ago(9 * DAY), sentAt: ago(9 * DAY), authorName: '业务员 A', subject: 'Re: Quote PJ-2610', bodyText: 'Thanks for your inquiry. Quotation attached.', bodyHtml: '<p>Thanks for your inquiry. Quotation attached.</p>' }),
    redacted(inbound('mr1', 8 * DAY, { subject: 'x' })),
    inbound('mi1', 6 * DAY, {
      subject: 'Artwork and dielines', senderVerified: true,
      bodyText: 'Hi, attached are the artwork files. Brand guide: www.acme.de/brand\nPayment portal: https://acme.de/pay',
      bodyHtml: '<p>Hi, attached are the artwork files. Brand guide: <a href="https://acme-brand.example.net/guide" target="_blank" rel="noopener noreferrer" title="https://acme-brand.example.net/guide" data-mismatch="1">www.acme.de/brand</a></p><p>Our logo: <img src="cid:logo123@acme"></p><p>Payment portal: <a href="https://acme.de/pay" target="_blank" rel="noopener noreferrer" title="https://acme.de/pay">https://acme.de/pay</a></p><p><img data-remote-src="https://tracker.example/p.gif"></p>',
      hasRemoteImages: true, flags: ['attachment_rejected'],
      attachments: [att('att_ok', 'artwork-final-v3-with-a-very-long-file-name-for-print.pdf', 'application/pdf', 2_480_000), att('att_exp', 'dieline.ai', 'application/postscript', 812_000, -1), att('att_gone', 'colors.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 24_000, -1)]
    }),
    outbound('mo1', 5 * DAY, { subject: 'Re: Artwork and dielines', bodyText: 'Received, thank you. We will send the proof tomorrow.', bodyHtml: '<p>Received, thank you. We will send the proof tomorrow.</p>' }),
    inbound('mi2', 4 * DAY, { from: 'anna@acme-mail.example', subject: null, senderVerified: false, bodyText: 'Please also quote 10,000 pcs.', bodyHtml: '<p>Please also quote 10,000 pcs.</p>' }),
    inbound('mi3', 3 * DAY, { from: 'noreply@acme.de', subject: 'Automatic reply: Out of office', flags: ['auto'], bodyText: 'I am out of office until Monday.', bodyHtml: '<p>I am out of office until Monday.</p>' }),
    outbound('mo2', 2 * DAY, { authorName: null, status: 'FAILED', errorCode: 'unknown_delivery', retryable: false, subject: 'Re: quote 10,000 pcs', bodyText: 'Here is the updated quotation for 10,000 pcs.', bodyHtml: '<p>Here is the updated quotation for 10,000 pcs.</p>' }),
    outbound('mo3', 1 * DAY, { status: 'FAILED', errorCode: 'send_unavailable', retryable: true, retryCount: 4, subject: 'Re: proof', bodyText: 'Proof v2 attached as link.', bodyHtml: '<p>Proof v2 attached as link.</p>' }),
    outbound('mo4', 20 * 60, { status: 'FAILED', errorCode: 'provider_throttled', retryable: true, retryCount: 5, subject: 'Re: proof', bodyText: 'Second try of the proof message.', bodyHtml: '<p>Second try of the proof message.</p>' }),
    outbound('mo5', 3 * 60, { status: 'FAILED', errorCode: 'smtp_weird_new_code', retryable: true, subject: 'Re: proof', bodyText: 'Unknown reason example.', bodyHtml: '<p>Unknown reason example.</p>' }),
    outbound('mo6', 50, { status: 'FAILED', errorCode: 'recipient_rejected', retryable: false, subject: 'Re: proof', bodyText: 'Rejected recipient example.', bodyHtml: '<p>Rejected recipient example.</p>' })
  ];
}
function simpleThread(id: string): ThreadItem[] {
  return [
    inbound(`${id}_i1`, 2 * DAY, { subject: 'Question about samples', senderVerified: null, bodyText: 'Can you send 3 samples?', bodyHtml: '<p>Can you send 3 samples?</p>' }),
    outbound(`${id}_o1`, DAY, { subject: 'Re: Question about samples', bodyText: 'Sure, samples ship on Friday.', bodyHtml: '<p>Sure, samples ship on Friday.</p>' })
  ];
}
const threads = new Map<string, ThreadPage>();
async function thread(id: string): Promise<ThreadPage> {
  const hit = threads.get(id); if (hit) return hit;
  // 询盘走真实接口（NEXT_PUBLIC_ADMIN_API=http）时 mock 里没有这条询盘：id 含 anon 的按已匿名化演示，其余用完整演示线程
  const inq = await mockAdminApi.getInquiry(id);
  const anonAt = inq ? inq.anonymizedAt : id.includes('anon') ? ago(30 * DAY) : null;
  const rich = id === 'inq_1' || !inq;
  const page: ThreadPage = anonAt
    ? { anonymizedAt: anonAt, items: [...richThread().slice(0, 4)].map((m) => redacted(m)), nextCursor: null }
    : { anonymizedAt: null, items: rich ? richThread() : simpleThread(id), nextCursor: null };
  threads.set(id, page); return page;
}
const findMsg = (mid: string) => { for (const p of threads.values()) { const m = p.items.find((x) => x.id === mid); if (m) return { m, p }; } return null; };
const statusOf = (m: ThreadItem): SendStatus => ({ id: m.id, status: m.status === 'RECEIVED' ? 'SENT' : m.status, errorCode: m.errorCode, retryable: m.retryable, retryCount: m.retryCount, maxRetries: 5, deliveryStatus: 'unknown', sentAt: m.sentAt });
/** 后台发送的剩余轮询次数（到 0 时落终态） */
const pending = new Map<string, { left: number; final: Partial<ThreadItem> }>();

function sendingEnabled() {
  if (typeof window === 'undefined') return true;
  try { if (new URLSearchParams(location.search).get('mockSending') === 'off') return false; return localStorage.getItem('pj-mock-mail-sending') !== 'off'; } catch { return true; }
}
const idem = new Map<string, unknown>();

function scenario(text: string) { return /\[mock:([\w-]+)\]/.exec(text)?.[1]; }
function failFor(sc: string | undefined, m: ThreadItem): never | void {
  switch (sc) {
    case '429': throw new MailError('rate_limited', 429, { scope: 'admin', retryAfterSec: 754, limit: 30, windowSec: 3600 });
    case '429g': throw new MailError('rate_limited', 429, { scope: 'global', retryAfterSec: 1830, limit: 200, windowSec: 3600 });
    case '400': throw new MailError('invalid', 400, { fields: { subject: 'too_long' }, limits: { subject: 200 } });
    case '413': throw new MailError('too_large', 413, { field: 'request', limit: 51200, unit: 'bytes' });
    case '503': throw new MailError('mail_not_configured', 503, { retryable: false });
    case '409': throw new MailError('unknown', 409, {});
  }
  void m;
}

export const mockMailApi: MailApi = {
  getConfig: () => delay({ sendingEnabled: sendingEnabled() }, 60),
  getThread: async (id) => delay(await thread(id)),
  async send(id, body, key) {
    if (idem.has(key)) return delay(idem.get(key) as never);
    const p = await thread(id);
    if (p.anonymizedAt) throw new MailError('anonymized', 409);
    if (!sendingEnabled()) throw new MailError('sending_disabled', 409);
    if ([...body.body].length > 20000) throw new MailError('too_large', 413, { field: 'body', limit: 20000, unit: 'chars' });
    const sc = scenario(body.body);
    const m = outbound(nid('mo'), 0, { authorName: '我', subject: body.subject, bodyText: body.body, bodyHtml: textToHtml(body.body), status: 'SENDING', sentAt: null });
    failFor(sc, m);
    p.items.push(m);
    let res;
    if (sc === '202' || sc === '202-fail') {
      pending.set(m.id, { left: 2, final: sc === '202' ? { status: 'SENT', sentAt: new Date().toISOString() } : { status: 'FAILED', errorCode: 'send_unavailable', retryable: true } });
      res = { kind: 'sending' as const, id: m.id, pollAfterMs: 5000 };
    } else if (sc === 'fail' || sc === 'unknown' || sc === 'auth') {
      Object.assign(m, { status: 'FAILED', errorCode: sc === 'fail' ? 'send_unavailable' : sc === 'auth' ? 'send_auth' : 'unknown_delivery', retryable: sc === 'fail' });
      throw new MailError('mail_failed', 502, { id: m.id, reason: m.errorCode!, retryable: m.retryable });
    } else {
      Object.assign(m, { status: 'SENT', sentAt: new Date().toISOString() });
      res = { kind: 'sent' as const, id: m.id, sentAt: m.sentAt, retryCount: 0, maxRetries: 5 };
    }
    idem.set(key, res);
    return delay(res, 400);
  },
  async retry(mid, key) {
    if (idem.has(key)) return delay(idem.get(key) as never);
    const hit = findMsg(mid); if (!hit) throw new MailError('not_found', 404);
    const { m, p } = hit;
    if (p.anonymizedAt) throw new MailError('anonymized', 409);
    if (!sendingEnabled()) throw new MailError('sending_disabled', 409);
    if (m.status !== 'FAILED' || m.errorCode === 'unknown_delivery' || !m.retryable) throw new MailError('not_retryable', 409);
    if (m.retryCount >= 5) throw new MailError('retry_limit', 409);
    m.retryCount += 1;
    // 演示：重试仍失败（次数 +1），第 5 次之后按钮隐藏
    throw new MailError('mail_failed', 502, { id: m.id, reason: m.errorCode ?? 'send_unavailable', retryable: true });
  },
  async status(mid) {
    const hit = findMsg(mid); if (!hit) throw new MailError('not_found', 404);
    const pd = pending.get(mid);
    if (pd) { pd.left -= 1; if (pd.left <= 0) { Object.assign(hit.m, pd.final); pending.delete(mid); } }
    return delay(statusOf(hit.m), 80);
  },
  async refreshLinks(ids) {
    const links = ids.filter((id) => id !== 'att_gone').map((id) => ({ id, downloadUrl: `mock:att/${id}?exp=ok`, expiresAt: later(5) }));
    return delay({ links, missing: ids.filter((id) => id === 'att_gone') });
  },
  async download(url) {
    if (url.includes('exp=expired')) throw new MailError('expired', 403);
    return delay(new Blob([`mock attachment ${url}\n`], { type: 'text/plain' }));
  },
  unassignedCount: async () => delay({ unassigned: unassigned.filter((u) => u.status === 'UNASSIGNED' && !u.flags.some((f) => f === 'auto' || f === 'bounce')).length }, 60),
  async listUnassigned(status) {
    const items = unassigned.filter((u) => u.status === status).map(({ id, redacted: r, from, subject, receivedAt, bodyText, attachments, flags, senderVerified, suggestedInquiryRef, expiresAt }) =>
      ({ id, redacted: r, from, subject, receivedAt, snippet: bodyText ? bodyText.slice(0, 140) : null, attachmentCount: attachments.length, flags, senderVerified, suggestedInquiryRef, expiresAt }));
    return delay({ items, nextCursor: null, counts: { unassigned: unassigned.filter((u) => u.status === 'UNASSIGNED').length, ignored: unassigned.filter((u) => u.status === 'IGNORED').length } });
  },
  async getUnassigned(id) {
    const u = unassigned.find((x) => x.id === id);
    if (!u || id === 'um_taken') throw new MailError('not_found', 404);
    return delay(u);
  },
  async assignLookup(ref) {
    if (!/^PJ-\d{4}-[0-9A-Z]{4,8}$/.test(ref)) throw new MailError('invalid', 400, { fields: { ref: 'bad_format' } });
    const hit = (await mockAdminApi.listInquiries({ q: ref, includeAnonymized: true, pageSize: 50 })).items.find((r) => r.ref === ref);
    if (!hit) throw new MailError('not_found', 404);
    if (hit.anonymizedAt) throw new MailError('anonymized', 409);
    const [l, d] = hit.contact.email.split('@');
    return delay({ inquiryId: hit.id, ref: hit.ref, customer: { name: hit.contact.name, emailMasked: `${l.slice(0, 2)}***@${d}`, company: hit.contact.company ?? null }, status: hit.status, createdAt: hit.createdAt });
  },
  async assign(id, inquiryRef) {
    const u = unassigned.find((x) => x.id === id); if (!u) throw new MailError('not_found', 404);
    if (u.status !== 'UNASSIGNED') throw new MailError('not_unassigned', 409);
    const l = await this.assignLookup(inquiryRef);
    unassigned.splice(unassigned.indexOf(u), 1);
    return delay({ id, inquiryId: l.inquiryId, status: 'RECEIVED' as const });
  },
  async ignore(id) {
    const u = unassigned.find((x) => x.id === id); if (!u || u.status !== 'UNASSIGNED') throw new MailError('not_unassigned', 409);
    u.status = 'IGNORED'; return delay({ id, status: 'IGNORED' as const });
  },
  async unignore(id) {
    const u = unassigned.find((x) => x.id === id); if (!u || u.status !== 'IGNORED') throw new MailError('not_unassigned', 409);
    u.status = 'UNASSIGNED'; return delay({ id, status: 'UNASSIGNED' as const });
  }
};

const ua = (id: string, days: number, p: Partial<UnassignedDetail>): UnassignedDetail => ({
  id, status: 'UNASSIGNED', redacted: false, from: 'buyer@example.com', to: 'sales@geiom.com', subject: null, bodyHtml: null, bodyText: null,
  hasRemoteImages: false, senderVerified: null, flags: [], receivedAt: ago(days * DAY), expiresAt: later((90 - days) * DAY - 30), suggestedInquiryRef: null, attachments: [], ...p
});
const unassigned: UnassignedDetail[] = [
  ua('um1', 0.2, { from: 'ivan@romashka.ru', subject: 'Re: Коммерческое предложение', senderVerified: true, suggestedInquiryRef: 'PJ-2610-QMPI', bodyText: 'Добрый день! Подтверждаем тираж 5000 шт. Макет во вложении.', bodyHtml: '<p>Добрый день! Подтверждаем тираж 5000 шт. Макет во вложении.</p>', attachments: [att('att_u1', 'maket.pdf', 'application/pdf', 1_200_000)] }),
  ua('um2', 2, { from: 'lena@nordictea-mail.example', subject: 'Order confirmation', senderVerified: false, suggestedInquiryRef: 'PJ-2610-R51F', bodyText: 'Please update our bank details: http://pay.example/xyz', bodyHtml: '<p>Please update our bank details: <a href="http://evil.example/xyz" target="_blank" rel="noopener noreferrer" title="http://evil.example/xyz" data-mismatch="1">http://pay.nordictea.se/xyz</a></p>', hasRemoteImages: true }),
  ua('um3', 5, { from: 'noreply@bloom.co', subject: 'Auto: received your message', flags: ['auto'], bodyText: 'Thanks, we received your email.', bodyHtml: '<p>Thanks, we received your email.</p>' }),
  ua('um4', 30, { from: 'MAILER-DAEMON@mx.example', subject: 'Undelivered Mail Returned to Sender', flags: ['bounce'], bodyText: 'Delivery to the following recipient failed permanently.', bodyHtml: '<p>Delivery to the following recipient failed permanently.</p>' }),
  ua('um5', 78, { from: 'designer@studio.example', subject: 'Huge files', flags: ['too_large', 'attachment_rejected'] }),
  ua('um6', 88.6, { from: 'x@weird.example', subject: null, flags: ['parse_error', 'some_future_flag'], bodyText: null }),
  ua('um7', 89.5, { redacted: true, from: null, to: null, subject: null }),
  ua('um8', 12, { status: 'IGNORED', from: 'newsletter@promo.example', subject: 'Big sale!', bodyText: 'Sale sale sale', bodyHtml: '<p>Sale sale sale</p>' }),
  ...Array.from({ length: 4 }, (_, i) => ua(`umx${i}`, 6 + i, { from: `lead${i}@example.org`, subject: `Inquiry about boxes #${i + 1}`, bodyText: 'Hello, please send a price list.', bodyHtml: '<p>Hello, please send a price list.</p>' }))
];
