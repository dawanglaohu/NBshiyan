import type { Role } from '@prisma/client';
import sanitizeHtml from 'sanitize-html';

/**
 * 时间线上「谁做的」：
 * - customer：客户提交询盘、客户来信（旧表 / 新表）。actor = { name: 净化后的客户名, role: null }；询盘已匿名化 → name '[deleted]'
 * - user：现有后台账号。actor = { name, role }
 * - deleted_user：记录里有操作人 id，但账号已删除（user.delete 物理删除，AuditLog 没存当时的名字）。actor = null
 * - system：没有操作人 id 的非客户事件（cron、收信 webhook 等自动操作）。actor = null
 */
export type ActorKind = 'customer' | 'user' | 'deleted_user' | 'system';
export type HistoryActor = { name: string; role: Role } | { name: string; role: null };
export type HistoryEntry = {
  type: 'created' | 'status' | 'assignment' | 'reply' | 'inbound';
  at: string;
  actorKind: ActorKind;
  actor: HistoryActor | null;
  summary: string;
  cursor: string;
};
type AuditRow = { id: string; action: string; actorId: string | null; meta: unknown; createdAt: Date };
/** 旧表 InquiryMessage（只读） */
type MsgRow = { id: string; direction: 'OUTBOUND' | 'INBOUND'; subject: string; authorId: string | null; createdAt: Date };
/** #74 新表 MailMessage：只取这几列（不取正文、地址、Message-ID、sendKey） */
export type MailHistoryRow = { id: string; direction: 'OUTBOUND' | 'INBOUND'; status: string; subject: string; authorId: string | null; redactedAt: Date | null; createdAt: Date };
type UserRow = { id: string; name: string; role: Role };
export type HistoryInquiry = { id: string; createdAt: Date; source: string; anonymizedAt?: Date | null; customerName?: string | null };

const STATUS_ZH: Record<string, string> = { NEW: '新询盘', FOLLOWING: '跟进中', QUOTED: '已报价', WON: '已成交', INVALID: '无效' };
export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 50;
/** 询盘下会出现在时间线上的新表状态（UNASSIGNED / IGNORED 只属于未归类信） */
export const HISTORY_MAIL_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'RECEIVED'] as const;
/** DB 层白名单：新表只读这些列 */
export const HISTORY_MAIL_SELECT = { id: true, direction: true, status: true, subject: true, authorId: true, redactedAt: true, createdAt: true } as const;

export const DELETED = '[deleted]';
export const SUBJECT_MAX = 80;

/**
 * 游标对前端不透明：base64url("<ISO>|<key>")，与旧版完全一致。key 带来源前缀：
 * i: 询盘创建、s: 状态变更、a: 分配变更、m: 旧表 InquiryMessage、mm: 新表 MailMessage。
 */
