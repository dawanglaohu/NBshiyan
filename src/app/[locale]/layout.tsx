import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Manrope } from 'next/font/google';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { clientMessages } from '@/lib/legal/privacy';
import { routing } from '@/i18n/routing';
import { PUBLISHED_LOCALES, isPublishedLocale } from '@/i18n/published-locales';
import { localeDir, ogLocales } from '@/i18n/locale-meta';
import SiteHeader from '@/components/layout/SiteHeader';
import OrganizationJsonLd from '@/components/seo/OrganizationJsonLd';
import { SITE_URL } from '@/lib/site';
import { QuoteProvider } from '@/components/quote/QuoteProvider';
import SiteFooter from '@/components/layout/SiteFooter';
import FloatingActions from '@/components/quote/FloatingActions';
import CookieConsent from '@/components/consent/CookieConsent';
import WebVitals from '@/components/analytics/WebVitals';
import '../globals.css';

// 只加载拉丁和西里尔子集，控制字体体积
const manrope = Manrope({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-sans' });

export function generateStaticParams() {
  // 只预渲染已发布语言；routing 里预留但未发布的语言不生成页面（middleware 也会先 404）
  return PUBLISHED_LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return {
    title: t('title'),
    description: t('description'),
    openGraph: {
      type: 'website',
      siteName: 'PackJoyU',
      ...ogLocales(locale)
    },
    twitter: { card: 'summary_large_image' },
    metadataBase: new URL(SITE_URL),
    verification: {
      google: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || undefined,
      yandex: process.env.NEXT_PUBLIC_YANDEX_VERIFICATION || undefined,
      other: process.env.NEXT_PUBLIC_BING_VERIFICATION ? { 'msvalidate.01': process.env.NEXT_PUBLIC_BING_VERIFICATION } : undefined
    }
  };
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // 双保险：middleware 已对未发布语言返回 404，这里对 RSC 等绕过 middleware 的请求再挡一次
  if (!hasLocale(routing.locales, locale) || !isPublishedLocale(locale)) notFound();
  setRequestLocale(locale);
  // Privacy 文案只在服务端渲染（含 {{待Ryan确认}} 占位符），不下发到客户端
  const messages = clientMessages((await getMessages()) as Record<string, unknown>);
  return (
    <html lang={locale} dir={localeDir(locale)} className={manrope.variable}>
      <body>
        <OrganizationJsonLd locale={locale} />
        <WebVitals />
        <NextIntlClientProvider messages={messages as Parameters<typeof NextIntlClientProvider>[0]['messages']}>
          <QuoteProvider>
            <SiteHeader />
            {children}
            <SiteFooter />
            <FloatingActions />
            <CookieConsent />
          </QuoteProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
