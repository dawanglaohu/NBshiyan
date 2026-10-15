import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { SITE_URL } from '@/lib/site';

// 每页统一的 SEO 头：canonical/hreflang、og:url（= canonical）、og/twitter 的标题和描述、分享图。
// 分享图规格：1200×630 JPG，public/og/<ogSlug>-<locale>.jpg（#208）；alt 用该页命名空间的 ogImageAlt，没有时用 Meta.ogImageAlt。
// 绝对 URL 只来自 NEXT_PUBLIC_SITE_URL（SITE_URL），绝不从请求头（host / x-forwarded-host）推导。
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

type Opts = { locale: string; path: string; title: string; description: string; ogSlug?: string; ogAlt?: string; robots?: Metadata['robots'] };

export async function pageMetadata({ locale, path, title, description, ogSlug = 'home', ogAlt, robots }: Opts): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'Meta' });
  const alternates = alternatesFor(locale, path);
  const url = new URL(alternates.canonical, SITE_URL).toString();
  const image = { url: new URL(`/og/${ogSlug}-${locale}.jpg`, SITE_URL).toString(), width: OG_WIDTH, height: OG_HEIGHT, alt: ogAlt ?? t('ogImageAlt') };
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
      locale: locale === 'ru' ? 'ru_RU' : 'en_US',
      alternateLocale: locale === 'ru' ? ['en_US'] : ['ru_RU'],
      images: [image]
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] }
  };
}
