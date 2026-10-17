import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import PostalMime from 'postal-mime';
import type { Address, Email } from 'postal-mime';
import type { Prisma, PrismaClient } from '@prisma/client';
import { findInquiryForReply, emailHash, privacyHashReady } from '../privacy';
import { extendInquiryRetention } from '../admin/inquiries';
import { sanitizeInboundHtml, htmlToText } from './sanitize';
import { escapeHtml } from '../security';

/**
 * #74 收信：方案 A 签名 webhook（backend-plan v4 §4.0 / §4.4 / §4.5 / §5）。
 * Cloudflare Email Routing → 收信 Worker → POST /api/mail/inbound-webhook，体为 { id, raw }（raw = 原始 RFC 822）。
 * 只信 id 和 raw；Worker 附带的 from / to / subject 一律忽略，全部从 raw 自己解析。
 */
export const MAIL_MSG_MAX_BYTES = 25 * 1024 * 1024;
/** JSON 里的 raw 会转义（\r\n 等），请求体上限留余量 */
export const WEBHOOK_MAX_BODY = Math.ceil(MAIL_MSG_MAX_BYTES * 1.4);
/** webhook 限流：全局 + 按来源 IP；拿不到可信来源 IP（clientIp() 为 null）的请求共用一个更严的 untrusted 桶 */
export const WEBHOOK_RATE = { global: 600, perSource: 120, untrusted: 20, windowMs: 60_000 } as const;

export const MAX_SKEW_SEC = 300;
/** 签名防重放记录的保存时长：覆盖 ±5 分钟时间窗的两端 */
export const WEBHOOK_REPLAY_WINDOW_MS = 2 * MAX_SKEW_SEC * 1000;
const REMOTE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * 签名：X-Geiom-Signature = hex(HMAC-SHA256(MAIL_WEBHOOK_SECRET, `${timestamp}.${mailId}.${rawBody}`))。
 * 任何失败（缺头、格式错、不匹配、时间差 > 5 分钟）都只返回 false，调用方一律 401，不区分原因。
 */
export type WebhookAuthHeaders = { timestamp: string | null; mailId: string | null; signature: string | null };
export type WebhookAuthReason = 'missing_header' | 'bad_format' | 'expired' | 'bad_content_type' | 'bad_signature' | 'bad_body' | 'id_mismatch';


/** 返回原因码（只用于日志；对外一律同一个 401 体）。null = 通过 */
export function webhookHeaderProblem(h: WebhookAuthHeaders, nowMs = Date.now()): WebhookAuthReason | null {
  const { timestamp, mailId, signature } = h;
  if (!timestamp || !mailId || !signature) return 'missing_header';
  if (!/^\d{9,11}$/.test(timestamp) || !REMOTE_ID_RE.test(mailId) || !/^[0-9a-f]{64}$/i.test(signature)) return 'bad_format';
  return Math.abs(nowMs / 1000 - Number(timestamp)) <= MAX_SKEW_SEC ? null : 'expired';
}

/**
 * 读请求体之前的鉴权头检查（审查要求：头不对立即 401，不读不解析请求体）：
 * 三个头都在、格式对（时间戳 9–11 位数字、邮件 id 合规、签名 64 位十六进制）、时间戳在 ±5 分钟内。
 * HMAC 覆盖请求体，只能在读完（受上限约束的）请求体后再验，见 verifyWebhookSignature。
 */
export function precheckWebhookHeaders(h: WebhookAuthHeaders, nowMs = Date.now()): boolean {
  return webhookHeaderProblem(h, nowMs) === null;
}

/**
 * HMAC-SHA256(MAIL_WEBHOOK_SECRET, timestamp + "." + mailId + "." + 原始请求体字节)，hex——backend-plan v4 §4.0 的 Worker 契约原样实现：
 * 签名同时覆盖时间戳和请求体（还绑定邮件 id），改时间戳或体任一字节都验不过。常量时间比较。
 */
