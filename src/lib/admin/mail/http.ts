import type { MailApi, MailErrorBody, SendResult, SendStatus } from './types';
import { MailError } from './types';

// 真实实现：backend-plan v4 §8（/api/admin/* 下的邮件接口，同源 cookie 鉴权；写操作服务端另做 assertSameOrigin）。
// 后端接口上线前不会被调用（见 api.ts），接入时只需设置 NEXT_PUBLIC_ADMIN_API=http。

/** 409 里前端认识的 `error` 值（8.1 / 8.2 / 8.5 / 8.6 / §15 补充）；其他 409 一律当 unknown，不可重试 */
export const KNOWN_409 = ['anonymized', 'retry_limit', 'not_retryable', 'sending_disabled', 'not_unassigned'] as const;

/** 状态码 + 错误体 → MailError（纯函数，便于测试） */
export function toMailError(status: number, raw: unknown, retryAfterHeader?: string | null): MailError {
  const b = (raw && typeof raw === 'object' ? raw : {}) as MailErrorBody & { error?: unknown };
  const err = typeof b.error === 'string' ? b.error : undefined;
  if (status === 401) return new MailError('unauthorized', status);
  if (status === 404) return new MailError('not_found', status);
  if (status === 409) return new MailError(err && (KNOWN_409 as readonly string[]).includes(err) ? err : 'unknown', status, b);
  if (status === 429) {
    const hdr = Number(retryAfterHeader);
    const sec = typeof b.retryAfterSec === 'number' ? b.retryAfterSec : Number.isFinite(hdr) && hdr > 0 ? hdr : 60;
    return new MailError('rate_limited', status, { ...b, retryAfterSec: Math.max(1, Math.ceil(sec)) });
  }
  if (status === 502 && err === 'mail_failed') return new MailError('mail_failed', status, b);
  const known: Record<number, string[]> = {
    400: ['invalid'], 403: ['expired', 'bad_signature', 'forbidden_origin', 'forbidden'], 410: ['deleted'],
    413: ['too_large'], 415: ['unsupported_media_type'], 503: ['mail_not_configured', 'rate_limiter_unavailable']
  };
  if (err && known[status]?.includes(err)) return new MailError(err, status, b);
  if (status === 403) return new MailError('forbidden', status, b);
  return new MailError('unknown', status, b);
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api/admin${path}`, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
  if (!res.ok) throw toMailError(res.status, await res.json().catch(() => ({})), res.headers.get('Retry-After'));
  return res;
}
const json = async <T,>(path: string, init?: RequestInit) => (await req(path, init)).json() as Promise<T>;
const enc = encodeURIComponent;
const q = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString();

/** 201 / 202 → SendResult */
export function toSendResult(status: number, b: Record<string, unknown>): SendResult {
  if (status === 202) return { kind: 'sending', id: String(b.id), pollAfterMs: typeof b.pollAfterMs === 'number' ? b.pollAfterMs : 5000 };
  return { kind: 'sent', id: String(b.id), sentAt: (b.sentAt as string) ?? null, retryCount: Number(b.retryCount ?? 0), maxRetries: Number(b.maxRetries ?? 5) };
}
async function post(path: string, body: unknown, key: string): Promise<SendResult> {
  const res = await req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': key } });
  return toSendResult(res.status, await res.json());
}

export const httpMailApi: MailApi = {
  getConfig: () => json('/mail/config'),
  getThread: (id, cursor) => json(`/inquiries/${enc(id)}/mail?${q({ cursor, limit: '50' })}`),
  send: (id, body, key) => post(`/inquiries/${enc(id)}/mail`, body, key),
  retry: (mid, key) => post(`/mail/${enc(mid)}/retry`, {}, key),
  status: (mid) => json<SendStatus>(`/mail/${enc(mid)}/status`),
  refreshLinks: (ids) => json('/mail/attachments/links', { method: 'POST', body: JSON.stringify({ ids }) }),
  async download(url) {
    // 只允许同源的附件接口地址（downloadUrl 由服务端签发）
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/admin/mail/attachments/')) throw new MailError('unknown', 0);
    const res = await fetch(u, { credentials: 'same-origin' });
    if (!res.ok) throw toMailError(res.status, await res.json().catch(() => ({})));
    return res.blob();
  },
  unassignedCount: () => json('/mail/unassigned/count'),
  listUnassigned: (status, cursor) => json(`/mail/unassigned?${q({ status, cursor, limit: '50' })}`),
  getUnassigned: (id) => json(`/mail/${enc(id)}`),
  assignLookup: (ref) => json(`/mail/assign-lookup?${q({ ref })}`),
  assign: (id, inquiryRef) => json(`/mail/${enc(id)}/assign`, { method: 'POST', body: JSON.stringify({ inquiryRef }) }),
  ignore: (id) => json(`/mail/${enc(id)}/ignore`, { method: 'POST', body: '{}' }),
  unignore: (id) => json(`/mail/${enc(id)}/ignore`, { method: 'DELETE' })
};
