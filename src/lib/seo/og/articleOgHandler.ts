import { ogImageUrl } from '@/lib/seo/pageMeta';
import { ARTICLE_OG_SLUG, ARTICLE_OG_SLUG_RE, articleOgImageUrl } from '@/lib/seo/articleOg';

/**
 * 文章分享图 /<locale>/articles/<slug>/og 的处理逻辑。路由（src/app/[locale]/articles/[slug]/og/route.tsx）只把真实依赖传进来，
 * 测试传假的（可以断言「v 格式不对时根本不查 CMS」）。安全规则见路由文件头注释；#350 追加：
 * - 先校验 locale、slug 白名单、v 格式（恰好 8 位小写十六进制，= articleOgVersion 的输出格式），任何一项不对 → 404 no-store，不查 CMS。
 * - 期望的 v 由页面生成 og:image 的同一个函数算出：articleOgImageUrl(locale, { slug: d.slug ?? slug, title: d.title })
 *   （和 cmsPages.tsx 的 detailMetadata → articleShareMeta 传的值完全一样），再取它的 v。对不上 / 文章不存在 → 404 no-store，不渲染。
 * - v 正确：渲染成功 200（public, max-age=31536000, immutable）；渲染不出来或出错 → 302 相对 Location 到通用图（no-store）。
 */
export const ARTICLE_OG_VERSION_RE = /^[0-9a-f]{8}$/;

export type ArticleOgDeps = {
  getDoc: (locale: 'en' | 'ru', slug: string) => Promise<unknown>;
  render: (title: unknown, locale: 'en' | 'ru') => Promise<ArrayBuffer | null>;
};

const OG_ROBOTS = { 'X-Robots-Tag': 'noindex' } as const;
const NO_STORE = { ...OG_ROBOTS, 'Cache-Control': 'no-store' } as const;
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });
const fallback = (locale: 'en' | 'ru') => {
  const u = new URL(ogImageUrl(ARTICLE_OG_SLUG, locale));
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: u.pathname + u.search } });
};

/** 只读查询参数 v（其他参数一律忽略）；格式不对就当没有 */
export const articleOgVersionParam = (reqUrl: string): string | null => {
  const v = new URL(reqUrl).searchParams.get('v');
  return v && ARTICLE_OG_VERSION_RE.test(v) ? v : null;
};

/** 页面 og:image 里的 v（同一个函数、同一组参数）；页面不出专属图时为 null */
export const expectedArticleOgVersion = (locale: 'en' | 'ru', slug: string, doc: { slug?: unknown; title?: unknown } | null): string | null => {
  if (!doc) return null;
  const url = articleOgImageUrl(locale, { slug: typeof doc.slug === 'string' ? doc.slug : slug, title: typeof doc.title === 'string' ? doc.title : undefined });
  return url ? new URL(url).searchParams.get('v') : null;
};

export async function handleArticleOg(reqUrl: string, locale: string, slug: unknown, deps: ArticleOgDeps): Promise<Response> {
  if (locale !== 'en' && locale !== 'ru') return notFound();
  if (typeof slug !== 'string' || !ARTICLE_OG_SLUG_RE.test(slug)) return notFound();
  const v = articleOgVersionParam(reqUrl);
  if (!v) return notFound();
  try {
    const d = (await deps.getDoc(locale, slug)) as { slug?: unknown; title?: unknown } | null;
    const expected = expectedArticleOgVersion(locale, slug, d);
    if (!expected || expected !== v) return notFound();
    const png = await deps.render(d!.title, locale);
    if (!png) return fallback(locale);
    return new Response(png, { status: 200, headers: { ...OG_ROBOTS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } catch (e) {
    console.error('[article-og] render failed, falling back to generic image:', e instanceof Error ? e.message : 'unknown error');
    return fallback(locale);
  }
}
