import type { Metadata } from 'next';
import { alternatesFor } from '@/i18n/alternates';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: alternatesFor(locale, '') };
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Home');
  // 开屏视频和首页动画等设计稿确定后接入；正文直接渲染在 HTML 中，开屏只做覆盖层
  return (
    <main className="container" style={{ padding: '80px 20px' }}>
      <h1 style={{ fontSize: 'clamp(32px,5vw,56px)', margin: 0 }}>{t('headline')}</h1>
      <p style={{ fontSize: 18, maxWidth: 640 }}>{t('sub')}</p>
      <Link href="/products">{t('cta')}</Link>
    </main>
  );
}
