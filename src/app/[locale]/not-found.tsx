import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { categoryHref } from '@/lib/seo/categoryPages';
import { useLocale } from 'next-intl';

// 本地化 404（design/error-pages.html，#125/#195）：返回真实 404，Next 对 not-found 自动输出 noindex；不重定向、不放搜索框。
// 品类落地页 /{locale}/products/{slug} 上线前（CATEGORY_PAGES_LIVE，#198），入口先链到 3D 目录里对应的卡片，避免 404 页再链到 404。
export default function NotFound() {
  const t = useTranslations('NotFound');
  const names = useTranslations('Products.names');
  const locale = useLocale() as 'en' | 'ru';
  return (
    <main className="container nf">
      <p className="nf-code">{t('code')}</p>
      <svg width="120" height="96" viewBox="0 0 120 96" aria-hidden="true">
        <path d="M20 34 60 18l40 16v44L60 94 20 78Z" fill="#C49A6C" /><path d="M60 50v44L20 78V34Z" fill="#A77D50" />
        <path d="m20 34 40 16 40-16" fill="none" stroke="#8a6440" strokeWidth="2" /><path d="M60 50 76 30 100 34" fill="#d5ad80" />
        <circle cx="96" cy="14" r="9" fill="#FFD166" />
      </svg>
      <h1>{t('title')}</h1>
      <p className="nf-lead">{t('lead')}</p>
      <div className="nf-acts">
        <Link className="btn" href="/contact">{t('quote')}</Link>
        <Link className="btn ghost" href="/">{t('home')}</Link>
      </div>
      <h2>{t('browse')}</h2>
      <ul className="nf-grid">
        {categoryMeta.map((c) => (
          <li key={c.key}><Link href={categoryHref(locale, c.key)}><i aria-hidden="true" />{names(c.key)}</Link></li>
        ))}
      </ul>
    </main>
  );
}
