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
  // 11-UI:217：询盘主体为操作面——左对齐表单 + 320px 联系方式旁栏，窄屏顺序堆叠（不采用居中窄卡外壳）。
  return (
    <main className="container contact-surface">
      <h1 style={{ fontSize: 'var(--fs-h2)', marginTop: 0 }}>{t('title')}</h1>
      <p className="contact-intro">{t('intro')}</p>
      <div className="contact-body">
        <div className="contact-form">
          <InquiryWizard />
        </div>
        <aside className="contact-rail">
          <HumanContactNotice />
        </aside>
      </div>
    </main>
  );
}
