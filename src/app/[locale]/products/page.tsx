import type { Metadata } from 'next';
import { alternatesFor } from '@/i18n/alternates';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { products } from '@/data/products';
import ProductGallery from '@/components/three/ProductGallery';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: alternatesFor(locale, '/products') };
}

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Products');
  const v = await getTranslations('Views');
  // 卡片文字和图片在服务端渲染，爬虫可读；3D 只在客户端增强
  const items = products.map((p) => ({ ...p, name: t(`names.${p.slug}`) }));
  return (
    <main className="container" style={{ paddingBottom: 80 }}>
      <h1>{t('title')}</h1>
      <p>{t('hint')}</p>
      <ProductGallery items={items} labels={{ tap: t('tapToRotate'), loading: t('loading'), add: t('addToQuote'), details: t('details'), done: t('done'), viewsLabel: v('label'), views: { closed: v('closed'), open: v('open'), dieline: v('dieline') } }} />
    </main>
  );
}
