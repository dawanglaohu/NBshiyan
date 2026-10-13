import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { products } from '@/data/products';
import LangLink from './LangLink';

// 站点页脚（#65）：公司、品类、联系、隐私政策、语言切换
export default async function SiteFooter() {
  const t = await getTranslations('Footer');
  const nav = await getTranslations('Nav');
  const names = await getTranslations('Products.names');
  return (
    <footer className="site-footer">
      <div className="container cols">
        <div>
          <span className="logo">Pack<i>Joy</i>U</span>
          <p>{t('about')}</p>
        </div>
        <nav aria-label={t('categories')}>
          <h2>{t('categories')}</h2>
          <ul className="cats">{products.map((p) => <li key={p.slug}><Link href={`/products#${p.slug}`}>{names(p.slug)}</Link></li>)}</ul>
        </nav>
        <div>
          <h2>{t('contact')}</h2>
          <p>{t('contactText')}</p>
          <Link href="/contact" className="btn sm">{nav('quote')}</Link>
        </div>
      </div>
      <div className="container bottom">
        <span>© {new Date().getFullYear()} PackJoyU</span>
        <Link href="/privacy">{t('privacy')}</Link>
        <LangLink label={t('otherLang')} />
      </div>
    </footer>
  );
}
