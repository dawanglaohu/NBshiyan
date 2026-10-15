import InquiryDetailView from '@/components/admin/InquiryDetail';
import { enforceAdminPage } from '@/lib/server/admin/page-access';
// 页面自己的服务端检查：未登录→登录页，停用/角色不符→404
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await enforceAdminPage(['ADMIN', 'SALES'], `/admin/inquiries/${encodeURIComponent(id)}`);
  return <InquiryDetailView id={id} />;
}
