import type { AdminApi, AdminUser, AdminUsersResponse, InquiryDetail, InquiryMessage, InquiryNote, InquirySummary, Page, TrustReason } from './types';
import { usersFromResponse } from './types';

// 真实实现：对应 docs/API.md「后台接口」（/api/admin/*，需登录）。
// 鉴权由 /admin 的登录保护负责，这里用同源 cookie（credentials: 'same-origin'）。
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 403) {
    const e = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(e.error === 'forbidden_origin' ? 'forbidden_origin' : 'forbidden');
  }
  if (res.status === 404) throw new NotFound();
  // 已匿名化询盘：改状态 / 回复 / 分配一律 409（后端第六轮）
  if (res.status === 409) throw new Error('anonymized');
  if (!res.ok) {
    // 后端错误体 { error }：invalid / invalid_assignee / too_large / rate_limited / mail_failed …
    const e = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(e.error || `http_${res.status}`);
  }
  return res.json() as Promise<T>;
}
export class NotFound extends Error { constructor() { super('not_found'); } }
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => [k, String(v)])).toString();

// —— 把后端原始结构（prisma 字段）整理成页面用的结构 ——
type Raw = Record<string, unknown>;
let usersCache: Promise<AdminUser[]> | null = null;
const users = () => (usersCache ??= call<AdminUsersResponse>('/users').then(usersFromResponse).catch(() => { usersCache = null; return []; }));
const byId = (list: AdminUser[], id: unknown) => (typeof id === 'string' ? list.find((u) => u.id === id) : undefined);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

function summary(r: Raw, list: AdminUser[]): InquirySummary {
  const items = arr<{ productSlug: string; quantity?: number }>(r.items);
  const count = (r._count as { items?: number } | undefined)?.items;
  return {
    ...(r as unknown as InquirySummary),
    // 列表只给 assigneeId；详情给 assignee { id, name, email }
    assignee: (r.assignee as AdminUser | null) ?? byId(list, r.assigneeId),
    products: items.map(({ productSlug, quantity }) => ({ productSlug, quantity })),
    itemCount: count ?? items.length
  };
}
function detail(r: Raw, list: AdminUser[]): InquiryDetail {
  const who = (id: unknown) => byId(list, id)?.name ?? (typeof id === 'string' ? '同事' : undefined);
  return {
    ...(r as unknown as InquiryDetail),
    ...summary(r, list),
    items: arr(r.items),
    trustReasons: arr<TrustReason>(r.trustReasons).filter((x) => x && typeof x.label === 'string'),
    messages: arr<InquiryMessage>(r.messages).map((m) => ({ ...m, author: m.author ?? who(m.authorId) })),
    notes: arr<InquiryNote>(r.notes).map((n) => ({ ...n, author: n.author ?? who(n.authorId) ?? '' })),
    // 后端暂无附件列表和操作历史（审计日志不下发），先显示为空
    attachments: arr(r.attachments), history: arr(r.history),
    logoUploadId: (r.logoUploadId as string | null) ?? undefined
  };
}

export const httpAdminApi: AdminApi = {
  // 参数：q, from, to, page, pageSize, status, product, minScore, maxScore, assignee(me|none|id) → { items, total, page, pageSize }
  // 「待核实」不是后端状态，用 maxScore=39 表示可信度 <40
  listInquiries: async ({ status, ...q }) => {
    const [page, list] = await Promise.all([call<Page<Raw>>(`/inquiries?${qs({ ...q, ...(status === 'REVIEW' ? { maxScore: 39 } : { status }) })}`), users()]);
    return { ...page, items: page.items.map((r) => summary(r, list)) };
  },
  // 业务员看别人的询盘时后端返回 404：按“不存在”处理
  getInquiry: async (id) => {
    try { const [r, list] = await Promise.all([call<Raw>(`/inquiries/${encodeURIComponent(id)}`), users()]); return detail(r, list); }
    catch (e) { if (e instanceof NotFound) return null; throw e; }
  },
  updateInquiry: (id, patch) => call(`/inquiries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  reply: (id, body) => call(`/inquiries/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify(body) }),
  addNote: (id, body) => call(`/inquiries/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  listUsers: () => users(),
  // 同源 cookie 鉴权，可直接用于 <img src>；无权限或不存在时图片加载失败（404），由页面显示占位
  logoPreview: async (uploadId) => `/api/admin/uploads/${encodeURIComponent(uploadId)}`
};
