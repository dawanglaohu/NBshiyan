import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { visibleImages, visibleStats } from '@/lib/about/model';
import { isPublishedLocale } from '@/lib/server/published-locales';
import { getAboutContent, getPublishedAboutLocales } from '@/lib/server/site-settings';
import { buildAboutMetadata } from '@/lib/seo/about';
import { SITE_URL } from '@/lib/site';
import { isAboutVisible } from '@/lib/about/visibility';
import { ABOUT_IMAGE_SIZES, AboutFigure, AboutStats } from '@/components/about/AboutParts';
import { CtaBand } from '@/components/sections/ui';
import '@/components/sections/sections.css';
import '@/components/about/about.css';

/**
 * #350 公司介绍 /[locale]/about（UX spec v1.0 §2；稿件 about-desktop / about-mobile / about-minimal）。
 * 所有公司事实（标题、正文、数据条、图片）只来自后台站点设置；UI 固定文案在 messages 的 About 命名空间。
 * 开关关闭、该语言内容不完整、该语言未上线 → 404（用现有本地化 404 页面）。
 * 缓存：读取函数用标签 site-settings，保存后后端 revalidateTag；这里 revalidate 60 兜底（关闭后最多 1 分钟变 404）。
 */
export const revalidate = 60;

async function load(locale: string) {
  if (!isPublishedLocale(locale) || !(await isAboutVisible(locale))) return null;
  return getAboutContent(locale);
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (locale !== 'en' && locale !== 'ru') return {};
  const [content, publishedLocales, t, nav] = await Promise.all([
    load(locale),
    getPublishedAboutLocales(),
    getTranslations({ locale, namespace: 'Meta' }),
    getTranslations({ locale, namespace: 'Nav' }),
  ]);
  // meta / canonical / hreflang / og:image（/<locale>/about/og?v=…）的规则都归 SEO：src/lib/seo/about.ts
  // ogBadge = Nav.about，和 og 路由画的角标、校验 v 用的是同一个值
  return buildAboutMetadata({ locale, content, publishedLocales, origin: SITE_URL, fallbackOgAlt: t('ogImageAlt'), ogBadge: nav('about') });
}

export default async function AboutPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const c = await load(locale);
  if (!c) notFound();
  const t = await getTranslations('About');
  const nav = await getTranslations('Nav');
  const stats = visibleStats(c.stats);
  const images = visibleImages(c.images);
  return (
    <main className="sx-page">
      <section className="ab-hero">
        <div className="sx sx-block">
          <nav className="sx-crumb" aria-label={t('crumbLabel')}>
            <Link href="/">{nav('home')}</Link><span aria-hidden="true"> / </span>
            <span className="sx-crumb-cur" aria-current="page">{nav('about')}</span>
          </nav>
          <p className="sx-eyebrow">{t('eyebrow')}</p>
          <h1>{c.title}</h1>
        </div>
      </section>
      {/* 安全（全栈）：bodyHtml 只来自读取函数——后端 sanitizeAboutHtml 入库净化、读取时再净化一次。前端不自建净化器 */}
      <section className="sx sx-block">
        <div className="ab-body" dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />
      </section>
      {stats.length > 0 && (
        <section className="ab-stats" aria-labelledby="ab-stats-h">
          <div className="sx sx-block">
            <h2 id="ab-stats-h" className="sr-only">{t('statsTitle')}</h2>
            <AboutStats stats={stats} />
          </div>
        </section>
      )}
      {images.length > 0 && (
        <section className="sx sx-block" aria-labelledby="ab-imgs-h">
          <h2 id="ab-imgs-h" className="sx-h">{t('imagesTitle')}</h2>
          <div className="ab-imgs">
            {images.map((img) => <AboutFigure key={img.id} img={img} sizes={ABOUT_IMAGE_SIZES} />)}
          </div>
        </section>
      )}
      <div className="sx sx-block ab-cta"><CtaBand title={t('ctaTitle')} cta={nav('quote')} /></div>
    </main>
  );
}
