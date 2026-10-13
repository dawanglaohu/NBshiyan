import { categoryMeta } from '../seo/categoryMeta';

const CATEGORY_KEYS = new Set(categoryMeta.map((c) => c.key));
// 中间件用：判断短链接是否过期（HEAD /api/designs/:id → 410）。Edge 运行时，不依赖 Node API。
export const SHORTLINK_RE = /^\/(?:(en|ru)\/)?s\/([A-Za-z0-9_-]{8,64})\/?$/;
export const EXPIRED_RE = /^\/(en|ru)\/s\/expired\/?$/;
const TTL_MS = 60_000;
const MAX = 500;
export type Probe = { expired: boolean; category: string | null };
const cache = new Map<string, Probe & { at: number }>();

export function parseShortlink(pathname: string): { locale: 'en' | 'ru' | null; id: string } | null {
  if (EXPIRED_RE.test(pathname)) return null;
  const m = SHORTLINK_RE.exec(pathname);
  return m ? { locale: (m[1] as 'en' | 'ru' | undefined) ?? null, id: m[2] } : null;
}

/** expired=true 表示 410；null=超时/出错（放行）。category 来自 X-Design-Category，只接受 categoryMeta 里的 key。结果缓存 60 秒。 */
export async function probeShortlink(origin: string, id: string, f: typeof fetch = fetch, now = Date.now()): Promise<Probe | null> {
  const hit = cache.get(id);
  if (hit && now - hit.at < TTL_MS) return { expired: hit.expired, category: hit.category };
  try {
    const r = await f(`${origin}/api/designs/${encodeURIComponent(id)}`, { method: 'HEAD', signal: AbortSignal.timeout(1500), headers: { 'x-shortlink-probe': '1' } });
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
