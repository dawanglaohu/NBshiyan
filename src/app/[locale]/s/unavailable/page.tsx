import type { Metadata } from 'next';
import { UnavailableNotice, unavailableTitle } from './notice';

// 数据库不可用时 middleware 把 /[locale]/s/<id> 重写到这里并返回 503 + Retry-After: 60（Refs #162）。
// 直接访问本页返回 404（middleware 的 EXPIRED_RE 同时匹配 expired / unavailable）。
export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return { title: unavailableTitle(locale), robots: { index: false, follow: false } };
}

export default async function UnavailablePage({ params }: Props) {
  const { locale } = await params;
  return <UnavailableNotice locale={locale} />;
}
