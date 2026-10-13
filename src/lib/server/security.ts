import { randomBytes } from 'crypto';

/** 随机、不可递增的 id，用于短链接和回信 token */
export function randomId(len = 10) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

export async function verifyTurnstile(token: string | undefined, ip: string | null) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return process.env.NODE_ENV !== 'production'; // 开发环境无密钥时放行
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const j = (await r.json()) as { success?: boolean };
  return !!j.success;
}

/** 简单的内存限流（单实例）；上线后换成 Upstash/Cloudflare 限流 */
const hits = new Map<string, number[]>();
export function rateLimit(key: string, limit = 5, windowMs = 10 * 60_000) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= limit;
}

/** 去掉换行，防止邮件头注入 */
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 只信任 Cloudflare / Vercel 平台写入的头，不读可被客户端伪造的 X-Forwarded-For 首项 */
export function clientIp(req: Request) {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? null;
}

/** 按字节上限读取请求体，超出返回 null */
export async function readBody(req: Request, maxBytes: number) {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
