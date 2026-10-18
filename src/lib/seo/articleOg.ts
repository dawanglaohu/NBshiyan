import crypto from 'node:crypto';
import type { Metadata } from 'next';
import { ogImageUrl, OG_WIDTH, OG_HEIGHT } from '@/lib/seo/pageMeta';
import { SITE_URL } from '@/lib/site';
import { ogLocales } from '@/i18n/locale-meta';
import { ARTICLE_OG_TEMPLATE_VERSION, ogSafeText } from '@/lib/seo/og/articleOgLayout';

// 文章分享图。
// - 文章详情页：专属图 /<locale>/articles/<slug>/og（src/app/[locale]/articles/[slug]/og/route.tsx 按标题实时生成 1200×630 PNG），
//   ?v= = 模板版本 + 语言 + 标题的 sha256 前 8 位，标题改了社交平台会重新抓图；alt = 「标题 | PackJoyU」。
// - 文章列表页、标题为空或 slug 不合规时：回退到首页通用图 public/og/home-<locale>.jpg（带 ?v=），alt 用 Meta.ogImageAlt。
//   生成接口自己出错时也 302 到同一张通用图（相对 Location）。
// 子页面一旦写 openGraph / twitter 就会整体覆盖 layout 的同名字段，所以这里原样带上 layout 的 type/siteName/locale/alternateLocale 和 twitter card，
// 只多出 images；不加 og:title / og:url 等其他字段，避免改动现有输出。
export const ARTICLE_OG_SLUG = 'home';
/** 文章 slug 白名单（安全要求）：og 路由在查 CMS 之前用它校验，og:image 也只给合规 slug 生成 */
export const ARTICLE_OG_SLUG_RE = /^[a-z0-9-]{1,120}$/;

export type ArticleOgSource = { slug?: string; title?: string };

export function articleOgVersion(locale: 'en' | 'ru', title: string): string {
  return crypto.createHash('sha256').update(`${ARTICLE_OG_TEMPLATE_VERSION}\n${locale}\n${title.trim()}`).digest('hex').slice(0, 8);
}

/** 文章专属分享图地址；条件不满足时返回 null（调用方用通用图） */
export function articleOgImageUrl(locale: 'en' | 'ru', doc?: ArticleOgSource | null): string | null {
  const title = doc?.title?.trim();
  // 标题里没有一个字体能画的字符（例如只有 emoji / 中文）时，路由也只会回退，这里直接用通用图
  if (!title || !ogSafeText(title) || !doc?.slug || !ARTICLE_OG_SLUG_RE.test(doc.slug)) return null;
  const u = new URL(`/${locale}/articles/${doc.slug}/og`, SITE_URL);
  u.searchParams.set('v', articleOgVersion(locale, title));
  return u.toString();
}

export function articleShareMeta(locale: 'en' | 'ru', alt: string, doc?: ArticleOgSource | null): Pick<Metadata, 'openGraph' | 'twitter'> {
  const own = articleOgImageUrl(locale, doc);
  const image = own
    ? { url: own, width: OG_WIDTH, height: OG_HEIGHT, alt: `${doc!.title!.trim()} | PackJoyU` }
    : { url: ogImageUrl(ARTICLE_OG_SLUG, locale), width: OG_WIDTH, height: OG_HEIGHT, alt };
  return {
    openGraph: {
      type: 'website',
      siteName: 'PackJoyU',
      ...ogLocales(locale),
      images: [image]
    },
    twitter: { card: 'summary_large_image', images: [image] }
  };
}
