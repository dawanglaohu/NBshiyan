import InquiryDetailView from '@/components/admin/InquiryDetail';
import { auth } from '@/auth';
import { notFound } from 'next/navigation';
import { enforceAdminPage } from '@/lib/server/admin/page-access';
import { checkAdminSession } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope } from '@/lib/server/admin/inquiries';
import { prisma } from '@/lib/server/db';
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
  // 服务端再按接口同一个 inquiryScope 查一次（只取 id）：不存在 / 不在范围内（SALES 看别人的或未分配的）→ 页面 404。详情数据仍由客户端走 API
  const c = await checkAdminSession(['ADMIN', 'SALES']);
  if (!c.ok || !ID_RE.test(id)) notFound();
  const row = await prisma.inquiry.findFirst({ where: { AND: [{ id }, inquiryScope(c.user)] }, select: { id: true } });
  if (!row) notFound();
  return <InquiryDetailView id={id} role={await currentRole()} />;
}
