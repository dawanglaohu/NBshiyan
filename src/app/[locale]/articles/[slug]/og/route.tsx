import { getDocBySlug } from '@/lib/server/sanity';
import { ogImageUrl } from '@/lib/seo/pageMeta';
import { renderArticleOgPng } from '@/lib/seo/og/renderArticleOg';
import { ARTICLE_OG_SLUG, ARTICLE_OG_SLUG_RE } from '@/lib/seo/articleOg';
import { isPublishedLocale } from '@/lib/server/published-locales';

// 文章专属分享图 /<locale>/articles/<slug>/og（1200×630 PNG）。og:image 由 src/lib/seo/articleOg.ts 输出（带 ?v=，这里不读）。
// 安全要求（全栈/安全审）：
// - 不读请求的任何内容（Host、X-Forwarded-Host、查询参数、请求头都不用）；只用路径参数 locale + slug。
// - slug 先过白名单 ^[a-z0-9-]{1,120}$，不合规直接 404，不查 CMS、不渲染；locale 只认 en/ru。
// - 文章不存在 / 没有可渲染的标题 / 字体或渲染出错 → 302 到该语言的通用图。Location 是相对路径 /og/home-<l>.jpg?v=…
//   （只取 ogImageUrl 的 path + query，不含主机名），能通过 #328 的同站跳转检查和 deploy/smoke-lib.sh 的 loc_bad。
// - 缓存：200 → public, max-age=86400, s-maxage=604800；302 / 404 → no-store。路由本身不做 ISR（force-dynamic），
//   响应头完全由这里决定；CMS 数据仍按 sanityFetch 的 revalidate 缓存。
// - 不经过 middleware（matcher 已排除），不会下发 NEXT_LOCALE cookie；locale 由这里按 PUBLISHED_LOCALES 白名单校验，不合规 404 no-store + noindex。
// - 标题只作为 JSX 文本子节点交给 Satori（不解析 HTML），不进任何响应头。
// - 渲染只走 renderArticleOgPng（src/lib/seo/og/renderArticleOg.tsx，唯一入口）：字体只读仓库里的 src/assets/og-fonts，
//   标题先去掉字体外的字符（ogSafeText），Satori 不会去网上补字体或 emoji。
// - X-Robots-Tag: noindex 在这里设置（所有环境、所有响应），不靠 middleware；robots.txt 不加 Disallow（社交爬虫要能抓到图）。
// 渲染结果先完整读进内存再返回：ImageResponse 是流式的，不读完的话渲染错误会在 200 之后才出现，回退不了。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = { params: Promise<{ locale: string; slug: string }> };
const OG_ROBOTS = { 'X-Robots-Tag': 'noindex' } as const;
const NO_STORE = { ...OG_ROBOTS, 'Cache-Control': 'no-store' } as const;
const notFound = () => new Response(null, { status: 404, headers: NO_STORE });
const fallback = (locale: 'en' | 'ru') => {
  const u = new URL(ogImageUrl(ARTICLE_OG_SLUG, locale));
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: u.pathname + u.search } });
};

export async function GET(_req: Request, { params }: P) {
  const { locale, slug } = await params;
  // 本路由不经过 middleware（见 src/middleware.ts matcher），locale 只按 PUBLISHED_LOCALES 白名单放行，在查 CMS 之前
  if (!isPublishedLocale(locale)) return notFound();
  if (typeof slug !== 'string' || !ARTICLE_OG_SLUG_RE.test(slug)) return notFound();
  try {
    const d = (await getDocBySlug('article', locale, slug)) as { title?: unknown } | null;
    const png = await renderArticleOgPng(d?.title, locale);
    if (!png) return fallback(locale);
    return new Response(png, { status: 200, headers: { ...OG_ROBOTS, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400, s-maxage=604800' } });
  } catch (e) {
    console.error('[article-og] render failed, falling back to generic image:', e instanceof Error ? e.message : 'unknown error');
    return fallback(locale);
  }
}
