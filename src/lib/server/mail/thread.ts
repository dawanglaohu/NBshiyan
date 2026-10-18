import type { Prisma, PrismaClient } from '@prisma/client';
import { MAX_RETRIES } from './config';
import { htmlToText, sanitizeInboundHtml } from './sanitize';

/**
 * #340 / backend-plan v4 8.3：询盘往来邮件列表（GET /api/admin/inquiries/:id/mail）。
 * 返回结构与前端 src/lib/admin/mail/types.ts 的 ThreadPage / ThreadItem 逐字段一致：
 * - 新表 MailMessage（source:"mail"）+ 旧 InquiryMessage（source:"legacy"，只读）合并
 * - 每页取「最新的 limit 条」，页内按时间正序（旧 → 新，前端取最后一封来信作回复对象）；nextCursor 指向更早的记录
 * - 排序键 (createdAt, source, id) 复合且唯一：同一毫秒的 mail / legacy 行跨页不重复、不遗漏
 * - 字段白名单：DB 层 select 只取下面列出的列；Message-ID、sendKey、In-Reply-To、References、Worker id、
 *   idemKey、fromHash、SPF/DKIM/DMARC、租约 / 配额字段、询盘 replyToken 一律不读不回
 * - 正文输出前按 §18 白名单再净化一次（入站入库时已净化、出站是转义纯文本；这里是纵深防御，legacy 也走同一条）
 * - 第 1 阶段没有附件表：attachments 恒为 []
 * 调用方负责：邮件开关、鉴权、按 id + 权限范围查到询盘且未匿名化（否则 404）。
 */

export const THREAD_DEFAULT_LIMIT = 20;
export const THREAD_MAX_LIMIT = 50;
/** 询盘下可见的状态（UNASSIGNED / IGNORED 只属于未归类信，不会挂在询盘上；这里再兜一层） */
const THREAD_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'RECEIVED'] as const;

type Source = 'mail' | 'legacy';
/** 同一 createdAt 时的次序：legacy 在前、mail 在后（正序视角） */
const RANK: Record<Source, number> = { legacy: 0, mail: 1 };
const SRC_CODE: Record<Source, string> = { mail: 'm', legacy: 'l' };
const CODE_SRC: Record<string, Source> = { m: 'mail', l: 'legacy' };
const ROW_ID_RE = /^[a-z0-9]{20,40}$/;

export type ThreadCursor = { at: Date; source: Source; id: string };

/** 游标对前端是不透明字符串：base64url("v1|<ISO>|<m|l>|<id>") */
export function encodeThreadCursor(c: ThreadCursor): string {
  return Buffer.from(`v1|${c.at.toISOString()}|${SRC_CODE[c.source]}|${c.id}`, 'utf8').toString('base64url');
}
/** 非法（格式、版本、时间、来源、id 任一不对）→ null，路由返回 400 */
export function decodeThreadCursor(raw: string): ThreadCursor | null {
  if (!raw || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (parts.length !== 4) return null;
  const [v, iso, code, id] = parts;
  if (v !== 'v1' || !CODE_SRC[code] || !ROW_ID_RE.test(id)) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== iso) return null;
  return { at, source: CODE_SRC[code], id };
}

/** limit / cursor 查询参数校验；不认识的其他参数忽略 */
export function parseThreadQuery(sp: URLSearchParams): { ok: true; limit: number; cursor: ThreadCursor | null } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  let limit = THREAD_DEFAULT_LIMIT;
  const l = sp.get('limit');
  if (l !== null) {
    const n = /^\d{1,3}$/.test(l) ? Number(l) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > THREAD_MAX_LIMIT) fields.limit = 'bad_format'; else limit = n;
  }
  let cursor: ThreadCursor | null = null;
  const c = sp.get('cursor');
  if (c !== null) { cursor = decodeThreadCursor(c); if (!cursor) fields.cursor = 'bad_format'; }
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, limit, cursor };
}

