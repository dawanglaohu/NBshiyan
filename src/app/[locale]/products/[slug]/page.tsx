import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import JsonLd from '@/components/seo/JsonLd';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { categoryHref, categoryPagePath } from '@/lib/seo/categoryPages';
import { categoryPagesLive } from '@/lib/seo/mock';
import { categoryOgImage } from '@/lib/seo/categoryOg';
import { categorySeo } from '@/lib/seo/templates';
import { categoryBreadcrumb } from '@/lib/seo/breadcrumbs';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE } from '@/i18n/published-locales';
import { SITE_URL } from '@/lib/site';

// 品类落地页的 SEO 外壳（title/description 模板 + BreadcrumbList）。正文由 #198 的落地页 PR 提供。
// CATEGORY_PAGES_LIVE=false 时一律 404；只有本地 SEO 审计 mock 模式（生产无效）会打开。
type P = { params: Promise<{ locale: string; slug: string }> };
const loc = (l: string) => (l === 'ru' ? 'ru' : 'en') as 'en' | 'ru';
const find = (locale: 'en' | 'ru', slug: string) => {
  let s = slug; try { s = decodeURIComponent(slug); } catch { return undefined; }
  return categoryMeta.find((c) => c[locale].slug === s);
};

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { locale: raw, slug } = await params; const locale = loc(raw);
  const c = categoryPagesLive() ? find(locale, slug) : undefined;
  if (!c) return { robots: { index: false } };
  const names = await getTranslations({ locale, namespace: 'Products.names' });
  const { title, description } = categorySeo({ locale, name: names(c.key), meta: c[locale] });
  const languages: Record<string, string> = Object.fromEntries(PUBLISHED_LOCALES.map((l) => [l, categoryPagePath(l, c.key, true)!]));
  languages['x-default'] = categoryPagePath(DEFAULT_PUBLISHED_LOCALE, c.key, true)!;
  const image = categoryOgImage(locale, c[locale].slug);
  const share = image ? { openGraph: { images: [image] }, twitter: { card: 'summary_large_image' as const, images: [image] } } : {};
  return { title, ...(description ? { description } : {}), alternates: { canonical: categoryPagePath(locale, c.key, true)!, languages }, ...share };
}

export default async function CategoryPage({ params }: P) {
  const { locale: raw, slug } = await params; const locale = loc(raw);
  const live = categoryPagesLive();
  const c = live ? find(locale, slug) : undefined;
  if (!c) notFound();
  setRequestLocale(locale);
  const names = await getTranslations({ locale, namespace: 'Products.names' });
  const name = names(c.key);
  return (
    <main className="container">
      <JsonLd data={categoryBreadcrumb(SITE_URL, locale, c.key, name, live)} />
      <h1>{name}</h1>
      <p><Link href={categoryHref(locale, c.key, false)}>{locale === 'ru' ? '3D-каталог' : '3D Products'}</Link></p>
    </main>
  );
}
