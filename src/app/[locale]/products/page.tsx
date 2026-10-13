import type { Metadata } from 'next';
import { alternatesFor } from '@/i18n/alternates';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { products } from '@/data/products';
import CategoryBar from '@/components/CategoryBar';
import ProductGallery from '@/components/three/ProductGallery';
import JsonLd from '@/components/seo/JsonLd';
import { SITE_URL } from '@/lib/site';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Products' });
  return { title: { absolute: t('metaTitle') }, description: t('metaDescription'), alternates: alternatesFor(locale, '/products') };
}

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Products');
  const v = await getTranslations('Views');
  // 卡片文字和图片在服务端渲染，爬虫可读；3D 只在客户端增强
  const items = products.map((p) => {
    const name = t(`names.${p.slug}`);
    return { ...p, name, desc: t(`desc.${p.slug}`), specs: t.raw(`specs.${p.slug}`) as string[], alt: t('alt', { name }) };
  });
  const pageUrl = `${SITE_URL}/${locale}/products`;
  const m = await getTranslations('Meta');
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: m('home'), item: `${SITE_URL}/${locale}` },
        { '@type': 'ListItem', position: 2, name: t('title'), item: pageUrl }
      ] },
      { '@type': 'ItemList', name: t('title'), itemListElement: items.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.name, description: p.desc, url: `${pageUrl}#${p.slug}` })) }
    ]
  };
  return (
    <main className="container" style={{ paddingBottom: 80 }}>
      <JsonLd data={ld} />
      <h1>{t('title')}</h1>
      <p>{t('hint')}</p>
      <CategoryBar items={items.map(({ slug, name }) => ({ slug, name }))} label={t('categories')} />
      <ProductGallery items={items} labels={{ learnMore: t('learnMore'), specsLabel: t('specsLabel'), tap: t('tapToRotate'), loading: t('loading'), add: t('addToQuote'), details: t('details'), done: t('done'), viewsLabel: v('label'), views: { closed: v('closed'), open: v('open'), dieline: v('dieline') } }} />
    </main>
  );
}
