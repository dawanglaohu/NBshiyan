import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { categoryHref } from '@/lib/seo/categoryPages';
import { PUBLISHED_LOCALES, DEFAULT_PUBLISHED_LOCALE } from '@/i18n/published-locales';
import { LOCALE_META } from '@/i18n/locale-meta';

/**
 * 未发布语言的 404 页（多语言第 0 期，UX）：沿用英文 404 页的样式（含头部和页脚），
 * 主按钮回 /en，其余已发布语言用母语名称的文字链接（目前是「Русский」→ /ru）。
 * 只用 NotFound 命名空间已有的英文文案，不新增文案。状态码 404 来自同目录 page.tsx 的 notFound()，X-Robots-Tag 来自 middleware。
 * robots 由 Next notFound() 注入，不自行声明。
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: DEFAULT_PUBLISHED_LOCALE, namespace: 'NotFound' });
  return { title: t('meta.title'), description: null };
}

export default async function LocaleUnavailable() {
  const t = await getTranslations({ locale: DEFAULT_PUBLISHED_LOCALE, namespace: 'NotFound' });
  const names = await getTranslations({ locale: DEFAULT_PUBLISHED_LOCALE, namespace: 'Products.names' });
  const others = PUBLISHED_LOCALES.filter((l) => l !== DEFAULT_PUBLISHED_LOCALE);
  return (
    <main className="container nf nf-locale">
      <p className="nf-code">{t('code')}</p>
      <svg width="120" height="96" viewBox="0 0 120 96" aria-hidden="true">
        <path d="M20 34 60 18l40 16v44L60 94 20 78Z" fill="#C49A6C" /><path d="M60 50v44L20 78V34Z" fill="#A77D50" />
        <path d="m20 34 40 16 40-16" fill="none" stroke="#8a6440" strokeWidth="2" /><path d="M60 50 76 30 100 34" fill="#d5ad80" />
        <circle cx="96" cy="14" r="9" fill="#FFD166" />
      </svg>
      <h1>{t('title')}</h1>
      <p className="nf-lead">{t('lead')}</p>
      <div className="nf-acts">
        <Link className="btn" href="/" locale={DEFAULT_PUBLISHED_LOCALE} hrefLang={DEFAULT_PUBLISHED_LOCALE}>{t('home')}</Link>
      </div>
      {others.length > 0 && (
        <p className="nf-langs">
          {others.map((l) => (
            <Link key={l} href="/" locale={l} hrefLang={l} lang={l} dir={LOCALE_META[l].dir}>{LOCALE_META[l].nativeName}</Link>
          ))}
        </p>
      )}
      <h2>{t('browse')}</h2>
      <ul className="nf-grid">
        {categoryMeta.map((c) => (
          <li key={c.key}><Link href={categoryHref(DEFAULT_PUBLISHED_LOCALE, c.key)}><i aria-hidden="true" />{names(c.key)}</Link></li>
        ))}
      </ul>
    </main>
  );
}
