import type { Role } from '@prisma/client';

export type HistoryEntry = { type: 'created' | 'status' | 'assignment' | 'reply' | 'inbound'; at: string; actor: { name: string; role: Role } | null; summary: string; cursor: string };
type AuditRow = { id: string; action: string; actorId: string | null; meta: unknown; createdAt: Date };
type MsgRow = { id: string; direction: 'OUTBOUND' | 'INBOUND'; subject: string; authorId: string | null; createdAt: Date };
type UserRow = { id: string; name: string; role: Role };

const STATUS_ZH: Record<string, string> = { NEW: '新询盘', FOLLOWING: '跟进中', QUOTED: '已报价', WON: '已成交', INVALID: '无效' };
export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 50;

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
const subj = (s: string, addr: unknown) => maskAddressIn(s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), addr).slice(0, 80);

/**
 * 询盘时间线（新的在前），只用已有数据：创建时间、审计里的状态/分配变更、往来邮件记录。
 * actor 只给姓名和角色；不含正文、附件、IP、用户 id；邮件主题里的收货地址片段会被脱敏。
 * 调用方负责范围校验：被分配的 SALES 能看到该询盘的完整时间线（包括分配给他之前的记录）。
 */
export function buildHistory(inq: { id: string; createdAt: Date; source: string }, audits: AuditRow[], messages: MsgRow[], users: UserRow[], address?: unknown): HistoryEntry[] {
  const byId = new Map(users.map((u) => [u.id, u]));
  const actor = (id: string | null) => { const u = id ? byId.get(id) : undefined; return u ? { name: u.name, role: u.role } : null; };
  const out: HistoryEntry[] = [];
  const push = (e: Omit<HistoryEntry, 'cursor'>, key: string) => out.push({ ...e, cursor: enc(e.at, key) });
  push({ type: 'created', at: inq.createdAt.toISOString(), actor: null, summary: `客户提交询盘（${inq.source}）` }, `i:${inq.id}`);
  for (const a of audits) {
    if (a.action !== 'inquiry.update') continue;
    const m = (a.meta ?? {}) as { before?: { status?: string; assigneeId?: string | null }; after?: { status?: string; assigneeId?: string | null } };
    const b = m.before ?? {}, f = m.after ?? {};
    const at = a.createdAt.toISOString();
    if (b.status && f.status && b.status !== f.status)
      push({ type: 'status', at, actor: actor(a.actorId), summary: `状态：${STATUS_ZH[b.status] ?? b.status} → ${STATUS_ZH[f.status] ?? f.status}` }, `s:${a.id}`);
    if ('assigneeId' in f && b.assigneeId !== f.assigneeId)
      push({ type: 'assignment', at, actor: actor(a.actorId), summary: f.assigneeId ? `分配给 ${byId.get(f.assigneeId)?.name ?? '（已删除账号）'}` : '取消分配' }, `a:${a.id}`);
  }
  for (const msg of messages) {
    const at = msg.createdAt.toISOString();
    if (msg.direction === 'OUTBOUND') push({ type: 'reply', at, actor: actor(msg.authorId), summary: `已回复客户：${subj(msg.subject, address)}` }, `m:${msg.id}`);
    else push({ type: 'inbound', at, actor: null, summary: `收到客户来信：${subj(msg.subject, address)}` }, `m:${msg.id}`);
  }
  const keyOf = (e: HistoryEntry) => decodeCursor(e.cursor)!;
  return out.sort((x, y) => (y.at.localeCompare(x.at) || keyOf(y).key.localeCompare(keyOf(x).key)));
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
