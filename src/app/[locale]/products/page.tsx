import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo/pageMeta';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { products } from '@/data/products';
import CategoryBar from '@/components/CategoryBar';
import ProductGallery from '@/components/three/ProductGallery';
import JsonLd from '@/components/seo/JsonLd';
import { SITE_URL } from '@/lib/site';
import { listPublishedModels } from '@/lib/server/published-models';
import { catalogItemList, decorateCatalogProducts, loadCatalog, withPublishedReady, type Locale } from '@/lib/catalog/catalog';
import { categoryHref } from '@/lib/seo/categoryPages';
import { connectWhenSeoMock } from '@/lib/seo/connectWhenSeoMock';
import { categoryPagesLive } from '@/lib/seo/mock';

// 模型列表直接在服务端读数据库（与 /api/models 同一函数），60 秒重新生成
export const revalidate = 60;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Products' });
  return pageMetadata({ locale, path: '/products', title: t('metaTitle'), description: t('metaDescription'), ogSlug: 'products', ogAlt: t('ogImageAlt') });
}

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // 默认不碰 connection()，listPublishedModels 仍按 revalidate = 60 缓存。审计 mock 才按请求读开关。
  await connectWhenSeoMock();
  setRequestLocale(locale);
  const t = await getTranslations('Products');
  const v = await getTranslations('Views');
  const loc = (locale === 'ru' ? 'ru' : 'en') as Locale;
  // 卡片文字和图片在服务端渲染，爬虫可读；3D 只在客户端增强
  const catalog = await loadCatalog(async () => withPublishedReady(await listPublishedModels()), loc, products, { strictEmpty: process.env.CATALOG_STRICT_API === '1' });
  const categoryLive = categoryPagesLive();
  const items = decorateCatalogProducts(catalog.products, loc, products, {
    hasName: (slug) => t.has(`names.${slug}`),
    name: (slug) => t(`names.${slug}`),
    desc: (slug) => t(`desc.${slug}`),
    specs: (slug) => t.raw(`specs.${slug}`) as string[],
    alt: (name) => t('alt', { name }),
  }).map((item) => ({ ...item, landing: categoryHref(loc, item.slug, categoryLive) }));
  const pageUrl = `${SITE_URL}/${locale}/products`;
  const m = await getTranslations('Meta');
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: m('home'), item: `${SITE_URL}/${locale}` },
        { '@type': 'ListItem', position: 2, name: t('title'), item: pageUrl }
      ] },
      { '@type': 'ItemList', name: t('title'), itemListElement: catalogItemList(items, pageUrl) }
    ]
  };
  return (
    <main className="container" style={{ paddingBottom: 80 }}>
      <JsonLd data={ld} />
      <h1>{t('title')}</h1>
      <p>{t('hint')}</p>
      {items.length === 0 ? <p role="status" className="empty">{t('empty')}</p> : <>
      <CategoryBar items={items.map(({ slug, name }) => ({ slug, name }))} label={t('categories')} />
      <ProductGallery items={items} labels={{ learnMore: t('learnMore'), specsLabel: t('specsLabel'), tap: t('tapToRotate'), drag: t('dragToRotate'), loading: t('loading'), add: t('addToQuote'), details: t('details'), done: t('done'), viewsLabel: v('label'), views: { closed: v('closed'), open: v('open'), dieline: v('dieline') } }} />
      </>}
    </main>
  );
}
