import type { Metadata } from 'next';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { TimezoneSchema } from '@/lib/contracts/common';
import { buildPrivacy, privacyIndexable } from '@/lib/legal/privacy';
import { pageMetadata } from '@/lib/seo/pageMeta';
import { prisma } from '@/lib/server/db';
import { ANALYTICS_SETTINGS_KEY } from '@/lib/server/jobs/types';
import { retentionFacts } from './retention-facts';

// 时区读 SiteSetting。没有行或读失败时显示 UTC。不在构建期连库。
export const dynamic = 'force-dynamic';

async function privacyMessages(locale: string) {
  const m = (await getMessages({ locale })) as Record<string, unknown>;
  return (m.Privacy ?? {}) as Record<string, unknown>;
}

function timezoneOf(value: unknown): string {
  let data = value;
  if (typeof data === 'string') {
    try { data = JSON.parse(data) as unknown; } catch { return 'UTC'; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'UTC';
  const parsed = TimezoneSchema.safeParse((data as { timezone?: unknown }).timezone);
  return parsed.success ? parsed.data : 'UTC';
}

async function siteTimezone(): Promise<string> {
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: ANALYTICS_SETTINGS_KEY } });
    return timezoneOf(row?.value);
  } catch {
    return 'UTC';
  }
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
  const facts = retentionFacts();
  const timezone = await siteTimezone();
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
      <section id="privacy-necessary-chat" aria-labelledby="privacy-necessary-chat-title">
        <h2 id="privacy-necessary-chat-title">{t('ledger.necessaryTitle')}</h2>
        <p>{t('ledger.necessary', facts)}</p>
      </section>
      <section id="privacy-analytics-consent" aria-labelledby="privacy-analytics-consent-title">
        <h2 id="privacy-analytics-consent-title">{t('ledger.analyticsTitle')}</h2>
        <p>{t('ledger.visitors')}</p>
        <p>{t('ledger.analytics', facts)}</p>
      </section>
      <section id="privacy-cleanup-status" aria-labelledby="privacy-cleanup-status-title">
        <h2 id="privacy-cleanup-status-title">{t('ledger.cleanupTitle')}</h2>
        <p>{t('ledger.cleanup')}</p>
      </section>
      <p id="privacy-site-timezone">{timezone}</p>
    </main>
  );
}
