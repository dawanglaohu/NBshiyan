import { randomBytes } from 'crypto';
import { rateLimitStore } from './ratelimit';

/** 随机、不可递增的 id，用于短链接和回信 token */
export function randomId(len = 10) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(len);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

/** Turnstile 校验：ok 通过，fail 校验不通过，unavailable 连不上 Cloudflare（超时、网络错误、5xx）。连不上时一律不放行。 */
const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** E2E 用：非正式环境可把校验地址指向本机模拟服务（只接受 http://127.0.0.1 / localhost），正式环境始终用 Cloudflare。 */
export function turnstileVerifyUrl(env: Record<string, string | undefined> = process.env) {
  const o = env.TURNSTILE_VERIFY_URL;
  if (!o || env.VERCEL_ENV === 'production') return TURNSTILE_VERIFY;
  try { const u = new URL(o); if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return u.toString(); } catch {}
  return TURNSTILE_VERIFY;
}

export type TurnstileResult = 'ok' | 'fail' | 'unavailable';
export async function verifyTurnstile(token: string | undefined, ip: string | null): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return process.env.NODE_ENV !== 'production' ? 'ok' : 'unavailable'; // 开发环境无密钥时放行；生产缺密钥按不可用处理
  if (!token) return 'fail';
  const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
  try {
    const r = await fetch(turnstileVerifyUrl(), { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    if (r.status >= 500) return 'unavailable';
    const j = (await r.json()) as { success?: boolean };
    return j.success ? 'ok' : 'fail';
  } catch {
    return 'unavailable';
  }
}

/**
 * 限流：计一次数，返回是否仍在上限内。存储由 RATE_LIMIT_STORE 决定（内存 / Upstash），见 ./ratelimit。
 * 注意是异步的，必须 await（旧的同步 rateLimit 已删除，避免漏写 await 时 Promise 被当成 true）。
 */
export function hitRateLimit(key: string, limit = 5, windowMs = 10 * 60_000): Promise<boolean> {
  return rateLimitStore().hit(key, limit, windowMs);
}

/** 去掉换行，防止邮件头注入 */
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * 只信任平台写入的头。接入 Cloudflare 前 cf-connecting-ip 可被客户端伪造，
 * 所以只有 BEHIND_CLOUDFLARE=1 时才读它；否则读 Vercel 写入的 x-real-ip。
 */
export function clientIp(req: Request) {
  if (process.env.BEHIND_CLOUDFLARE === '1') return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
  return req.headers.get('x-real-ip');
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
