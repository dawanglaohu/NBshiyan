import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LOCALE_GATE_SEGMENT } from '@/lib/edge/locale-gate';
import LocaleUnavailable from './LocaleUnavailable';

type P = { params: Promise<{ locale: string; rest: string[] }> };
const isGate = (locale: string, rest: string[]) => locale === 'en' && rest.length === 1 && rest[0] === LOCALE_GATE_SEGMENT;

// 未匹配的 /{locale}/... 路径交给 [locale]/not-found.tsx，显示本地化的 404（真实 404 状态码，#195）。
// 例外：middleware 把未发布语言 rewrite 到 /en/__locale-unavailable（状态 404 + noindex 由 middleware 给出），这里渲染专用 404 页。
// 专用页不输出 canonical 和 hreflang（SEO），只有 title 和 noindex。
export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { locale, rest } = await params;
  if (!isGate(locale, rest)) return {};
  const t = await getTranslations({ locale: 'en', namespace: 'NotFound' });
  return { title: t('meta.title'), description: null, robots: { index: false, follow: true } };
}

export default async function CatchAll({ params }: P) {
  const { locale, rest } = await params;
  if (isGate(locale, rest)) return <LocaleUnavailable />;
  notFound();
}
