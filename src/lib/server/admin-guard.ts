import { NextResponse } from 'next/server';
import { clientIp, hitRateLimit, rateLimitSubject } from '@/lib/server/security';
import { isProdEnvFrom } from '@/lib/site';

// 后台接口通用防护。登录、会话、角色由 auth.ts 的 requireAdmin() 负责，这里不涉及。

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Origin 头必须是规范的序列化 origin（scheme://host[:port]，new URL(o).origin === o），否则不参与比较 */
function canonicalOrigin(o: string): string | null {
  try { const u = new URL(o); return u.origin !== 'null' && u.origin === o ? u.origin : null; } catch { return null; }
}

/**
 * 防跨站请求伪造：改数据的请求（POST/PUT/PATCH/DELETE）必须通过 Origin 检查。比较一律是完全相等
 * （`new URL(origin).origin === origin` 且等于允许列表里规范化后的 origin），不用 startsWith / includes / 正则，也从不看 Referer。
 * - 生产（APP_ENV=production，isProdEnvFrom）：
 *   - #323 只认 APP_ORIGIN 的 origin（每次调用时从 env 读，不在构建时内联）；不再自动放行请求自身的 origin
 *     （standalone 下 req.url 是监听地址，如 http://0.0.0.0:3000）。APP_ORIGIN 缺失或无效时一律拒绝（启动检查本来就要求它）。
 *   - 没有 Origin 头：只有 `Sec-Fetch-Site: same-origin`（浏览器设置、页面脚本不能伪造）时放行，其余 403。
 *   - `Origin: null` 一律 403（不看 Sec-Fetch-Site）。
 * - 非生产（本地 / CI / 预览）：与以前一样，允许请求自身的 origin 或 APP_ORIGIN；缺 Origin 或 Origin 为 "null" 一律 403。
 * cron（Bearer CRON_SECRET）、webhook（签名）和公开表单接口不调用这个函数，不受影响。
 * 通过返回 null；不通过返回 403 响应，调用方直接 return。
 */
export function assertSameOrigin(req: Request, env: Record<string, string | undefined> = process.env): NextResponse | null {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  const prod = isProdEnvFrom(env);
  const origin = req.headers.get('origin');
  const allowed = new Set<string>();
  if (!prod) {
    try { allowed.add(new URL(req.url).origin); } catch { /* 忽略非法 URL */ }
  }
  const appOrigin = env.APP_ORIGIN;
  if (appOrigin) {
    try { const o = new URL(appOrigin).origin; if (o !== 'null') allowed.add(o); } catch { /* 配置错误时不放行 */ }
  }
  let ok: boolean;
  if (origin === null) ok = prod && allowed.size > 0 && req.headers.get('sec-fetch-site') === 'same-origin';
  else { const o = origin === 'null' ? null : canonicalOrigin(origin); ok = o !== null && allowed.has(o); }
  if (!ok) return NextResponse.json({ error: 'forbidden_origin' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
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
