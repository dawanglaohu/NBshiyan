import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { alternatesFor } from '@/i18n/alternates';
import { getDocBySlug, getDocs, type DocType, type Locale } from '@/lib/server/sanity';
import PortableText from './PortableText';

// Sanity 驱动的列表页/详情页（#100）。未配置 Sanity 或无内容时：列表页 noindex 且显示空态，详情页 404。
// 浏览器不直连 Sanity；正文图片暂不渲染，CSP 无需改动。
const loc = (l: string): Locale => (l === 'ru' ? 'ru' : 'en');
const TITLES: Record<DocType, Record<Locale, string>> = {
  product: { en: 'Products', ru: 'Продукция' },
  solution: { en: 'Solutions', ru: 'Решения' },
  article: { en: 'Articles', ru: 'Статьи' }
};
const EMPTY: Record<Locale, string> = { en: 'Content coming soon.', ru: 'Скоро здесь появятся материалы.' };
type P = { params: Promise<{ locale: string; slug?: string }> };

export function listMetadata(type: DocType, base: string) {
  return async ({ params }: P): Promise<Metadata> => {
    const { locale } = await params;
    const docs = await getDocs(type, loc(locale));
    return { title: TITLES[type][loc(locale)], alternates: alternatesFor(locale, base), ...(docs?.length ? {} : { robots: { index: false, follow: true } }) };
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
    return {
      title: d.seo?.title || d.title,
      description: d.seo?.description || d.excerpt,
      alternates: alternatesFor(locale, `${base}/${slug}`),
      ...(d.seo?.noindex ? { robots: { index: false, follow: true } } : {})
    };
  };
}

export function DetailPage(type: DocType) {
  return async function Page({ params }: P) {
    const { locale, slug = '' } = await params;
    setRequestLocale(locale);
    const d = (await getDocBySlug(type, loc(locale), slug)) as Doc | null;
    if (!d) notFound();
    return (
      <main className="prose mx-auto max-w-3xl px-4 py-12">
        <h1>{d.title}</h1>
        {d.excerpt && <p className="lead">{d.excerpt}</p>}
        <PortableText value={d.body} />
      </main>
    );
  };
}
