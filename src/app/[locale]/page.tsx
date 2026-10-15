import Image from 'next/image';
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo/pageMeta';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { products } from '@/data/products';

const PREMIUM = new Set(['gift-boxes', 'wine-boxes']);
// Home stats row (capacity / sampling / eco / certs) removed — all unconfirmed; section hidden

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Meta' });
  return pageMetadata({ locale, path: '', title: t('title'), description: t('description') });
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Home');
  const names = await getTranslations('Products.names');
  // TODO: 开屏视频（首次访问、≤5 秒、可跳过）等素材到位后做成覆盖层；正文始终先在 HTML 里渲染
  // TODO: 空闲时把主图替换成 3D 盒子
  return (
    <main>
      <section className="hero">
        <div className="container hero-grid">
          <div>
          <h1>{t('headline')}</h1>
          <p>{t('sub')}</p>
          <div className="actions">
            <Link className="btn" href="/contact">{t('ctaQuote')}</Link>
            <Link className="btn ghost" href="/products">{t('cta')}</Link>
          </div>
          </div>
          <Image className="hero-art" src="/images/hero/custom-printing-packaging-manufacturer.webp" alt={locale === 'ru' ? 'Индивидуальные винные коробки с печатью, подарочные коробки и гофрокоробки для доставки от PackJoyU' : 'Custom printed wine boxes, gift boxes and corrugated shipping boxes by PackJoyU'} width={1200} height={900} priority sizes="(max-width: 900px) 100vw, 45vw" />
        </div>
      </section>


      <section className="block container" aria-labelledby="entry-h">
        <h2 id="entry-h">{t('entryTitle')}</h2>
        <div className="entry">
          {products.map((p) => (
            <Link key={p.slug} href={`/products#${p.slug}`} className={PREMIUM.has(p.slug) ? 'theme-premium' : undefined}>
              {/* 品类封面：3D 组导出到 public/images/posters/ 后在 products.ts 更新 poster 即生效 */}
              <img src={p.poster} alt="" width={160} height={120} loading="lazy" decoding="async" />
              <span>{names(p.slug)}</span>
            </Link>
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
