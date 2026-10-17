import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { getDocBySlug, getDocs, type DocType, type Locale } from '@/lib/server/sanity';
import PortableText from './PortableText';
import JsonLd from '@/components/seo/JsonLd';
import { SITE_URL } from '@/lib/site';
import { articleSeo } from '@/lib/seo/templates';
import { articleBreadcrumb } from '@/lib/seo/breadcrumbs';
import LocaleAlternates from '@/components/layout/LocaleAlternates';
import { articleShareMeta } from '@/lib/seo/articleOg';

// Sanity 驱动的列表页/详情页（#100）。未配置 Sanity 或无内容时：列表页 noindex 且显示空态，详情页 404。
// 浏览器不直连 Sanity；正文图片暂不渲染，CSP 无需改动。
const loc = (l: string): Locale => (l === 'ru' ? 'ru' : 'en');
const TITLES: Record<DocType, Record<Locale, string>> = {
  product: { en: 'Products', ru: 'Продукция' },
  solution: { en: 'Solutions', ru: 'Решения' },
  article: { en: 'Articles', ru: 'Статьи' }
};
// <title> for list pages (30–60 chars); H1 stays the short TITLES label. RU awaiting Ryan proofreading.
const META_TITLES: Partial<Record<DocType, Record<Locale, string>>> = {
  article: { en: 'Packaging & Printing Articles and Guides | PackJoyU', ru: 'Статьи об упаковке и печати | PackJoyU' }
};
const EMPTY: Record<Locale, string> = { en: 'Content coming soon.', ru: 'Скоро здесь появятся материалы.' };
type P = { params: Promise<{ locale: string; slug?: string }> };

/** 文章列表/详情的回退分享图（首页通用图 + Meta.ogImageAlt）；其他类型返回空，保持原输出 */
async function shareMeta(type: DocType, locale: string): Promise<Pick<Metadata, 'openGraph' | 'twitter'>> {
  if (type !== 'article') return {};
  const t = await getTranslations({ locale: loc(locale), namespace: 'Meta' });
  return articleShareMeta(loc(locale), t('ogImageAlt'));
}

export function listMetadata(type: DocType, base: string) {
  return async ({ params }: P): Promise<Metadata> => {
    const { locale } = await params;
    const docs = await getDocs(type, loc(locale));
    return { title: (META_TITLES[type] ?? TITLES[type])[loc(locale)], alternates: alternatesFor(locale, base), ...(docs?.length ? {} : { robots: { index: false, follow: true } }), ...(await shareMeta(type, locale)) };
  };
}

export function ListPage(type: DocType, base: string) {
  return async function Page({ params }: P) {
    const { locale } = await params;
    setRequestLocale(locale);
    const l = loc(locale);
    const docs = (await getDocs(type, l)) ?? [];
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-3xl font-semibold">{TITLES[type][l]}</h1>
        {docs.length === 0 ? <p className="mt-6">{EMPTY[l]}</p> : (
          <ul className="mt-6 space-y-4">
            {docs.map((d) => (
              <li key={d._id}><Link href={`/${locale}${base}/${d.slug}`} className="text-lg underline">{d.title}</Link>{d.excerpt && <p>{d.excerpt}</p>}</li>
            ))}
          </ul>
        )}
      </main>
    );
  };
}

type Doc = { slug?: string; title?: string; excerpt?: string; body?: unknown; alt?: { en?: string; ru?: string }; seo?: { title?: string; description?: string; noindex?: boolean } };

export function detailMetadata(type: DocType, base: string) {
  return async ({ params }: P): Promise<Metadata> => {
    const { locale, slug = '' } = await params;
    const d = (await getDocBySlug(type, loc(locale), slug)) as Doc | null;
    if (!d) return { robots: { index: false } };
    // 文章页走 SEO 模板（docs/seo-page-templates.md）；hreflang 用各语言自己的 slug（d.alt）
    const seo = type === 'article' ? articleSeo({ locale: loc(locale), title: d.title, excerpt: d.excerpt, seo: d.seo }) : { title: d.seo?.title || d.title, description: d.seo?.description || d.excerpt };
    return {
      title: seo.title,
      ...(seo.description ? { description: seo.description } : {}),
      alternates: docAlternates(locale, base, slug, d.alt),
      ...(d.seo?.noindex ? { robots: { index: false, follow: true } } : {}),
      ...(await shareMeta(type, locale))
    };
  };
}

/** hreflang 用各语言自己的 slug；某语言没有对应文档时不输出该语言 */
function docAlternates(locale: string, base: string, slug: string, alt?: Doc['alt']) {
  const a = alternatesFor(locale, `${base}/${slug}`);
  const languages: Record<string, string> = {};
  for (const l of ['en', 'ru'] as const) { const s = l === locale ? slug : alt?.[l]; if (s) languages[l] = `/${l}${base}/${s}`; }
  if (languages.en) languages['x-default'] = languages.en;
  return { canonical: a.canonical, languages };
}

export function DetailPage(type: DocType, base: string) {
  return async function Page({ params }: P) {
    const { locale, slug = '' } = await params;
    setRequestLocale(locale);
    const d = (await getDocBySlug(type, loc(locale), slug)) as Doc | null;
    if (!d) notFound();
    return (
      <main className="prose mx-auto max-w-3xl px-4 py-12">
        {type === 'article' && d.title && <JsonLd data={articleBreadcrumb(SITE_URL, loc(locale), d.slug ?? slug, d.title)} />}
        <LocaleAlternates pathname={`${base}/${slug}`} value={{ en: d.alt?.en ? `${base}/${d.alt.en}` : null, ru: d.alt?.ru ? `${base}/${d.alt.ru}` : null }} />
        <h1>{d.title}</h1>
        {d.excerpt && <p className="lead">{d.excerpt}</p>}
        <PortableText value={d.body} />
      </main>
    );
  };
}
