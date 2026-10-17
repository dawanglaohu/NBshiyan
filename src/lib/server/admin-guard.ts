import { NextResponse } from 'next/server';
import { clientIp, hitRateLimit, rateLimitSubject } from '@/lib/server/security';
import { isProdEnvFrom } from '@/lib/site';

// 后台接口通用防护。登录、会话、角色由 auth.ts 的 requireAdmin() 负责，这里不涉及。

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 防跨站请求伪造：改数据的请求（POST/PUT/PATCH/DELETE）必须带 Origin 头，且在允许列表里：
 * - 生产（APP_ENV=production，isProdEnvFrom）：#323 只认 APP_ORIGIN 的 origin。不再自动放行请求自身的 origin
 *   （standalone 下 req.url 是监听地址，如 http://0.0.0.0:3000）。APP_ORIGIN 缺失或无效时一律拒绝（启动检查本来就要求它）。
 * - 非生产（本地 / CI / 预览）：与以前一样，请求自身的 origin，或 APP_ORIGIN（反向代理后域名不一致时使用）。
 * 缺 Origin 或 Origin 为 "null" 一律拒绝（与以前一样）。
 * 通过返回 null；不通过返回 403 响应，调用方直接 return。
 */
export function assertSameOrigin(req: Request, env: Record<string, string | undefined> = process.env): NextResponse | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  const origin = req.headers.get('origin');
  const allowed = new Set<string>();
  if (!isProdEnvFrom(env)) {
    try { allowed.add(new URL(req.url).origin); } catch { /* 忽略非法 URL */ }
  }
  if (env.APP_ORIGIN) {
    try { allowed.add(new URL(env.APP_ORIGIN).origin); } catch { /* 配置错误时不放行 */ }
  }
  if (!origin || origin === 'null' || !allowed.has(origin)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  return null;
}

/**
 * 后台接口限流：按「key + 客户端 IP」计数，默认每分钟 120 次。
 * 通过返回 null；超限返回 429 响应。
 * 异步，必须 await。存储可切换为 Upstash（RATE_LIMIT_STORE=upstash），见 ratelimit/index.ts。
 * 原同步 adminRateLimit 已改名，避免 `assertSameOrigin(req) ?? adminRateLimit(...)` 漏 await 时返回 Promise。
 */
export async function enforceAdminRateLimit(req: Request, key: string, limit = 120): Promise<NextResponse | null> {
  const ip = rateLimitSubject(clientIp(req));
  // 存储故障时拒绝（已登录用户，影响面小）
  if (await hitRateLimit(`admin:${key}:${ip}`, limit, 60_000, { onStoreError: 'closed' })) return null;
  return NextResponse.json(
    { error: 'rate_limited' },
    { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } }
  );
}
