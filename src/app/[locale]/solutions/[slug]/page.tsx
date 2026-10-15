import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { Link } from '@/i18n/navigation';
import { industryParams, resolveIndustry } from '@/lib/solutions';
import { CtaBand, SectionHeader, Button } from '@/components/sections/ui';
import Gallery from '@/components/sections/Gallery';
import '@/components/sections/sections.css';

// #108 方案详情（规格 §8）。slug 只认 src/lib/solutions.ts 列表；{industry} 取本地化名称，不用 URL 原文；未知 slug → 404。
export const dynamic = 'force-static';
export const dynamicParams = false;
export const generateStaticParams = industryParams;

type P = { params: Promise<{ locale: string; slug: string }> };

async function lookup(locale: string, slug: string) {
  const m = (await getMessages({ locale })) as { Products?: { names?: Record<string, string> } };
  return resolveIndustry(slug, m.Products?.names ?? {});
}

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { locale, slug } = await params;
  const ind = await lookup(locale, slug);
  if (!ind) notFound();
  const t = await getTranslations({ locale, namespace: 'Solutions.detail' });
  return { title: t('metaTitle', { industry: ind.name }), description: t('metaDescription', { industry: ind.name }),
    alternates: alternatesFor(locale, `/solutions/${ind.slug}`), robots: { index: false, follow: true } };
}

export default async function SolutionDetail({ params }: P) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const ind = await lookup(locale, slug);
  if (!ind) notFound();
  const t = await getTranslations('Solutions');
  const nav = await getTranslations('Nav');
  const p = await getTranslations('Products');
  const alt = p.has(`alt.${ind.slug}`) ? p(`alt.${ind.slug}`) : '';
  return (
    <main className={`sx-page${ind.premium ? ' theme-premium sx-premium' : ''}`}>
      <section className="sx sx-block">
        <nav className="sx-crumb" aria-label={t('detail.crumb')}>
          <Link href="/solutions">{t('detail.crumb')}</Link><span aria-hidden="true"> / </span><span aria-current="page">{ind.name}</span>
        </nav>
        <div className="sx-split">
          <div>
            <SectionHeader as="h1" title={t('detail.title', { industry: ind.name })} lead={t('detail.lead', { industry: ind.name })} />
            <div className="sx-actions"><Button href={`/contact?solution=${ind.slug}`}>{nav('quote')}</Button></div>
          </div>
          <Gallery shots={[{ path: ind.poster, src: ind.poster, alt }]} label={ind.name} />
        </div>
      </section>
      {/* 规格表 / FAQ / 相关案例：SEO 未提供已确认内容（键缺失）→ 整块不渲染 */}
      {t.has('detail.faq') && (
        <section className="sx sx-block sx-faq">
          {(t.raw('detail.faq') as { q: string; a: string }[]).map((f, k) => <details key={f.q} open={k === 0}><summary>{f.q}</summary><p>{f.a}</p></details>)}
        </section>
      )}
      <div className="sx sx-block"><CtaBand title={t('detail.cta')} cta={nav('quote')} href={`/contact?solution=${ind.slug}`} /></div>
    </main>
  );
}
