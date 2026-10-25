import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo/pageMeta';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import InquiryWizard from '@/components/inquiry/InquiryWizard';
import HumanContactNotice from './HumanContactNotice';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Contact' });
  return pageMetadata({ locale, path: '/contact', title: t('metaTitle'), description: t('metaDescription'), ogSlug: 'contact', ogAlt: t('ogImageAlt') });
}

export default async function ContactPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Contact');
  return (
    <main className="container" style={{ padding: '48px 20px 96px' }}>
      <h1 style={{ fontSize: 'var(--fs-h2)', marginTop: 0 }}>{t('title')}</h1>
      <p style={{ maxWidth: 640 }}>{t('intro')}</p>
      <HumanContactNotice />
      <InquiryWizard />
    </main>
  );
}
