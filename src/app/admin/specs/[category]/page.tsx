import { notFound } from 'next/navigation';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { adminPageDenied, SPEC_PAGE_ROLES } from '@/lib/server/admin/page-access';
import SpecEditor from '@/components/admin/specs/SpecEditor';
import Denied from '@/components/admin/specs/Denied';

// 每次请求都在服务端检查会话和角色（EDITOR / ADMIN），不缓存
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ category: string }> }) {
  const denied = await adminPageDenied(SPEC_PAGE_ROLES);
  if (denied) return <Denied status={denied} />;
  const { category } = await params;
  const meta = categoryMeta.find((c) => c.key === category);
  if (!meta) notFound();
  return <SpecEditor category={meta.key} title={meta.en.keyword} />;
}
