import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { SITE_URL } from '@/lib/site';

// 每页统一的 SEO 头：canonical/hreflang、og:url（= canonical）、og/twitter 的标题和描述、分享图。
// 分享图规格：1200×630 JPG，public/og/<en-slug>-<locale>.jpg；页面没有专属图时用 home-<locale>.jpg。
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

type Opts = { locale: string; path: string; title: string; description: string; ogSlug?: string; robots?: Metadata['robots'] };

export async function pageMetadata({ locale, path, title, description, ogSlug = 'home', robots }: Opts): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: 'Meta' });
  const alternates = alternatesFor(locale, path);
  const url = new URL(alternates.canonical, SITE_URL).toString();
  const image = { url: new URL(`/og/${ogSlug}-${locale}.jpg`, SITE_URL).toString(), width: OG_WIDTH, height: OG_HEIGHT, alt: t('ogImageAlt') };
  return {
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
