import { NextResponse } from 'next/server';
import { clientIp, rateLimit } from '@/lib/server/security';

// 后台接口通用防护。登录、会话、角色由 auth.ts 的 requireAdmin() 负责，这里不涉及。

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 防跨站请求伪造：改数据的请求（POST/PUT/PATCH/DELETE）必须带 Origin 头，
 * 且等于请求自身的 origin，或环境变量 APP_ORIGIN（反向代理后域名不一致时使用）。
 * 通过返回 null；不通过返回 403 响应，调用方直接 return。
 */
export function assertSameOrigin(req: Request): NextResponse | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  const origin = req.headers.get('origin');
  const allowed = new Set<string>();
  try { allowed.add(new URL(req.url).origin); } catch { /* 忽略非法 URL */ }
  if (process.env.APP_ORIGIN) {
    try { allowed.add(new URL(process.env.APP_ORIGIN).origin); } catch { /* 配置错误时不放行 */ }
  }
  if (!origin || origin === 'null' || !allowed.has(origin)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  return null;
}

/**
 * 后台接口限流：按「key + 客户端 IP」计数，默认每分钟 120 次。
 * 通过返回 null；超限返回 429 响应。
 * 注意：底层 rateLimit 是单实例内存计数，上线前要换成共享存储（见 PRD 第 11 节）。
 */
export function adminRateLimit(req: Request, key: string, limit = 120): NextResponse | null {
  const ip = clientIp(req) ?? 'unknown';
  if (rateLimit(`admin:${key}:${ip}`, limit, 60_000)) return null;
  return NextResponse.json(
    { error: 'rate_limited' },
    { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } }
  );
}
