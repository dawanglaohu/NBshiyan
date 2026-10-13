import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { categoryMeta } from '@/lib/seo/categoryMeta';

// 过期的定制方案（Refs #101）。全栈在 middleware 里把过期的 /[locale]/s/<id> 重写到这里并返回 410，
// 直接访问本页返回 404（同样由 middleware 处理）。本页只负责展示：noindex，不进 sitemap（robots 已 disallow /*/s/）。
// 可选 ?category=<内部 key>（如 wine-boxes），按 categoryMeta 校验后链接到对应品类；未知或缺省时回到产品页。
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'DesignExpired' });
  return { title: t('metaTitle'), robots: { index: false, follow: false } };
}

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ category?: string | string[] }> };

export default async function ExpiredDesignPage({ params, searchParams }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('DesignExpired');
  const names = await getTranslations('Products.names');
  const raw = (await searchParams).category;
  const key = typeof raw === 'string' ? raw : undefined;
  const cat = key ? categoryMeta.find((c) => c.key === key) : undefined;
  // 品类落地页还没上线：先链到产品页对应卡片（锚点 = 内部 key），key 先经 categoryMeta 校验，显示名用 Products.names
  const href = cat ? `/products#${cat.key}` : '/products';
  const label = cat ? t('backToCategory', { category: names(cat.key) }) : t('backToProducts');

  return (
    <main className="container legal" style={{ textAlign: 'center' }}>
      <h1>{t('title')}</h1>
      <p>{t('text')}</p>
      <p style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 24 }}>
        <Link className="btn" href={href}>{label}</Link>
        <Link className="btn ghost" href="/contact">{t('quote')}</Link>
      </p>
    </main>
  );
}
