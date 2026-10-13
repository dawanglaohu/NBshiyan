import { randomBytes } from 'crypto';
import { rateLimitStore } from './ratelimit';

/** 随机、不可递增的 id，用于短链接和回信 token */
export function randomId(len = 10) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  // 拒绝采样，避免取模偏差
  const max = 256 - (256 % abc.length);
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < max) out += abc[b % abc.length];
      if (out.length === len) break;
    }
  }
  return out;
}

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** E2E 用：非正式环境可把校验地址指向本机模拟服务（只接受 http://127.0.0.1 / localhost），正式环境始终用 Cloudflare。 */
export function turnstileVerifyUrl(env: Record<string, string | undefined> = process.env) {
  const o = env.TURNSTILE_VERIFY_URL;
  if (!o || env.VERCEL_ENV === 'production') return TURNSTILE_VERIFY;
  try { const u = new URL(o); if (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return u.toString(); } catch {}
  return TURNSTILE_VERIFY;
}

export type TurnstileResult = 'ok' | 'fail' | 'unavailable';
/** Turnstile 校验：ok 通过，fail 校验不通过，unavailable 连不上 Cloudflare（超时、网络错误、5xx）。连不上时一律不放行。 */
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
 * 非 Vercel 部署（自建反代链）可设 TRUSTED_PROXY_HOPS=N：从 x-forwarded-for 右数第 N 个取客户端 IP。
 * 默认不信任 x-forwarded-for（客户端可伪造最左侧值）。所有结果都校验是合法 IP，否则视为没有。
 */
export function clientIp(req: Request): string | null {
  const h = req.headers;
  // 默认（未设 TRUSTED_PROXY_HOPS）与原逻辑完全一致
  if (process.env.BEHIND_CLOUDFLARE === '1') {
    // Cloudflare 优先：同时设了 TRUSTED_PROXY_HOPS 时忽略它（配置错误，告警一次）
    if (process.env.TRUSTED_PROXY_HOPS && !warnedBoth) { warnedBoth = true; console.error('[clientIp] TRUSTED_PROXY_HOPS ignored because BEHIND_CLOUDFLARE=1'); }
    return h.get('cf-connecting-ip') ?? h.get('x-real-ip');
  }
  const real = h.get('x-real-ip');
  const hops = trustedProxyHops();
  if (real || hops === null) return real;
  const parts = (h.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < hops) return null;
  const ip = parts[parts.length - hops];
  return isIP(ip) ? ip : null;
}
let warnedBoth = false;
/** 合法值 1–10；未设或非法返回 null（= 不信任 x-forwarded-for） */
export function trustedProxyHops() {
  const v = process.env.TRUSTED_PROXY_HOPS;
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

/** IPv4 / IPv6 文本校验（不依赖 node:net，edge 运行时也能用） */
export function isIP(s: string) {
  if (s.length > 45) return false;
  const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  if (v4.test(s)) return true;
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) return false;
  try { return new URL(`http://[${s}]/`).hostname.length > 2; } catch { return false; }
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

/** 429 统一格式：{ error: 'rate_limited', retryAfter } + Retry-After 头（秒）。retryAfter 取窗口长度，是上限值。 */
export function tooManyRequests(retryAfterSec: number, extra: Record<string, unknown> = {}) {
  const s = Math.max(1, Math.ceil(retryAfterSec));
  return Response.json({ error: 'rate_limited', retryAfter: s, ...extra }, { status: 429, headers: { 'Retry-After': String(s), 'Cache-Control': 'no-store' } });
}
