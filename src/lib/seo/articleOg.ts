import type { Metadata } from 'next';
import { ogImageUrl, OG_WIDTH, OG_HEIGHT } from '@/lib/seo/pageMeta';

// 文章列表页 / 详情页的回退分享图（文章没有专属 OG 图）：沿用首页通用图 public/og/home-<locale>.jpg（带 ?v=），alt 用 Meta.ogImageAlt。
// 子页面一旦写 openGraph / twitter 就会整体覆盖 layout 的同名字段，所以这里原样带上 layout 的 type/siteName/locale/alternateLocale 和 twitter card，
// 只多出 images；不加 og:title / og:url 等其他字段，避免改动现有输出。
export const ARTICLE_OG_SLUG = 'home';

export function articleShareMeta(locale: 'en' | 'ru', alt: string): Pick<Metadata, 'openGraph' | 'twitter'> {
  const image = { url: ogImageUrl(ARTICLE_OG_SLUG, locale), width: OG_WIDTH, height: OG_HEIGHT, alt };
  return {
    openGraph: {
      type: 'website',
      siteName: 'PackJoyU',
      locale: locale === 'ru' ? 'ru_RU' : 'en_US',
      alternateLocale: locale === 'ru' ? ['en_US'] : ['ru_RU'],
      images: [image]
    },
    twitter: { card: 'summary_large_image', images: [image] }
  };
}
