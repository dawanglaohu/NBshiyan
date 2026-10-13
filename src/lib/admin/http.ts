import type { AdminApi } from './types';

// 真实实现：对应 docs/API.md「后台接口」（/api/admin/*，需登录）。
// 鉴权由 /admin 的登录保护负责，这里用同源 cookie（credentials: 'same-origin'）。
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init });
  if (res.status === 401 || res.status === 403) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json() as Promise<T>;
}
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => [k, String(v)])).toString();

export const httpAdminApi: AdminApi = {
  listInquiries: (q) => call(`/inquiries?${qs(q)}`),
  getInquiry: (id) => call(`/inquiries/${encodeURIComponent(id)}`),
  updateInquiry: (id, patch) => call(`/inquiries/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  reply: (id, body) => call(`/inquiries/${encodeURIComponent(id)}/reply`, { method: 'POST', body: JSON.stringify(body) }),
  addNote: (id, body) => call(`/inquiries/${encodeURIComponent(id)}/notes`, { method: 'POST', body: JSON.stringify({ body }) }),
  listUsers: () => call('/users')
};
