'use client';
import { Link } from '@/i18n/navigation';

/**
 * 产品卡上的直接询盘入口：带着卡片 slug 进联系页。
 * 文案由 ProductGallery 的 labels 传入（页面传 Nav.quote），这样纯渲染夹具不必持有 Nav 命名空间。
 */
export default function InquireProductLink({ slug, name, label }: { slug: string; name: string; label: string }) {
  return (
    <Link
      href={`/contact?product=${encodeURIComponent(slug)}`}
      className="btn sm ghost"
      data-testid="inquire-product"
      data-slug={slug}
      aria-label={`${label}: ${name}`}
    >
      {label}
    </Link>
  );
}
