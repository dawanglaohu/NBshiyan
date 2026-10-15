import InquiryDetailView from '@/components/admin/InquiryDetail';
import { auth } from '@/auth';
import { enforceAdminPage } from '@/lib/server/admin/page-access';
// 页面自己的服务端检查：未登录→登录页，停用/角色不符→404
export const dynamic = 'force-dynamic';

/** 当前登录账号的角色（#225）。mock 模式没有真实会话，按 ADMIN 演示；读不到会话时不给改分配。 */
async function currentRole(): Promise<string | undefined> {
  if (process.env.NEXT_PUBLIC_ADMIN_API !== 'http' && process.env.NODE_ENV !== 'production') return 'ADMIN';
  try { return ((await auth())?.user as { role?: string } | undefined)?.role; } catch { return undefined; }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await enforceAdminPage(['ADMIN', 'SALES'], `/admin/inquiries/${encodeURIComponent(id)}`);
  return <InquiryDetailView id={id} role={await currentRole()} />;
}