export type ThreadAttachment = { id: string; filename: string; sniffedType: string; size: number; downloadUrl: string; expiresAt: string };
export type ThreadItem = {
  id: string; source: Source; direction: 'INBOUND' | 'OUTBOUND';
  status: (typeof THREAD_STATUSES)[number];
  deliveryStatus: 'unknown' | 'bounced'; bouncedAt: string | null;
  retryCount: number; maxRetries: number; redacted: boolean;
  from: string | null; to: string | null; authorName: string | null;
  subject: string | null; bodyHtml: string | null; bodyText: string | null; hasRemoteImages: boolean;
  senderVerified: boolean | null; flags: string[]; errorCode: string | null; retryable: boolean;
  deferredUntil: string | null; createdAt: string; sentAt: string | null; receivedAt: string | null;
  attachments: ThreadAttachment[];
};
export type ThreadPage = { anonymizedAt: string | null; items: ThreadItem[]; nextCursor: string | null };

/** 只读这些列（白名单在 DB 层就生效） */
export const MAIL_SELECT = {
  id: true, direction: true, status: true, fromAddr: true, toAddr: true, subject: true, bodyHtml: true, bodyText: true,
  hasRemoteImages: true, senderVerified: true, authorId: true, errorCode: true, retryable: true, retryCount: true,
  deferredUntil: true, deliveryStatus: true, redactedAt: true, flags: true, sentAt: true, receivedAt: true, createdAt: true,
} as const;
export const LEGACY_SELECT = { id: true, direction: true, subject: true, bodyHtml: true, authorId: true, createdAt: true } as const;

export type MailThreadRow = {
  id: string; direction: 'INBOUND' | 'OUTBOUND'; status: string; fromAddr: string; toAddr: string; subject: string; bodyHtml: string; bodyText: string;
  hasRemoteImages: boolean; senderVerified: boolean | null; authorId: string | null; errorCode: string | null; retryable: boolean; retryCount: number;
  deferredUntil: Date | null; deliveryStatus: 'UNKNOWN' | 'BOUNCED'; redactedAt: Date | null; flags: string[]; sentAt: Date | null; receivedAt: Date | null; createdAt: Date;
};
export type LegacyThreadRow = { id: string; direction: 'INBOUND' | 'OUTBOUND'; subject: string; bodyHtml: string; authorId: string | null; createdAt: Date };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
function cleanBody(html: string) {
  const s = sanitizeInboundHtml(html ?? '');
  return { html: s.html, text: htmlToText(s.html), remote: s.hasRemoteImages };
}

export function mailItem(r: MailThreadRow, authorName: string | null): ThreadItem {
  const redacted = !!r.redactedAt;
  const body = redacted ? null : cleanBody(r.bodyHtml);
  return {
    id: r.id, source: 'mail', direction: r.direction,
    status: (THREAD_STATUSES as readonly string[]).includes(r.status) ? (r.status as ThreadItem['status']) : 'RECEIVED',
    deliveryStatus: r.deliveryStatus === 'BOUNCED' ? 'bounced' : 'unknown', bouncedAt: null,
    retryCount: r.retryCount, maxRetries: MAX_RETRIES, redacted,
    from: redacted ? null : r.fromAddr, to: redacted ? null : r.toAddr, authorName: r.direction === 'OUTBOUND' ? authorName : null,
    subject: redacted ? null : r.subject,
    bodyHtml: body ? body.html : null,
    // 出站 bodyText 是管理员写的原文（复制正文用）；入站用库里的纯文本
    bodyText: redacted ? null : r.bodyText,
    hasRemoteImages: !!body && (r.hasRemoteImages || body.remote),
    senderVerified: redacted ? null : r.senderVerified,
    flags: redacted ? [] : [...(r.flags ?? [])],
    errorCode: r.errorCode, retryable: r.retryable,
    deferredUntil: r.errorCode === 'daily_cap_deferred' ? iso(r.deferredUntil) : null,
    createdAt: r.createdAt.toISOString(), sentAt: iso(r.sentAt), receivedAt: iso(r.receivedAt),
    attachments: [],
  };
}

