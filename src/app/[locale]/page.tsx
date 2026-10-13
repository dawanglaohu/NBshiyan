import Image from 'next/image';
import type { Metadata } from 'next';
import { alternatesFor } from '@/i18n/alternates';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { products } from '@/data/products';

const PREMIUM = new Set(['gift-boxes', 'wine-boxes']);
const ADV = ['capacity', 'certs', 'sampling', 'eco'] as const;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: alternatesFor(locale, '') };
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Home');
  const names = await getTranslations('Products.names');
  // TODO: 开屏视频（首次访问、≤5 秒、可跳过）等素材到位后做成覆盖层；正文始终先在 HTML 里渲染
  // TODO: 首屏右侧主图（WebP）和空闲时替换的 3D 盒子
  return (
    <main>
      <section className="hero">
        <div className="container hero-text">
          <h1>{t('headline')}</h1>
          <p>{t('sub')}</p>
          <div className="actions">
            <Link className="btn" href="/contact">{t('ctaQuote')}</Link>
            <Link className="btn ghost" href="/products">{t('cta')}</Link>
          </div>
        </div>
        <Image className="hero-img" src="/images/hero/custom-printing-packaging-manufacturer.webp" alt="Custom wine box, gift box and corrugated shipping box by PackJoyU" width={1200} height={900} priority sizes="(max-width: 900px) 100vw, 45vw" />
      </section>

      <section className="block container" aria-labelledby="adv-h">
        <h2 id="adv-h">{t('advTitle')}</h2>
        <div className="adv">
          {ADV.map((k) => (
            <div key={k}><strong>{t(`adv.${k}.value`)}</strong><span>{t(`adv.${k}.label`)}</span></div>
          ))}
        </div>
      </section>

      <section className="block container" aria-labelledby="entry-h">
        <h2 id="entry-h">{t('entryTitle')}</h2>
        <div className="entry">
          {products.map((p) => (
            <Link key={p.slug} href={`/products#${p.slug}`} className={PREMIUM.has(p.slug) ? 'theme-premium' : undefined}>{names(p.slug)}</Link>
          ))}
        </div>
      </section>

      <section className="container" aria-labelledby="premium-h">
        <div className="premium-band theme-premium">
          <h2 id="premium-h" style={{ marginTop: 0 }}>{t('premiumTitle')}</h2>
          <p style={{ maxWidth: 620 }}>{t('premiumText')}</p>
          <div className="actions" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Link className="btn" href="/products#gift-boxes">{names('gift-boxes')}</Link>
            <Link className="btn ghost" href="/products#wine-boxes">{names('wine-boxes')}</Link>
          </div>
        </div>
      </section>

      <section className="block container">
        <div className="cta-band">
          <div><h2>{t('ctaBandTitle')}</h2><p style={{ margin: '8px 0 0' }}>{t('ctaBandText')}</p></div>
          <Link className="btn" href="/contact">{t('ctaQuote')}</Link>
        </div>
      </section>
    </main>
  );
}
