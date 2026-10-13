// Sanity 内容读取：服务端用 fetch 调 GROQ HTTP API，不引入 SDK，浏览器不直连 Sanity（CSP 不需要放行）。
// 未配置 SANITY_PROJECT_ID 时返回 null，页面回退到仓库内的静态内容。
export const SANITY_API_VERSION = 'v2025-02-19';
const PROJECT_RE = /^[a-z0-9]{1,32}$/;
const DATASET_RE = /^[a-z0-9_-]{1,64}$/;

export type Locale = 'en' | 'ru';
export interface SanityConfig { projectId: string; dataset: string; token?: string }

export function sanityConfig(env: Record<string, string | undefined> = process.env): SanityConfig | null {
  const projectId = env.SANITY_PROJECT_ID?.trim();
  const dataset = (env.SANITY_DATASET ?? 'production').trim();
  if (!projectId || !PROJECT_RE.test(projectId) || !DATASET_RE.test(dataset)) return null;
  return { projectId, dataset, token: env.SANITY_API_READ_TOKEN || undefined };
}

export function buildQueryUrl(cfg: SanityConfig, query: string, params: Record<string, string> = {}) {
  // 带 token 时走 api（apicdn 不接受私有数据集鉴权缓存），否则走 apicdn
  const host = cfg.token ? 'api.sanity.io' : 'apicdn.sanity.io';
  const u = new URL(`https://${cfg.projectId}.${host}/${SANITY_API_VERSION}/data/query/${cfg.dataset}`);
  u.searchParams.set('query', query);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(`$${k}`, JSON.stringify(v));
  u.searchParams.set('perspective', 'published');
  return u;
}

export async function sanityFetch<T>(query: string, params: Record<string, string> = {}, opts: { revalidate?: number; tags?: string[] } = {}): Promise<T | null> {
  const cfg = sanityConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(buildQueryUrl(cfg, query, params), {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      next: { revalidate: opts.revalidate ?? 3600, tags: ['sanity', ...(opts.tags ?? [])] },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { result?: T };
    return j.result ?? null;
  } catch { return null; }
}

const pick = (locale: Locale, field: string) => `"${field}": coalesce(${field}.${locale}, ${field}.en)`;
export const DOC_TYPES = ['product', 'solution', 'article'] as const;
export type DocType = (typeof DOC_TYPES)[number];

// 列表页只取可索引文档（排除 seo.noindex == true），空态判断也基于此。
export function listQuery(type: DocType, locale: Locale) {
  return `*[_type == "${type}" && defined(slug.${locale}.current) && seo.noindex != true] | order(_updatedAt desc){ _id, "slug": slug.${locale}.current, ${pick(locale, 'title')}, ${pick(locale, 'excerpt')} }`;
}
export function bySlugQuery(type: DocType, locale: Locale) {
  return `*[_type == "${type}" && slug.${locale}.current == $slug][0]{ _id, _updatedAt, "slug": slug.${locale}.current, "alt": { "en": slug.en.current, "ru": slug.ru.current }, ${pick(locale, 'title')}, ${pick(locale, 'excerpt')}, ${pick(locale, 'body')}, "seo": { "title": coalesce(seo.title.${locale}, seo.title.en), "description": coalesce(seo.description.${locale}, seo.description.en), "noindex": seo.noindex } }`;
}

export const getDocs = (type: DocType, locale: Locale) => sanityFetch<{ _id: string; slug: string; title: string; excerpt?: string }[]>(listQuery(type, locale), {}, { tags: [`sanity:${type}`] });
export const getDocBySlug = (type: DocType, locale: Locale, slug: string) =>
  /^[a-z0-9-]{1,96}$/.test(slug) ? sanityFetch<Record<string, unknown>>(bySlugQuery(type, locale), { slug }, { tags: [`sanity:${type}`] }) : Promise.resolve(null);