export function legacyItem(r: LegacyThreadRow, authorName: string | null): ThreadItem {
  const body = cleanBody(r.bodyHtml);
  const out = r.direction === 'OUTBOUND';
  return {
    id: r.id, source: 'legacy', direction: r.direction, status: out ? 'SENT' : 'RECEIVED',
    deliveryStatus: 'unknown', bouncedAt: null, retryCount: 0, maxRetries: MAX_RETRIES, redacted: false,
    from: null, to: null, authorName: out ? authorName : null,
    subject: r.subject, bodyHtml: body.html, bodyText: body.text, hasRemoteImages: body.remote,
    senderVerified: null, flags: [], errorCode: null, retryable: false, deferredUntil: null,
    createdAt: r.createdAt.toISOString(), sentAt: out ? r.createdAt.toISOString() : null, receivedAt: out ? null : r.createdAt.toISOString(),
    attachments: [],
  };
}

/** 某一来源在游标「之前」（更早）的条件：按 (createdAt, rank, id) 复合键严格小于游标 */
export function beforeCursor(source: Source, c: ThreadCursor | null): Prisma.MailMessageWhereInput & Prisma.InquiryMessageWhereInput {
  if (!c) return {};
  const r = RANK[source], rc = RANK[c.source];
  if (r < rc) return { createdAt: { lte: c.at } };
  if (r > rc) return { createdAt: { lt: c.at } };
  return { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] };
}

type Tagged = { source: 'mail'; row: MailThreadRow } | { source: 'legacy'; row: LegacyThreadRow };
/** a 是否比 b 新（倒序里排在前面）。跨来源只比 createdAt + rank；同来源保持 DB 返回的顺序（避免 JS / 数据库排序规则不一致） */
function newer(a: Tagged, b: Tagged): boolean {
  const d = a.row.createdAt.getTime() - b.row.createdAt.getTime();
  if (d !== 0) return d > 0;
  return RANK[a.source] > RANK[b.source];
}

export type ThreadDb = Pick<PrismaClient, 'mailMessage' | 'inquiryMessage' | 'user'>;

export async function loadThreadPage(db: ThreadDb, inquiryId: string, limit: number, cursor: ThreadCursor | null): Promise<ThreadPage> {
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
  const [mails, legacy] = await Promise.all([
    db.mailMessage.findMany({ where: { AND: [{ inquiryId, status: { in: [...THREAD_STATUSES] } }, beforeCursor('mail', cursor)] }, orderBy, take: limit + 1, select: MAIL_SELECT }) as unknown as Promise<MailThreadRow[]>,
    db.inquiryMessage.findMany({ where: { AND: [{ inquiryId }, beforeCursor('legacy', cursor)] }, orderBy, take: limit + 1, select: LEGACY_SELECT }) as unknown as Promise<LegacyThreadRow[]>,
  ]);
  // 两路各自已倒序，归并取前 limit + 1 条
  const merged: Tagged[] = [];
  let i = 0, j = 0;
  while (merged.length < limit + 1 && (i < mails.length || j < legacy.length)) {
    const a: Tagged | undefined = i < mails.length ? { source: 'mail', row: mails[i] } : undefined;
    const b: Tagged | undefined = j < legacy.length ? { source: 'legacy', row: legacy[j] } : undefined;
    if (a && (!b || newer(a, b))) { merged.push(a); i++; } else { merged.push(b!); j++; }
  }
  const pageRows = merged.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor = merged.length > limit && last ? encodeThreadCursor({ at: last.row.createdAt, source: last.source, id: last.row.id }) : null;

  const authorIds = [...new Set(pageRows.map((t) => t.row.authorId).filter((x): x is string => !!x))];
  const users = authorIds.length ? await db.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.name]));
  const name = (id: string | null) => (id ? names.get(id) ?? null : null);

  const items = pageRows.reverse().map((t) => (t.source === 'mail' ? mailItem(t.row, name(t.row.authorId)) : legacyItem(t.row, name(t.row.authorId))));
  return { anonymizedAt: null, items, nextCursor };
}
