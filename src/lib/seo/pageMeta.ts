import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { ogLocales } from '@/i18n/locale-meta';
import { SITE_URL } from '@/lib/site';
import ogVersions from '@/data/og-versions.json';

// 每页统一的 SEO 头：canonical/hreflang、og:url（= canonical）、og/twitter 的标题和描述、分享图。
// 分享图规格：1200×630 JPG，public/og/<ogSlug>-<locale>.jpg（#208）；alt 用该页命名空间的 ogImageAlt，没有时用 Meta.ogImageAlt。
// 绝对 URL 只来自 NEXT_PUBLIC_SITE_URL（SITE_URL），绝不从请求头（host / x-forwarded-host）推导。
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// 换图后社交平台（Telegram/VK/Facebook）按 URL 缓存，所以 URL 带 ?v=<sha256 前 8 位>。
// 版本表 src/data/og-versions.json 由 design/og-src/render-og*.mjs 生成（og-versions.mjs）；测试校验它和文件内容一致。
const OG_VERSIONS: Record<string, string> = ogVersions;
export function ogImageUrl(ogSlug: string, locale: string): string {
  const file = `${ogSlug}-${locale}.jpg`;
  const v = OG_VERSIONS[file];
  const url = new URL(`/og/${file}`, SITE_URL);
  if (v) url.searchParams.set('v', v);
  return url.toString();
}

type Opts = { locale: string; path: string; title: string; description: string; ogSlug?: string; ogAlt?: string; robots?: Metadata['robots'] };

export async function pageMetadata({ locale, path, title, description, ogSlug = 'home', ogAlt, robots }: Opts): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'Meta' });
  const alternates = alternatesFor(locale, path);
  const url = new URL(alternates.canonical, SITE_URL).toString();
  const image = { url: ogImageUrl(ogSlug, locale), width: OG_WIDTH, height: OG_HEIGHT, alt: ogAlt ?? t('ogImageAlt') };
  return {
    metadataBase: new URL(SITE_URL),
    title: { absolute: title },
    description,
    alternates,
    ...(robots ? { robots } : {}),
    openGraph: {
      type: 'website',
      siteName: 'PackJoyU',
      url,
      title,
      description,
      ...ogLocales(locale),
      images: [image]
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] }
  };
}
