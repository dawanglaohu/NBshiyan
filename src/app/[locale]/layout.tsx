import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Manrope } from 'next/font/google';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { Link } from '@/i18n/navigation';
import OrganizationJsonLd from '@/components/seo/OrganizationJsonLd';
import { SITE_URL } from '@/lib/site';
import { QuoteProvider } from '@/components/quote/QuoteProvider';
import FloatingActions from '@/components/quote/FloatingActions';
import CookieConsent from '@/components/consent/CookieConsent';
import '../globals.css';

// 只加载拉丁和西里尔子集，控制字体体积
const manrope = Manrope({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-sans' });

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return {
    title: t('title'),
    description: t('description'),
    metadataBase: new URL(SITE_URL)
  };
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('Nav');
  return (
    <html lang={locale} className={manrope.variable}>
      <body>
        <OrganizationJsonLd locale={locale} />
        <NextIntlClientProvider>
          <QuoteProvider>
            <header className="site">
              <Link href="/" className="logo">Pack<i>Joy</i>U</Link>
              <nav>
                <Link href="/">{t('home')}</Link>
                <Link href="/products">{t('products')}</Link>
                <Link href="/contact">{t('contact')}</Link>
                <Link href="/" locale={locale === 'en' ? 'ru' : 'en'}>{locale === 'en' ? 'RU' : 'EN'}</Link>
                <Link href="/contact" className="btn sm">{t('quote')}</Link>
              </nav>
            </header>
            {children}
            <FloatingActions />
            <CookieConsent />
          </QuoteProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
