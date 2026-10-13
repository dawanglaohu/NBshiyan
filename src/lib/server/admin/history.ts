import type { Role } from '@prisma/client';

export type HistoryEntry = { type: 'created' | 'status' | 'assignment' | 'reply' | 'inbound'; at: string; actor: { name: string; role: Role } | null; summary: string };
type AuditRow = { action: string; actorId: string | null; meta: unknown; createdAt: Date };
type MsgRow = { direction: 'OUTBOUND' | 'INBOUND'; authorId: string | null; createdAt: Date };
type UserRow = { id: string; name: string; role: Role };

const STATUS_ZH: Record<string, string> = { NEW: '新询盘', FOLLOWING: '跟进中', QUOTED: '已报价', WON: '已成交', INVALID: '无效' };

/**
 * 询盘时间线，只用已有数据：创建时间、审计里的状态/分配变更、往来邮件记录。
 * actor 只给姓名和角色；不含邮件正文、主题、附件、IP。调用方负责 SALES 范围校验（只对能看到的询盘调用）。
 */
export function buildHistory(inq: { createdAt: Date; source: string }, audits: AuditRow[], messages: MsgRow[], users: UserRow[]): HistoryEntry[] {
  const byId = new Map(users.map((u) => [u.id, u]));
  const actor = (id: string | null) => { const u = id ? byId.get(id) : undefined; return u ? { name: u.name, role: u.role } : null; };
  const out: HistoryEntry[] = [{ type: 'created', at: inq.createdAt.toISOString(), actor: null, summary: `客户提交询盘（${inq.source}）` }];
  for (const a of audits) {
    if (a.action !== 'inquiry.update') continue;
    const m = (a.meta ?? {}) as { before?: { status?: string; assigneeId?: string | null }; after?: { status?: string; assigneeId?: string | null } };
    const b = m.before ?? {}, f = m.after ?? {};
    if (b.status && f.status && b.status !== f.status)
      out.push({ type: 'status', at: a.createdAt.toISOString(), actor: actor(a.actorId), summary: `状态：${STATUS_ZH[b.status] ?? b.status} → ${STATUS_ZH[f.status] ?? f.status}` });
    if ('assigneeId' in f && b.assigneeId !== f.assigneeId)
      out.push({ type: 'assignment', at: a.createdAt.toISOString(), actor: actor(a.actorId), summary: f.assigneeId ? `分配给 ${byId.get(f.assigneeId)?.name ?? '（已删除账号）'}` : '取消分配' });
  }
  for (const msg of messages)
    out.push(msg.direction === 'OUTBOUND'
      ? { type: 'reply', at: msg.createdAt.toISOString(), actor: actor(msg.authorId), summary: '已回复客户' }
      : { type: 'inbound', at: msg.createdAt.toISOString(), actor: null, summary: '收到客户来信' });
  return out.sort((x, y) => x.at.localeCompare(y.at));
}
