import type { Metadata } from 'next';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { categoryChips, type IndustryMessages } from '@/lib/solutions';
import CaseWall, { type CaseItem } from '@/components/sections/CaseWall';
import { CtaBand, SectionHeader } from '@/components/sections/ui';
import '@/components/sections/sections.css';

// #108 案例墙（规格 §3.3）。PM：只有结构 + 空状态，不放任何示例客户/logo/数据；不进导航、不进 sitemap、noindex。
export const dynamic = 'force-static';
/** 经 Ryan 确认、客户同意公开的案例才放进来 */
const CASES: CaseItem[] = [];

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Cases' });
  return { title: t('meta.title'), description: t('meta.description'), alternates: alternatesFor(locale, '/cases'), robots: { index: false, follow: false } };
}

export default async function CasesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Cases');
  const nav = await getTranslations('Nav');
  const industries = categoryChips((await getMessages({ locale })) as IndustryMessages).map((i) => ({ id: i.slug, label: i.name }));
  return (
    <main className="sx-page">
      <section className="sx sx-block">
        <SectionHeader as="h1" eyebrow={t('eyebrow')} title={t('title')} lead={t('lead')} />
        {CASES.length === 0 ? (
          <div className="sx-empty"><span className="sx-empty-icon" aria-hidden="true" /><p>{t('comingSoon')}</p></div>
        ) : (
          <CaseWall cases={CASES} industries={industries} t={{ all: t('all'), filter: t('filtersLabel'), empty: t('empty'), showAll: t('showAll') }} />
        )}
      </section>
      <div className="sx sx-block"><CtaBand title={t('cta')} cta={nav('quote')} /></div>
    </main>
  );
}