export function verifyWebhookSignature(h: WebhookAuthHeaders, rawBody: Buffer, secret: string, nowMs = Date.now()): boolean {
  if (!precheckWebhookHeaders(h, nowMs)) return false;
  const { timestamp, mailId, signature } = h as { timestamp: string; mailId: string; signature: string };
  const mac = createHmac('sha256', secret).update(`${timestamp}.${mailId}.`).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === mac.length && timingSafeEqual(given, mac);
}

export type ParsedInbound = {
  from: string; to: string; subject: string; messageId: string; inReplyTo: string | null; references: string | null;
  bodyHtml: string; bodyText: string; hasRemoteImages: boolean; flags: string[];
  recipients: string[]; auth: { spf: string | null; dkim: string | null; dmarc: string | null; verified: boolean | null };
};

const PARSE_TIMEOUT_MS = 10_000;
const MAX_HEADER_BYTES = 64 * 1024;
const flat = (a: Address[] | Address | undefined): string[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => (x.group ? x.group.map((g) => g.address) : [x.address])).filter((s): s is string => !!s).map((s) => s.trim()); // 不改大小写：reply+<token> 的 token 区分大小写
const clip = (s: string | undefined | null, n: number) => (s ?? '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, n);

/**
 * §4.5：只看最上面一条 Authentication-Results，且 authserv-id 必须是 Cloudflare（Email Routing 写入的那条）；
 * 原信里更早的同名头可以伪造，不看。SPF、DKIM 都有结果时都要 pass（DMARC 有结果时也要 pass）→ true；否则 false；找不到 → null。
 */
export function senderVerification(headers: { key: string; value: string }[]) {
  const top = headers.find((h) => h.key === 'authentication-results');
  const none = { spf: null, dkim: null, dmarc: null, verified: null } as ParsedInbound['auth'];
  if (!top) return none;
  const authserv = top.value.split(';')[0].trim().split(/\s+/)[0].toLowerCase();
  if (!/(^|\.)cloudflare\.(net|com)$/.test(authserv)) return none;
  const pick = (k: string) => (new RegExp(`\\b${k}=([a-z]+)`, 'i').exec(top.value)?.[1] ?? null)?.toLowerCase() ?? null;
  const spf = pick('spf'), dkim = pick('dkim'), dmarc = pick('dmarc');
  if (!spf && !dkim && !dmarc) return none;
  const verified = !!spf && !!dkim && spf === 'pass' && dkim === 'pass' && (dmarc === null || dmarc === 'pass');
  return { spf, dkim, dmarc, verified };
}

function headerFlags(email: Email, from: string): string[] {
  const f: string[] = [];
  const get = (k: string) => email.headers.find((h) => h.key === k)?.value?.trim().toLowerCase();
  const auto = get('auto-submitted');
  if ((auto && auto !== 'no') || get('x-autoreply') !== undefined || get('x-autorespond') !== undefined || /^(auto_reply|bulk|list)$/.test(get('precedence') ?? '')) f.push('auto');
  const ct = get('content-type') ?? '';
  if ((/multipart\/report/.test(ct) && /report-type="?delivery-status/.test(ct)) || /^(mailer-daemon|postmaster)@/i.test(from)) f.push('bounce');
  if (email.attachments.length) f.push('attachment_rejected'); // 第 1 阶段这一步还没有附件存储：附件一律不存，并如实标记
  return f;
}

function headerBlockBytes(raw: Buffer): number {
  const i = raw.indexOf('\r\n\r\n'), j = raw.indexOf('\n\n');
  const cut = [i, j].filter((x) => x >= 0);
  return cut.length ? Math.min(...cut) : raw.length;
}

/** 解析原始 MIME（M4 上限）。失败抛错，由调用方记 parse_error */
export async function parseInbound(raw: Buffer): Promise<ParsedInbound> {
  if (raw.length > MAIL_MSG_MAX_BYTES) throw Object.assign(new Error('too_large'), { code: 'too_large' });
  if (headerBlockBytes(raw) > MAX_HEADER_BYTES) throw Object.assign(new Error('headers_too_large'), { code: 'headers_too_large' });
  let timer: NodeJS.Timeout | undefined;
  const email = await Promise.race([
    PostalMime.parse(raw, { maxNestingDepth: 10, maxPartCount: 100, maxHeadersSize: MAX_HEADER_BYTES, attachmentEncoding: 'arraybuffer', maxRfc822NestingDepth: 2 }),
    new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('parse_timeout'), { code: 'parse_timeout' })), PARSE_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  // 解码后的总量也算进 25MB（防 base64 / quoted-printable 膨胀）
  const decoded = Buffer.byteLength(email.html ?? '') + Buffer.byteLength(email.text ?? '') + email.attachments.reduce((n, a) => n + (typeof a.content === 'string' ? a.content.length : a.content.byteLength), 0);
  if (decoded > MAIL_MSG_MAX_BYTES) throw Object.assign(new Error('too_large'), { code: 'too_large' });
  const from = flat(email.from)[0] ?? '';
  const recipients = [...flat(email.to), ...flat(email.cc), ...(email.deliveredTo ? [email.deliveredTo.trim()] : []),
    ...email.headers.filter((h) => h.key === 'x-forwarded-to' || h.key === 'delivered-to').map((h) => h.value.trim())];
  const s = email.html ? sanitizeInboundHtml(email.html) : { html: email.text ? escapeHtml(email.text).replace(/\r?\n/g, '<br>') : '', hasRemoteImages: false };
  const bodyText = (email.text ?? (email.html ? htmlToText(s.html) : '')).slice(0, 200_000);
  return {
    from: clip(from, 320), to: clip(flat(email.to)[0], 320), subject: clip(email.subject, 998),
    messageId: clip(email.messageId, 998) || `<${createHash('sha256').update(raw).digest('hex')}@inbound.local>`,
    inReplyTo: clip(email.inReplyTo, 998) || null, references: clip(email.references, 2000) || null,
    bodyHtml: s.html, bodyText, hasRemoteImages: s.hasRemoteImages, flags: headerFlags(email, from), recipients,
    auth: senderVerification(email.headers),
  };
}

/** reply+<token>@REPLY_DOMAIN → token */
export function replyTokens(recipients: string[], replyDomain: string | undefined): string[] {
  if (!replyDomain) return [];
  const d = replyDomain.toLowerCase();
  const out: string[] = [];
  for (const r of recipients) {
    for (const m of r.matchAll(/reply\+([A-Za-z0-9_-]{16,64})@([a-z0-9.-]+)/gi)) if (m[2].toLowerCase() === d) out.push(m[1]);
  }
  return [...new Set(out)];
}
const msgIds = (s: string | null) => (s ?? '').match(/<[^<>\s]{1,500}>/g) ?? [];

type Db = Pick<PrismaClient, 'inquiry' | 'mailMessage' | '$transaction'>;

/**
 * §5 匹配（第一个命中即停，绝不只看发件人）：
 * 1. 收件地址里的 reply+<token>@REPLY_DOMAIN → findInquiryForReply（拒绝已匿名化）
 * 2. In-Reply-To / References 只匹配我们发出的（OUTBOUND）信的 Message-ID，命中后再用该询盘的 token 过 findInquiryForReply；
 *    保守起见还要求收件人里有本域地址
 * 3. 都不中 → 未归类（inquiryId = null）
 * 退信（bounce）第 1 阶段一律进未归类。
 */
export async function matchInquiry(db: Db, p: ParsedInbound, replyDomain: string | undefined): Promise<{ inquiryId: string | null; via: 'token' | 'thread' | 'none' }> {
  if (p.flags.includes('bounce')) return { inquiryId: null, via: 'none' };
  for (const t of replyTokens(p.recipients, replyDomain)) {
    const inq = await findInquiryForReply(db, t);
    if (inq) return { inquiryId: inq.id, via: 'token' };
  }
  const ids = [...msgIds(p.inReplyTo), ...msgIds(p.references)].slice(0, 50);
  const d = replyDomain?.toLowerCase();
  if (ids.length && d && p.recipients.some((r) => r.toLowerCase().endsWith(`@${d}`))) {
    const hit = await db.mailMessage.findFirst({ where: { direction: 'OUTBOUND', messageId: { in: ids }, inquiryId: { not: null } }, select: { inquiryId: true } });
    if (hit?.inquiryId) {
      const inq = await db.inquiry.findFirst({ where: { id: hit.inquiryId }, select: { replyToken: true } });
      const ok = inq ? await findInquiryForReply(db, inq.replyToken) : null;
      if (ok) return { inquiryId: ok.id, via: 'thread' };
    }
  }
  return { inquiryId: null, via: 'none' };
}

export type IngestResult = { result: 'stored' | 'duplicate' | 'dropped_anonymized' | 'parse_error'; id?: string; inquiryId?: string | null };
type AuditFn = (e: { action: string; target?: string | null; meta?: Prisma.InputJsonValue }) => Promise<void>;

/**
 * 入库（持久化成功后调用方才回 2xx）。去重靠 remoteMailId / messageId 唯一约束：命中一律跳过，绝不 upsert 覆盖（M3）。
 * 解析失败也入库为未归类 + parse_error（只存 Worker id 和占位），不让 Worker 无限重推。
 * 写入时在事务里用 anonymizedAt IS NULL 再确认一次；期间被匿名化 → 丢弃正文，只写审计（不含地址和内容）。
 */
export async function ingestRaw(db: Db, remoteMailId: string, raw: Buffer, opts: { replyDomain?: string; now?: Date; audit?: AuditFn } = {}): Promise<IngestResult> {
  const now = opts.now ?? new Date();
  const exists = await db.mailMessage.findUnique({ where: { remoteMailId }, select: { id: true } });
  if (exists) return { result: 'duplicate', id: exists.id };
  let p: ParsedInbound;
  try { p = await parseInbound(raw); } catch (e) {
    const code = String((e as { code?: unknown })?.code ?? 'parse_error');
    const flags = code === 'too_large' ? ['too_large'] : ['parse_error'];
    try {
      const row = await db.mailMessage.create({ data: { direction: 'INBOUND', status: 'UNASSIGNED', remoteMailId, fromAddr: '', toAddr: '', subject: '', bodyHtml: '', bodyText: '', flags, receivedAt: now } });
      return { result: 'parse_error', id: row.id, inquiryId: null };
    } catch (e2) { if ((e2 as { code?: string })?.code === 'P2002') return { result: 'duplicate' }; throw e2; }
  }
  // 同一 Message-ID 已入库 → duplicate，不再匹配、不写库（Message-ID 唯一约束兜底并发）
  if (p.messageId) {
    const dup = await db.mailMessage.findUnique({ where: { messageId: p.messageId }, select: { id: true } });
    if (dup) return { result: 'duplicate', id: dup.id };
  }
  const match = await matchInquiry(db, p, opts.replyDomain);
  let fromHash: string | null = null;
  if (p.from && privacyHashReady()) { try { fromHash = emailHash(p.from); } catch { fromHash = null; } }
  const data = {
    direction: 'INBOUND' as const, remoteMailId, messageId: p.messageId, inReplyTo: p.inReplyTo, references: p.references,
    fromAddr: p.from, fromHash, toAddr: p.to, subject: p.subject, bodyHtml: p.bodyHtml, bodyText: p.bodyText,
    hasRemoteImages: p.hasRemoteImages, authSpf: p.auth.spf, authDkim: p.auth.dkim, authDmarc: p.auth.dmarc, senderVerified: p.auth.verified,
    flags: p.flags, receivedAt: now,
  };
  try {
    const out = await db.$transaction(async (tx) => {
      if (match.inquiryId) {
        if (!(await extendInquiryRetention(tx, match.inquiryId, now))) return { dropped: true as const };
        const row = await tx.mailMessage.create({ data: { ...data, status: 'RECEIVED', inquiryId: match.inquiryId } });
        return { row };
      }
      const row = await tx.mailMessage.create({ data: { ...data, status: 'UNASSIGNED', inquiryId: null } });
      return { row };
    });
    if ('dropped' in out) {
      await opts.audit?.({ action: 'mail.inbound_dropped_anonymized', target: null, meta: { remoteMailId } });
      return { result: 'dropped_anonymized' };
    }
    return { result: 'stored', id: out.row.id, inquiryId: out.row.inquiryId };
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') return { result: 'duplicate' }; // 同一 Worker id 或同一 Message-ID：跳过，不覆盖
    throw e;
  }
}
