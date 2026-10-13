import { categoryMeta } from '../seo/categoryMeta';

const CATEGORY_KEYS = new Set(categoryMeta.map((c) => c.key));
// 中间件用：判断短链接是否过期（HEAD /api/designs/:id → 410）。Edge 运行时，不依赖 Node API。
export const SHORTLINK_RE = /^\/(?:(en|ru)\/)?s\/([A-Za-z0-9]{10,16})\/?$/; // 与 DESIGN_ID_RE 一致
// 过期页和“暂时不可用”页只能经 middleware rewrite 到达，直接访问一律 404
export const EXPIRED_RE = /^\/(en|ru)\/s\/(?:expired|unavailable)\/?$/;
const TTL_MS = 60_000;
const MAX = 500;
export type Probe = { expired: boolean; category: string | null; unavailable?: true };
const cache = new Map<string, Probe & { at: number }>();

export function parseShortlink(pathname: string): { locale: 'en' | 'ru' | null; id: string } | null {
  if (EXPIRED_RE.test(pathname)) return null;
  const m = SHORTLINK_RE.exec(pathname);
  return m ? { locale: (m[1] as 'en' | 'ru' | undefined) ?? null, id: m[2] } : null;
}

/** expired=true 表示 410；null=超时/出错（放行）。category 来自 X-Design-Category，只接受 categoryMeta 里的 key。结果缓存 60 秒。 */
/** 探测配置：固定 origin（SHORTLINK_PROBE_ORIGIN 或 NEXT_PUBLIC_SITE_URL，不用请求里的 Host）；未设置则不探测（放行）。 */
export function probeConfig(env: Record<string, string | undefined>) {
  const raw = env.SHORTLINK_PROBE_ORIGIN || env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return { origin: u.origin, secret: env.MIDDLEWARE_PROBE_SECRET || null };
  } catch { return null; }
}

/** 探测请求头：只有配置了 MIDDLEWARE_PROBE_SECRET 才带密钥和原始客户端 IP（API 校验密钥后按该 IP 限流）。 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:.]{2,45}$/;
export function isIp(s: string) { return s.length <= 45 && (IPV4.test(s) || (s.includes(':') && IPV6.test(s))); }

/** 与 #177 约定：密钥 ≥32 字节才发送；客户端 IP 必须是合法 IP 且 ≤45 字符，否则两个头都不发。 */
export function probeHeaders(secret: string | null, clientIp: string | null): Record<string, string> {
  if (!secret || new TextEncoder().encode(secret).length < 32) return {};
  const ip = clientIp?.trim() ?? '';
  return isIp(ip) ? { 'x-internal-probe': secret, 'x-probe-client-ip': ip } : {};
}

export async function probeShortlink(origin: string, id: string, f: typeof fetch = fetch, now = Date.now(), headers: Record<string, string> = {}): Promise<Probe | null> {
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL_MS) return { expired: hit.expired, category: hit.category };
  try {
    const r = await f(`${origin}/api/designs/${encodeURIComponent(id)}`, { method: 'HEAD', signal: AbortSignal.timeout(1500), headers, redirect: 'manual' });
    // 503 = 数据库不可用（HEAD 路由明确返回），不缓存；其它 5xx/429 放行
    if (r.status === 503) return { expired: false, category: null, unavailable: true };
    if (r.status >= 500 || r.status === 429) return null;
    const expired = r.status === 410;
    const c = r.headers.get('x-design-category');
    const category = c && CATEGORY_KEYS.has(c) ? c : null;
    if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
    cache.set(id, { expired, category, at: now });
    return { expired, category };
  } catch { return null; }
}
export const _resetCache = () => cache.clear();