const enc = (at: string, key: string) => Buffer.from(`${at}|${key}`).toString('base64url');
export function decodeCursor(c: string): { at: string; key: string } | null {
  try {
    const [at, key] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    return at && key && !Number.isNaN(Date.parse(at)) && /^[\w:.-]{1,80}$/.test(key) ? { at, key } : null;
  } catch { return null; }
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 把文本里出现的收货地址片段（街道、城市、州、邮编）替换成 ***，与详情脱敏一致 */
export function maskAddressIn(text: string, address: unknown) {
  if (!address || typeof address !== 'object') return text;
  const a = address as Record<string, unknown>;
  const parts = ['line1', 'line2', 'city', 'state', 'postalCode'].map((k) => a[k]).filter((v): v is string => typeof v === 'string' && v.trim().length >= 2);
  return parts.sort((x, y) => y.length - x.length).reduce((t, p) => t.replace(new RegExp(escRe(p.trim()), 'gi'), '***'), text);
}

// C0 / C1 控制字符、DEL、零宽和双向控制符（防止伪造显示顺序）
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;
const EMAIL_IN_TEXT = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+/g;
/**
 * 客户写的文字（邮件主题、客户名）按 §18 转纯文本：去掉标签（script/style 连内容）、实体还原、
 * 控制字符换空格、空白合并；邮箱地址替换成 ***@***，收货地址片段替换成 ***；最后按字符截到 max。
 * 输出只用于纯文本显示（前端不用 innerHTML）。
 */
export function plainCustomerText(input: string, address?: unknown, max = SUBJECT_MAX): string {
  const noTags = sanitizeHtml(String(input ?? ''), { allowedTags: [], allowedAttributes: {}, nonTextTags: ['script', 'style', 'textarea', 'noscript', 'title', 'template'] })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const flat = noTags.replace(CTRL, ' ').replace(/\s+/g, ' ').trim();
  const masked = maskAddressIn(flat.replace(EMAIL_IN_TEXT, '***@***'), address);
  return [...masked].slice(0, max).join('');
}

const subjectOf = (s: string, addr: unknown, gone: boolean) => (gone || !s || s === DELETED ? DELETED : plainCustomerText(s, addr) || '（无主题）');

const OUT_STATUS: Record<string, string> = { SENT: '已回复客户', FAILED: '回复客户（发送失败）', QUEUED: '回复客户（排队待发）', SENDING: '回复客户（发送中）' };

/** 码点比较（不用 localeCompare）：排序和 pageHistory 的游标比较用同一规则，同一时间的记录跨页不重复、不遗漏 */
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * 询盘时间线（新的在前），只用已有数据：创建时间、审计里的状态/分配变更、旧表 InquiryMessage 和新表 MailMessage 往来邮件。
 * actor 只给姓名和角色；不含正文、附件、IP、用户 id、对方邮箱、Message-ID；邮件主题和客户名按 §18 转纯文本并脱敏、截到 80 字。
 * 询盘已匿名化：客户名和所有主题都显示 [deleted]。
 * 新旧两张表不去重：两边之间没有服务端 messageId 或关联字段（旧 /reply 只写旧表，#74 发信 / 收信只写新表），不按主题 + 时间猜。
 * 调用方负责范围校验：被分配的 SALES 能看到该询盘的完整时间线（包括分配给他之前的记录）。
 */
export function buildHistory(inq: HistoryInquiry, audits: AuditRow[], messages: MsgRow[], users: UserRow[], address?: unknown, mails: MailHistoryRow[] = []): HistoryEntry[] {
  const byId = new Map(users.map((u) => [u.id, u]));
  const gone = !!inq.anonymizedAt;
  const customer = (): Pick<HistoryEntry, 'actorKind' | 'actor'> => ({
    actorKind: 'customer',
    actor: { name: gone || !inq.customerName || inq.customerName === DELETED ? DELETED : plainCustomerText(inq.customerName, address) || DELETED, role: null },
  });
  const staff = (id: string | null): Pick<HistoryEntry, 'actorKind' | 'actor'> => {
    if (!id) return { actorKind: 'system', actor: null };
    const u = byId.get(id);
    return u ? { actorKind: 'user', actor: { name: u.name, role: u.role } } : { actorKind: 'deleted_user', actor: null };
  };
  const out: HistoryEntry[] = [];
  const push = (e: Omit<HistoryEntry, 'cursor'>, key: string) => out.push({ type: e.type, at: e.at, actorKind: e.actorKind, actor: e.actor, summary: e.summary, cursor: enc(e.at, key) });
  push({ type: 'created', at: inq.createdAt.toISOString(), ...customer(), summary: `客户提交询盘（${inq.source}）` }, `i:${inq.id}`);
  for (const a of audits) {
    if (a.action !== 'inquiry.update') continue;
    const m = (a.meta ?? {}) as { before?: { status?: string; assigneeId?: string | null }; after?: { status?: string; assigneeId?: string | null } };
    const b = m.before ?? {}, f = m.after ?? {};
    const at = a.createdAt.toISOString();
    if (b.status && f.status && b.status !== f.status)
      push({ type: 'status', at, ...staff(a.actorId), summary: `状态：${STATUS_ZH[b.status] ?? b.status} → ${STATUS_ZH[f.status] ?? f.status}` }, `s:${a.id}`);
    if ('assigneeId' in f && b.assigneeId !== f.assigneeId)
      push({ type: 'assignment', at, ...staff(a.actorId), summary: f.assigneeId ? `分配给 ${byId.get(f.assigneeId)?.name ?? '（已删除账号）'}` : '取消分配' }, `a:${a.id}`);
  }
  for (const msg of messages) {
    const at = msg.createdAt.toISOString();
    const s = subjectOf(msg.subject, address, gone);
    if (msg.direction === 'OUTBOUND') push({ type: 'reply', at, ...staff(msg.authorId), summary: `已回复客户：${s}` }, `m:${msg.id}`);
    else push({ type: 'inbound', at, ...customer(), summary: `收到客户来信：${s}` }, `m:${msg.id}`);
  }
  for (const mail of mails) {
    if (!(HISTORY_MAIL_STATUSES as readonly string[]).includes(mail.status)) continue;
    const at = mail.createdAt.toISOString();
    const s = subjectOf(mail.subject, address, gone || !!mail.redactedAt);
    if (mail.direction === 'OUTBOUND') push({ type: 'reply', at, ...staff(mail.authorId), summary: `${OUT_STATUS[mail.status] ?? '回复客户'}：${s}` }, `mm:${mail.id}`);
    else push({ type: 'inbound', at, ...customer(), summary: `收到客户来信：${s}` }, `mm:${mail.id}`);
  }
  const keyOf = (e: HistoryEntry) => decodeCursor(e.cursor)!.key;
  return out.sort((x, y) => cmp(y.at, x.at) || cmp(keyOf(y), keyOf(x)));
}

/** 按游标分页（新的在前）；before 无效时按第一页处理由调用方决定，这里返回 null 表示游标非法 */
export function pageHistory(all: HistoryEntry[], limit: number, before?: string) {
  let start = 0;
  if (before) {
    const c = decodeCursor(before);
    if (!c) return null;
    start = all.findIndex((e) => { const k = decodeCursor(e.cursor)!; return e.at < c.at || (e.at === c.at && k.key < c.key); });
    if (start < 0) start = all.length;
  }
  return { items: all.slice(start, start + limit), total: all.length };
}
