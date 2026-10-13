import type { AdminApi, AdminUsersResponse, InquiryDetail } from './types';
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
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json() as Promise<T>;
}
export class NotFound extends Error { constructor() { super('not_found'); } }
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => [k, String(v)])).toString();

export const httpAdminApi: AdminApi = {
  // 后端确认的参数：q, from, to, page, pageSize, status, product, assignee=me → { items, total, page, pageSize }
  // 「待核实」(REVIEW) 不是后端状态：取全部，由页面按可信度 <40 分组
  // 「待核实」不是后端状态，用 maxScore=39 表示可信度 <40
  listInquiries: ({ status, ...q }) => call(`/inquiries?${qs({ ...q, ...(status === 'REVIEW' ? { maxScore: 39 } : { status }) })}`),
  // 业务员看别人的询盘时后端返回 404：按“不存在”处理
  getInquiry: (id) => call<InquiryDetail>(`/inquiries/${encodeURIComponent(id)}`).catch((e) => { if (e instanceof NotFound) return null; throw e; }),
  updateInquiry: (id, patch) => call(`/inquiries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  reply: (id, body) => call(`/inquiries/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify(body) }),
  addNote: (id, body) => call(`/inquiries/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  listUsers: async () => usersFromResponse(await call<AdminUsersResponse>('/users')),
  // 同源 cookie 鉴权，可直接用于 <img src>；无权限或不存在时图片加载失败（404），由页面显示占位
  logoPreview: async (uploadId) => `/api/admin/uploads/${encodeURIComponent(uploadId)}`
};
