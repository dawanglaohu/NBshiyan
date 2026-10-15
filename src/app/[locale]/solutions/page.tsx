import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { INDUSTRIES } from '@/lib/solutions';
import { Button, Card, CtaBand, ImagePlaceholder, SectionHeader } from '@/components/sections/ui';
import '@/components/sections/sections.css';

// #108 行业方案列表（规格 §3.1）。行业列表来自 src/lib/solutions.ts，名称/简介沿用 Products.names / Products.desc。
export const dynamic = 'force-static';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Solutions' });
  // 文案/图片仍是占位，正式上线前 noindex（SEO 确认后去掉）
  return { title: t('meta.title'), description: t('meta.description'), alternates: alternatesFor(locale, '/solutions'), robots: { index: false, follow: true } };
}

export default async function SolutionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Solutions');
  const p = await getTranslations('Products');
  const nav = await getTranslations('Nav');
  const list = INDUSTRIES.filter((i) => !i.premium && p.has(`names.${i.slug}`));
  const premium = INDUSTRIES.filter((i) => i.premium);
  return (
    <main className="sx-page">
      <section className="sx sx-block">
        <SectionHeader as="h1" eyebrow={t('eyebrow')} title={t('title')} lead={t('lead')} />
        {list.length === 0 ? (
          <div className="sx-empty"><p>{t('empty')}</p><Button href="/contact">{nav('quote')}</Button></div>
        ) : (
          <div className="sx-grid">
            {list.map((i) => (
              <Card key={i.slug} href={`/solutions/${i.slug}`} title={p(`names.${i.slug}`)} desc={p.has(`desc.${i.slug}`) ? p(`desc.${i.slug}`) : undefined} more={t('more')}
                image={<ImagePlaceholder path={i.poster} src={i.poster} alt={p.has(`alt.${i.slug}`) ? p(`alt.${i.slug}`) : ''} />} />
            ))}
          </div>
        )}
      </section>
      <section className="theme-premium sx-premium">
        <div className="sx sx-block sx-split">
          <div>
            <SectionHeader eyebrow={t('premium.eyebrow')} title={t('premium.title')} lead={t('premium.lead')} />
            {t.has('premium.tags') && <div className="sx-tags sx-premium-tags">{(t.raw('premium.tags') as string[]).map((x) => <span key={x} className="sx-tag">{x}</span>)}</div>}
            <div className="sx-actions"><Button href="/contact">{nav('quote')}</Button></div>
          </div>
          <div className="sx-premium-imgs">
            {premium.map((i) => (
              <ImagePlaceholder key={i.slug} path={i.poster} src={i.poster} alt={t(`premium.imageAlt.${i.slug === 'wine-boxes' ? 'wine' : 'gift'}`)} />
            ))}
          </div>
        </div>
      </section>
      <div className="sx sx-block"><CtaBand title={t('cta')} cta={nav('quote')} /></div>
    </main>
  );
}
