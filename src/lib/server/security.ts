import { isProdEnvFrom } from '../site';
import { createHmac, randomBytes } from 'crypto';
import { isIpLiteral, resolveClientIp } from '../edge/client-ip';
import { MemoryStore, rateLimitStore } from './ratelimit';

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
  if (!o || isProdEnvFrom(env)) return TURNSTILE_VERIFY;
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
 * 存储（Upstash）出错时的行为，按路由选择（#74 §2）：
 * - closed：当作超限（拒绝）。登录、2FA、后台接口、自动回复。
 * - local：退回本实例内存计数。询价、上传、方案、告警去重（默认）。
 * - open：放行。RUM。
 */
export type FailMode = 'open' | 'closed' | 'local';
export interface RateLimitOpts { onStoreError?: FailMode }

const localFallback = new MemoryStore();
let lastStoreErrorLog = 0;
/** 测试用：清掉日志去重时间 */
export function resetRateLimitLogThrottle() { lastStoreErrorLog = 0; }
/** 存储错误只记错误类型和已知的安全文案，绝不记原始 message（可能带 key、邮箱或 IP） */
function safeStoreError(e: unknown) {
  const m = (e as Error)?.message ?? '';
  if (/^upstash (\d{3}|bad response)$/.test(m)) return m;
  const n = (e as Error)?.name;
  return n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : 'error';
}

/** key 的环境前缀：Preview 和 Production 共用一个 Upstash 库时计数不混。 */
export function rateLimitEnv(env: Record<string, string | undefined> = process.env) {
  return (env.APP_ENV || env.VERCEL_ENV || env.NODE_ENV || 'development').replace(/[^a-z0-9_-]/gi, '');
}

/**
 * 邮箱等 PII 放进限流 key 之前先做 HMAC，Redis 里不存明文。
 * 密钥做域分离：subkey = HMAC(AUTH_SECRET, "ratelimit-email-v1")，再 HMAC(subkey, email)；绝不直接用 AUTH_SECRET 当 HMAC 密钥；轮换 AUTH_SECRET 只会让限流计数清零。
 * 没有 AUTH_SECRET（本地/测试）时用固定的开发密钥。
 */
export function rateLimitKeyHash(value: string, env: Record<string, string | undefined> = process.env) {
  const base = env.AUTH_SECRET || 'dev-only-rate-limit-key';
  const k = createHmac('sha256', base).update('ratelimit-email-v1').digest();
  return createHmac('sha256', k).update(value).digest('base64url').slice(0, 32);
}

/**
 * 限流：计一次数，返回是否仍在上限内。存储由 RATE_LIMIT_STORE 决定（内存 / Upstash），见 ./ratelimit。
 * key 自动加环境前缀（`<env>:<key>`）。存储出错时按 opts.onStoreError 处理，默认 local。
 * 注意是异步的，必须 await（旧的同步 rateLimit 已删除，避免漏写 await 时 Promise 被当成 true）。
 */
export async function hitRateLimit(key: string, limit = 5, windowMs = 10 * 60_000, opts: RateLimitOpts = {}): Promise<boolean> {
  const k = `${rateLimitEnv()}:${key}`;
  try {
    return await rateLimitStore().hit(k, limit, windowMs);
  } catch (e) {
    const mode = opts.onStoreError ?? 'local';
    // 日志按 10 秒去重，避免存储挂掉时刷屏；不在这里调 sendAdminAlert（它本身也走 hitRateLimit，会递归）
    const now = Date.now();
    if (now - lastStoreErrorLog > 10_000) { lastStoreErrorLog = now; console.error(`[ratelimit] store unavailable (${mode}):`, safeStoreError(e)); }
    if (mode === 'closed') return false;
    if (mode === 'open') return true;
    return localFallback.hit(k, limit, windowMs);
  }
}

/**
 * 退回一次 hitRateLimit（同一个 key 和 windowMs，同样加环境前缀）。计数最低到 0，key 不存在/窗口已过期时什么都不做。
 * 存储出错时直接忽略：不重试、不抛错、不记日志，计数保留（偏严）。不退本地兜底计数（存储正常时 hit 也没用它）。
 */
export async function refundRateLimit(key: string, windowMs = 10 * 60_000): Promise<void> {
  try { await rateLimitStore().refund(`${rateLimitEnv()}:${key}`, windowMs); } catch { /* 忽略：计数保留 */ }
}

/**
 * 删掉一组限流 key（自动加环境前缀，与 hitRateLimit 相同）。不 throw：返回 'cleared' | 'failed'，调用方只记结果，
 * 失败时计数照旧在窗口结束后过期（偏严）。日志不输出 key。
 */
export async function clearRateLimits(entries: { key: string; windowMs: number }[]): Promise<'cleared' | 'failed'> {
  const store = rateLimitStore();
  if (!store.clear) return 'failed';
  try { await store.clear(entries.map((e) => ({ key: `${rateLimitEnv()}:${e.key}`, windowMs: e.windowMs }))); return 'cleared'; } catch { return 'failed'; }
}

/** 去掉换行，防止邮件头注入 */
export const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * 客户端 IP：统一走 src/lib/edge/client-ip.ts 的 resolveClientIp（middleware 也用同一个函数）。
 * 只有 X-Edge-Auth 与 EDGE_AUTH_SECRET 常量时间比较一致时才信任 CF-Connecting-IP，并校验是合法 IPv4/IPv6；
 * 其它情况返回 null（不可信来源），限流时用 rateLimitSubject(ip) 放进共用的 'untrusted' 桶，审计记 unknown。
 * 不再读 x-real-ip / x-forwarded-for。
 */
export function clientIp(req: Request): string | null {
  return resolveClientIp(req.headers).ip;
}
export { rateLimitSubject, UNTRUSTED } from '../edge/client-ip';

/** IPv4 / IPv6 文本校验（超长直接拒绝） */
export function isIP(s: string) {
  return isIpLiteral(s);
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
