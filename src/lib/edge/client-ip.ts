/**
 * 客户端 IP 的唯一来源（限流、审计日志、询盘、RUM、middleware 探测都走这里）。
 *
 * 生产链路：浏览器 → Cloudflare → nginx（geiom.com 自建）→ Next。
 * nginx 用 `proxy_set_header X-Edge-Auth <EDGE_AUTH_SECRET>` 给每个请求加上共享密钥。
 * 只有 X-Edge-Auth 与 EDGE_AUTH_SECRET 一致时，才把 CF-Connecting-IP 当作客户端 IP；
 * 其它情况（没配密钥、密钥不足 32 字节、没带头、头不对、CF-Connecting-IP 不是合法 IP）一律算不可信来源，
 * 返回 ip=null，调用方用 rateLimitSubject() 把它们全部放进同一个 'untrusted' 桶。
 *
 * 不再读 x-real-ip / x-forwarded-for，也不再看 BEHIND_CLOUDFLARE / TRUSTED_PROXY_HOPS（已废弃，设了也忽略）。
 *
 * 这个文件会被 middleware（Edge 运行时）引用，所以不能用 node:crypto / node:net / Buffer：
 * - 常量时间比较：先比 UTF-8 字节长度（长度不同直接 false），再逐字节 XOR 累加，循环次数只取决于长度，不会提前退出。
 *   Edge 运行时没有 crypto.timingSafeEqual，Web Crypto 也没有同步的等价 API，所以两个运行时共用这一份实现。
 * - IP 校验：IPv4 用严格的点分十进制正则；IPv6 交给 WHATWG URL 解析器（`http://[...]`）判断。
 *
 * 密钥和 X-Edge-Auth 的值绝不写日志、不放进错误信息、不回显到响应。
 */

export const EDGE_AUTH_HEADER = 'x-edge-auth';
export const EDGE_AUTH_SECRET_MIN_BYTES = 32;
/** 所有不可信请求共用的限流 key 段 */
export const UNTRUSTED = 'untrusted';

type Env = Record<string, string | undefined>;
type HeaderSource = Pick<Headers, 'get'>;

const enc = new TextEncoder();
let warnedShort = false;
let warnedLegacy = false;

/** 常量时间比较（Edge 和 Node 都能用）。长度不同返回 false；只泄露长度，不泄露内容。 */
export function constantTimeEqual(given: string, expected: string): boolean {
  const a = enc.encode(given), b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_CHARS = /^[0-9A-Fa-f:.]+$/;

/** 合法 IPv4 / IPv6 文本（不带端口、不带方括号、不带 zone id），最长 45 字符 */
export function isIpLiteral(s: string): boolean {
  if (!s || s.length > 45) return false;
  if (IPV4.test(s)) return true;
  if (!s.includes(':') || !IPV6_CHARS.test(s)) return false;
  try { return new URL(`http://[${s}]/`).hostname.length > 2; } catch { return false; }
}

/** trim 后是合法 IP 才返回，否则 null */
export function validIp(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t && isIpLiteral(t) ? t : null;
}

/** EDGE_AUTH_SECRET 可用（已设置且 ≥ 32 字节）时返回它，否则 null（fail-closed） */
export function edgeAuthSecret(env: Env): string | null {
  const s = env.EDGE_AUTH_SECRET;
  if (!s) return null;
  if (enc.encode(s).length < EDGE_AUTH_SECRET_MIN_BYTES) {
    if (!warnedShort) { warnedShort = true; console.error('[clientIp] EDGE_AUTH_SECRET is shorter than 32 bytes; all requests treated as untrusted'); }
    return null;
  }
  return s;
}

/** 请求是否带了正确的 X-Edge-Auth（即确实经过我们的 nginx） */
export function edgeAuthOk(headers: HeaderSource, env: Env): boolean {
  const secret = edgeAuthSecret(env);
  if (!secret) return false;
  const given = headers.get(EDGE_AUTH_HEADER);
  return given !== null && constantTimeEqual(given, secret);
}

export type ClientIpResult = { ip: string; trusted: true } | { ip: null; trusted: false };

/** 唯一的客户端 IP 解析函数 */
export function resolveClientIp(headers: HeaderSource, env: Env = process.env): ClientIpResult {
  if ((env.BEHIND_CLOUDFLARE || env.TRUSTED_PROXY_HOPS) && !warnedLegacy) {
    warnedLegacy = true;
    console.error('[clientIp] BEHIND_CLOUDFLARE / TRUSTED_PROXY_HOPS are no longer used; client IP comes only from CF-Connecting-IP with a valid X-Edge-Auth');
  }
  if (!edgeAuthOk(headers, env)) return { ip: null, trusted: false };
  const ip = validIp(headers.get('cf-connecting-ip'));
  return ip ? { ip, trusted: true } : { ip: null, trusted: false };
}

/** 限流 key 里的“客户端”段：可信时是 IP，不可信时所有请求共用 'untrusted' */
export function rateLimitSubject(ip: string | null): string {
  return ip ?? UNTRUSTED;
}

/** Cloudflare 写入的国家代码，只在请求经过认证的 nginx 时才信任；只接受两位字母或数字 */
export function trustedCountry(headers: HeaderSource, env: Env = process.env): string | null {
  if (!edgeAuthOk(headers, env)) return null;
  const c = headers.get('cf-ipcountry')?.trim().toUpperCase() ?? '';
  return /^[A-Z0-9]{2}$/.test(c) ? c : null; // ISO 两位码，另含 Cloudflare 的 XX（未知）、T1（Tor）
}

/** 测试用 */
export function _resetClientIpWarnings() { warnedShort = false; warnedLegacy = false; }
