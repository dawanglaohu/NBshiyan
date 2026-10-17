import { validIp } from '../edge/client-ip';
import { secretMatches } from './uploads';

export const PROBE_SECRET_MIN_BYTES = 32;
let warned = false;

/**
 * middleware 探测请求（HEAD /api/designs/:id）的真实客户端 IP。
 * 只有 `x-internal-probe` 与 MIDDLEWARE_PROBE_SECRET 常量时间比较一致时，才信任 `x-probe-client-ip`，并校验是合法 IPv4/IPv6。
 * 没配密钥、密钥短于 32 字节、密钥不对、IP 不合法，一律返回 null，调用方按连接 IP 正常限流。
 */
export function probeClientIp(req: Request): string | null {
  const secret = process.env.MIDDLEWARE_PROBE_SECRET;
  if (!secret) return null;
  if (Buffer.byteLength(secret) < PROBE_SECRET_MIN_BYTES) {
    if (!warned) { console.warn('[probe] MIDDLEWARE_PROBE_SECRET 短于 32 字节，已忽略'); warned = true; }
    return null;
  }
  if (!secretMatches(req.headers.get('x-internal-probe'), secret)) return null;
  // 与 clientIp 共用同一个 IP 校验（src/lib/edge/client-ip.ts）
  return validIp(req.headers.get('x-probe-client-ip'))?.toLowerCase() ?? null;
}
