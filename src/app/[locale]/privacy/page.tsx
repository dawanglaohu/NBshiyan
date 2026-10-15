import type { Metadata } from 'next';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { buildPrivacy, privacyIndexable } from '@/lib/legal/privacy';
import { pageMetadata } from '@/lib/seo/pageMeta';

// 隐私政策：文案在 messages Privacy.*；含 {{待Ryan确认}} 的条目不渲染。
// PRIVACY_PAGE_COMPLETE=false 或仍有占位符时 noindex（sitemap 用同一开关排除）。
export const dynamic = 'force-static';

async function privacyMessages(locale: string) {
  const m = (await getMessages({ locale })) as Record<string, unknown>;
  return (m.Privacy ?? {}) as Record<string, unknown>;
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'Privacy' });
  const index = privacyIndexable(await privacyMessages(locale));
  return pageMetadata({ locale, path: '/privacy', title: t('metaTitle'), description: t('metaDescription'), ogSlug: 'privacy', ogAlt: t('ogImageAlt'), robots: { index, follow: true } });
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Privacy');
  const doc = buildPrivacy(await privacyMessages(locale));
  return (
    <main className="container legal">
      <h1>{doc.title}</h1>
      {doc.intro && <p>{doc.intro}</p>}
      {doc.sections.map((s) => (
        <section key={s.key} aria-labelledby={`privacy-${s.key}`}>
          <h2 id={`privacy-${s.key}`}>{s.title}</h2>
          {s.paragraphs.map((p) => <p key={p}>{p}</p>)}
          {s.items.length > 0 && <ul>{s.items.map((i) => <li key={i}>{i}</li>)}</ul>}
          {s.key === 'contact' && <p><Link href="/contact">{t('contactLink')}</Link></p>}
        </section>
      ))}
    </main>
  );
}
