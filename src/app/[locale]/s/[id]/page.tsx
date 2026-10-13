import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { lookupDesign, canonicalFor } from '@/lib/server/designs';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string; id: string }> };
const robots = { index: false, follow: false };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const r = await lookupDesign(id);
  if (r.state === 'missing') return { title: 'PackJoyU', robots };
  const d = r.state === 'ok' ? r.design : r;
  // canonical 指向对应分类落地页（按方案语言取 slug）
  return { title: 'Custom packaging design | PackJoyU', robots, alternates: { canonical: canonicalFor(d) } };
}

/**
 * 占位页：服务端只负责读取和 SEO 头，3D 预览由前端接入（数据见 GET /api/designs/:id）。
 * 地址 /{locale}/s/:id。过期：页面带 noindex 并给出分类页链接；HTTP 410 由全栈的 middleware 调 HEAD /api/designs/:id 实现。
 * 页面文案语言跟随 URL 的 locale；canonical 跟随方案保存时的 locale。
 */
export default async function SharedDesignPage({ params }: Props) {
  const { id, locale } = await params;
  const r = await lookupDesign(id);
  if (r.state === 'missing') notFound();
  const ru = locale === 'ru';
  if (r.state === 'expired') {
    return (
      <main data-design-state="expired" style={{ maxWidth: 720, margin: '40px auto', padding: 16 }}>
        <h1>{ru ? 'Срок действия ссылки истёк' : 'This design link has expired'}</h1>
        <a href={canonicalFor(r)}>{ru ? 'Смотреть категорию' : 'Browse this category'}</a>
      </main>
    );
  }
  const d = r.design;
  return (
    <main data-design-id={d.id} data-product={d.productSlug} style={{ maxWidth: 720, margin: '40px auto', padding: 16 }}>
      <h1>{ru ? 'Дизайн упаковки' : 'Packaging design'}</h1>
      <p>{d.productSlug}</p>
      <a href={canonicalFor(d)}>{ru ? 'Смотреть категорию' : 'View category'}</a>
    </main>
  );
}
