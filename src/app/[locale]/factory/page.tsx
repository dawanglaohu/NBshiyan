import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { Button, CertBadge, CtaBand, ImagePlaceholder, Kpi, SectionHeader, Steps } from '@/components/sections/ui';
import '@/components/sections/sections.css';

// #108 工厂实力（规格 §3.2）。PM：没有真实照片/数据前不显示——KPI、认证、视频、工厂照片都按文案键/素材是否存在决定，缺就整块不渲染。
export const dynamic = 'force-static';
const KPI_KEYS = ['kpi1', 'kpi2', 'kpi3', 'kpi4'] as const;
/** 工厂实拍到位后在这里填路径（public/images/factory/*）；为空时照片区不渲染 */
const FACTORY_PHOTOS: { key: 'print' | 'dieCut' | 'qc' | 'warehouse'; src: string }[] = [];

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Factory' });
  return { title: t('meta.title'), description: t('meta.description'), alternates: alternatesFor(locale, '/factory'), robots: { index: false, follow: true } };
}

export default async function FactoryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Factory');
  const nav = await getTranslations('Nav');
  const kpis = KPI_KEYS.every((k) => t.has(`${k}.value`) && t.has(`${k}.label`)) ? KPI_KEYS : [];
  // 键形：Factory.steps.<n>.name（必有）+ Factory.steps.<n>.desc（SEO 稍后提供，有才渲染）
  const steps = ['1', '2', '3', '4', '5'].filter((k) => t.has(`steps.${k}.name`))
    .map((k) => ({ name: t(`steps.${k}.name`), desc: t.has(`steps.${k}.desc`) ? t(`steps.${k}.desc`) : undefined }));
  return (
    <main className="sx-page">
      <section className="sx sx-block">
        <SectionHeader as="h1" eyebrow={t('eyebrow')} title={t('title')} lead={t('lead')} />
        <div className="sx-actions"><Button href="/contact">{nav('quote')}</Button></div>
      </section>
      {kpis.length > 0 && (
        <section className="sx sx-block sx-kpis">{kpis.map((k) => <Kpi key={k} value={t(`${k}.value`)} label={t(`${k}.label`)} />)}</section>
      )}
      {steps.length > 0 && (
        <section className="sx sx-block" aria-labelledby="fac-steps">
          <SectionHeader id="fac-steps" title={t('steps.title')} />
          <Steps items={steps} />
          {FACTORY_PHOTOS.length > 0 && <div className="sx-premium-imgs">{FACTORY_PHOTOS.map((f) => <ImagePlaceholder key={f.key} path={f.src} src={f.src} alt={t(`stepImageAlt.${f.key}`)} />)}</div>}
        </section>
      )}
      {t.has('certs.title') && t.has('certs.items') && (
        <section className="sx sx-block" aria-labelledby="fac-certs">
          <SectionHeader id="fac-certs" title={t('certs.title')} lead={t.has('certs.note') ? t('certs.note') : undefined} />
          <div className="sx-tags">{(t.raw('certs.items') as string[]).map((c) => <CertBadge key={c}>{c}</CertBadge>)}</div>
        </section>
      )}
      <div className="sx sx-block"><CtaBand title={t('cta')} cta={nav('quote')} /></div>
    </main>
  );
}
