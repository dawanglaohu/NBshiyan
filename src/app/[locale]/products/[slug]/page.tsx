import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import JsonLd from '@/components/seo/JsonLd';
import CategoryArticle from '@/components/category/CategoryArticle';
import LocaleAlternates from '@/components/layout/LocaleAlternates';
import { categoryHref, categoryLocaleAlternates, categoryPagePath, categoryForRequest, categoryLanguageAlternates } from '@/lib/seo/categoryPages';
import { loadCategoryArticle } from '@/lib/seo/categoryMarkdown';
import { categoryPagesLive, connectWhenSeoMock } from '@/lib/seo/mock';
import { categoryOgImage } from '@/lib/seo/categoryOg';
import { categorySeo } from '@/lib/seo/templates';
import { categoryBreadcrumb } from '@/lib/seo/breadcrumbs';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE } from '@/i18n/published-locales';
import { SITE_URL } from '@/lib/site';

// 品类落地页。正文来自 docs/content/category-pages，H1 用文案的一级标题。
// CATEGORY_PAGES_LIVE 为 false 时一律 404；本地 SEO 审计 mock 仍可打开。
type P = { params: Promise<{ locale: string; slug: string }> };
const loc = (l: string) => (l === 'ru' ? 'ru' : 'en') as 'en' | 'ru';

export async function generateMetadata({ params }: P): Promise<Metadata> {
  await connectWhenSeoMock();
  const { locale: raw, slug } = await params;
  const locale = loc(raw);
  const c = categoryForRequest(locale, slug, categoryPagesLive());
  if (!c) return {};
  const names = await getTranslations({ locale, namespace: 'Products.names' });
  const { title, description } = categorySeo({ locale, name: names(c.key), meta: c[locale] });
  const languages = categoryLanguageAlternates(c.key, true, PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE);
  if (!languages) return {};
  const image = categoryOgImage(locale, c[locale].slug);
  const share = image ? { openGraph: { images: [image] }, twitter: { card: 'summary_large_image' as const, images: [image] } } : {};
  return { title, ...(description ? { description } : {}), alternates: { canonical: categoryPagePath(locale, c.key, true)!, languages }, ...share };
}

export default async function CategoryPage({ params }: P) {
  await connectWhenSeoMock();
  const { locale: raw, slug } = await params;
  const locale = loc(raw);
  const live = categoryPagesLive();
  const c = categoryForRequest(locale, slug, live);
  if (!c) notFound();
  const article = loadCategoryArticle(c.key, locale);
  if (!article) notFound();
  setRequestLocale(locale);
  const alts = categoryLocaleAlternates(c.key);
  return (
    <main className="container category-prose">
      {alts && <LocaleAlternates pathname={`/products/${c[locale].slug}`} value={alts} />}
      <JsonLd data={categoryBreadcrumb(SITE_URL, locale, c.key, article.h1, live)} />
      <CategoryArticle article={article} catalogHref={categoryHref(locale, c.key, false)} catalogLabel={locale === 'ru' ? '3D-каталог' : '3D Products'} />
    </main>
  );
}
