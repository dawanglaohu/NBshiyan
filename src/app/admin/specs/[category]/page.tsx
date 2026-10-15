import { notFound } from 'next/navigation';
import { categoryMeta } from '@/lib/seo/categoryMeta';
import { enforceAdminPage, SPEC_PAGE_ROLES } from '@/lib/server/admin/page-access';
import SpecEditor from '@/components/admin/specs/SpecEditor';

// 每次请求都在服务端检查会话和角色（EDITOR / ADMIN），不缓存
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ category: string }> }) {
  const { category } = await params;
  await enforceAdminPage(SPEC_PAGE_ROLES, `/admin/specs/${encodeURIComponent(category)}`);
  const meta = categoryMeta.find((c) => c.key === category);
  if (!meta) notFound();
  return <SpecEditor category={meta.key} title={meta.en.keyword} />;
}
