import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Inter } from 'next/font/google';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { routing } from '@/i18n/routing';
import { Link } from '@/i18n/navigation';
import '../globals.css';

// 只加载拉丁和西里尔子集，控制字体体积
const inter = Inter({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-sans' });

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return {
    title: t('title'),
    description: t('description'),
    metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000')
  };
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('Nav');
  return (
    <html lang={locale} className={inter.variable}>
      <body>
        <NextIntlClientProvider>
          <header className="site">
            <strong>PackJoyU</strong>
            <nav>
              <Link href="/">{t('home')}</Link>
              <Link href="/products">{t('products')}</Link>
              <Link href="/" locale={locale === 'en' ? 'ru' : 'en'}>{locale === 'en' ? 'RU' : 'EN'}</Link>
            </nav>
          </header>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
