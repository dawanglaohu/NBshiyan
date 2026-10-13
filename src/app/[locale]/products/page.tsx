import type { Metadata } from 'next';
import { alternatesFor } from '@/i18n/alternates';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { products } from '@/data/products';
import CategoryBar from '@/components/CategoryBar';
import ProductGallery from '@/components/three/ProductGallery';
import JsonLd from '@/components/seo/JsonLd';
import { SITE_URL } from '@/lib/site';
import { listPublishedModels } from '@/lib/server/published-models';
import { loadCatalog, type Locale } from '@/lib/catalog/catalog';

// 模型列表直接在服务端读数据库（与 /api/models 同一函数），60 秒重新生成
export const revalidate = 60;

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
  const catalog = await loadCatalog(listPublishedModels, (locale === 'ru' ? 'ru' : 'en') as Locale, products, { strictEmpty: process.env.CATALOG_STRICT_API === '1' });
  const items = catalog.products.map((p) => {
    const known = t.has(`names.${p.slug}`);
    const name = known ? t(`names.${p.slug}`) : p.slug.replace(/-/g, ' ');
    return { ...p, name, desc: known ? t(`desc.${p.slug}`) : undefined, specs: known ? (t.raw(`specs.${p.slug}`) as string[]) : undefined, alt: t('alt', { name }) };
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
      {items.length === 0 ? <p role="status" className="empty">{t('empty')}</p> : <>
      <CategoryBar items={items.map(({ slug, name }) => ({ slug, name }))} label={t('categories')} />
      <ProductGallery items={items} labels={{ learnMore: t('learnMore'), specsLabel: t('specsLabel'), tap: t('tapToRotate'), loading: t('loading'), add: t('addToQuote'), details: t('details'), done: t('done'), viewsLabel: v('label'), views: { closed: v('closed'), open: v('open'), dieline: v('dieline') } }} />
      </>}
    </main>
  );
}
