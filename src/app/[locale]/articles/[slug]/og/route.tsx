import { ImageResponse } from 'next/og';
import { getDocBySlug } from '@/lib/server/sanity';
import { ogImageUrl } from '@/lib/seo/pageMeta';
import { ArticleOgImage } from '@/lib/seo/og/ArticleOgImage';
import { articleOgFonts } from '@/lib/seo/og/articleOgFonts';
import { OG_ARTICLE } from '@/lib/seo/og/articleOgLayout';
import { ARTICLE_OG_SLUG } from '@/lib/seo/articleOg';

// 文章专属分享图 /<locale>/articles/<slug>/og（1200×630 PNG）。og:image 由 src/lib/seo/articleOg.ts 输出（带 ?v=，这里不读）。
// 按路径做 ISR 缓存（和文章页同为 1 小时）；任何一步失败（文章不存在、没有标题、字体读不到、渲染出错）都 302 到该语言的通用图，
// 所以分享卡片永远有图。渲染结果先完整读进内存再返回：ImageResponse 是流式的，不读完的话渲染错误会在 200 之后才出现，回退不了。
export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const revalidate = 3600;

type P = { params: Promise<{ locale: string; slug: string }> };
const fallback = (locale: 'en' | 'ru') => new Response(null, { status: 302, headers: { Location: ogImageUrl(ARTICLE_OG_SLUG, locale), 'Cache-Control': 'public, max-age=300' } });

export async function GET(_req: Request, { params }: P) {
  const { locale: l, slug } = await params;
  if (l !== 'en' && l !== 'ru') return new Response(null, { status: 404 });
  const locale = l;
  try {
    const d = (await getDocBySlug('article', locale, slug)) as { title?: unknown } | null;
    const title = typeof d?.title === 'string' ? d.title.trim() : '';
    if (!title) return fallback(locale);
    const res = new ImageResponse(<ArticleOgImage title={title} locale={locale} />, { ...OG_ARTICLE, fonts: await articleOgFonts() });
    const png = await res.arrayBuffer();
    if (!png.byteLength) return fallback(locale);
    return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' } });
  } catch (e) {
    console.error('[article-og] render failed, falling back to generic image:', e instanceof Error ? e.message : 'unknown error');
    return fallback(locale);
  }
}
