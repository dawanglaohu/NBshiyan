import { isProdEnvFrom } from '../site';
import { PUBLISHED_LOCALES } from '@/i18n/published-locales';
// IndexNow（Yandex / Bing）推送。Refs #74。
// 只在生产环境、并且 INDEXNOW_KEY 格式合法时启用；否则所有函数都是空操作。
// 端点写死；URL 只用 NEXT_PUBLIC_SITE_URL 拼接，绝不使用 webhook 里的主机名。
// 失败永远不抛出、不重试、不阻塞调用方：只记录错误类型，不记录密钥、URL 或响应内容。
import { UpstashStore, type RateLimitStore } from '@/lib/server/ratelimit';

export const INDEXNOW_KEY_RE = /^[a-zA-Z0-9-]{8,128}$/;
export const INDEXNOW_ENDPOINT = 'https://yandex.com/indexnow';
export const DEDUPE_MS = 10 * 60_000;
const TIMEOUT_MS = 3_000;
const MAX_URLS = 10_000;
const SLUG_RE = /^[a-z0-9-]{1,96}$/;
const LOCALES = PUBLISHED_LOCALES;
const PATH_RE = new RegExp(`^/(${LOCALES.join('|')})(/[a-z0-9-]+)*$`);

type Env = Record<string, string | undefined>;

/**
 * 去重存储：只用 Upstash（serverless 多实例下内存去重无效）。
 * 没配 Upstash 时返回 null，整个功能关闭；Upstash 出错时 fallback 一律返回 false（不推送、不重试）。
 */
export function indexNowDedupeStore(env: Env = process.env): RateLimitStore | null {
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
  if (env.RATE_LIMIT_STORE !== 'upstash' || !url?.startsWith('https://') || !token) return null;
  const s = new UpstashStore(url, token, 1500, 'indexnow:');
  // Upstash 出错时按「已推过」处理（不推送），和之前的行为一致
  return { hit: (k, l, w) => s.hit(k, l, w).catch(() => false) };
}

/** 返回可用的密钥；未设置、格式不对或不是生产环境时返回 null（功能整体关闭）。 */
export function activeIndexNowKey(env: Env = process.env): string | null {
  const key = env.INDEXNOW_KEY?.trim();
  if (!isProdEnvFrom(env) || !key || !INDEXNOW_KEY_RE.test(key)) return null;
  return key;
}

/**
 * 哪些 Sanity 类型的页面已经上线、可以推送。和 sitemap 保持一致：
 * - product：等 #198 的 CATEGORY_PAGES_LIVE 改成 true 时一起改成 true。
 * - solution / article：等 #199 的路由合并、页面进 sitemap 后改成 true。
 */
export const INDEXNOW_LIVE_TYPES: Record<string, { live: boolean; prefix: string }> = {
  product: { live: false, prefix: 'products' },
  solution: { live: false, prefix: 'solutions' },
  article: { live: false, prefix: 'articles' },
};

type SlugObj = { current?: unknown } | undefined;
export type SanityWebhookDoc = {
  _type?: unknown;
  slug?: { en?: SlugObj; ru?: SlugObj };
  seo?: { noindex?: unknown };
};

/** Sanity 文档 → 需要推送的相对路径（两种语言）。noindex、未上线类型、slug 不合法的一律不推。 */
export function pathsForSanityDoc(doc: SanityWebhookDoc, live = INDEXNOW_LIVE_TYPES): string[] {
  const t = typeof doc?._type === 'string' ? live[doc._type] : undefined;
  if (!t?.live || doc.seo?.noindex === true) return [];
  return LOCALES.flatMap((l) => {
    const s = doc.slug?.[l]?.current;
    return typeof s === 'string' && SLUG_RE.test(s) ? [`/${l}/${t.prefix}/${s}`] : [];
  });
}

/** 3D 模型上架后，3D 展示页 /products 的内容变了。 */
export function pathsForModelPublish(): string[] {
  return LOCALES.map((l) => `/${l}/products`);
}

export type IndexNowDeps = {
  env?: Env;
  store?: RateLimitStore;
  fetchImpl?: typeof fetch;
  siteUrl?: string;
  log?: (msg: string) => void;
};

/** 去重（同一 URL 10 分钟内只推一次）后合并成一个 POST。永不抛出。返回实际推送的 URL 数。 */
export async function submitIndexNow(paths: string[], deps: IndexNowDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.error(m));
  try {
    const env = deps.env ?? process.env;
    const key = activeIndexNowKey(env);
    if (!key || !paths.length) return 0;
    const site = (deps.siteUrl ?? env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
    let host: string;
    try {
      const u = new URL(site);
      if (u.protocol !== 'https:') return 0;
      host = u.host;
    } catch { return 0; }
    const store = deps.store ?? indexNowDedupeStore(env);
    if (!store) return 0;
    const urls: string[] = [];
    for (const p of [...new Set(paths)]) {
      if (!PATH_RE.test(p)) continue;
      const url = `${site}${p}`;
      if (await store.hit(url, 1, DEDUPE_MS)) urls.push(url);
      if (urls.length >= MAX_URLS) break;
    }
    if (!urls.length) return 0;
    const res = await (deps.fetchImpl ?? fetch)(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key, keyLocation: `${site}/${key}.txt`, urlList: urls }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) { log(`[indexnow] errorSummary=http_${res.status}`); return 0; }
    return urls.length;
  } catch (e) {
    log(`[indexnow] errorSummary=${(e as Error)?.name ?? 'Error'}`);
    return 0;
  }
}
