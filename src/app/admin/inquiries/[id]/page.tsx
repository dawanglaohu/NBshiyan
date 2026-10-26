import InquiryDetailView from '@/components/admin/InquiryDetail';
import { auth } from '@/auth';
import { notFound } from 'next/navigation';
import { enforceAdminPage } from '@/lib/server/admin/page-access';
import { checkAdminSession } from '@/lib/server/admin/guard';
import { ID_RE, inquiryScope } from '@/lib/server/admin/inquiries';
import { prisma } from '@/lib/server/db';
// 页面自己的服务端检查：未登录→登录页，停用/角色不符→404
export const dynamic = 'force-dynamic';

/** mock 演示模式：与演示默认 ADMIN 完全同一条件；生产环境即使漏配开关也不算 mock */
const isDemoMock = () => process.env.NEXT_PUBLIC_ADMIN_API !== 'http' && process.env.NODE_ENV !== 'production';

/** 当前登录账号的角色（#225）。mock 模式没有真实会话，按 ADMIN 演示；读不到会话时不给改分配。 */
async function currentRole(): Promise<string | undefined> {
  if (isDemoMock()) return 'ADMIN';
  try { return ((await auth())?.user as { role?: string } | undefined)?.role; } catch { return undefined; }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await enforceAdminPage(['ADMIN', 'SALES'], `/admin/inquiries/${encodeURIComponent(id)}`);
  // 数据库不可用时留给 layout 显示错误卡片，不跳登录，也不把故障当成 404。
  if (gate === 'unavailable') return null;
  // 服务端再按接口同一个 inquiryScope 查一次（只取 id）：不存在 / 不在范围内（SALES 看别人的或未分配的）→ 页面 404。详情数据仍由客户端走 API
  const c = await checkAdminSession(['ADMIN', 'SALES']);
  if (!c.ok) {
    if (c.reason === 'unavailable') return null;
    notFound();
  }
  if (!ID_RE.test(id)) notFound();
  if (!isDemoMock()) {
    const row = await prisma.inquiry.findFirst({ where: { AND: [{ id }, inquiryScope(c.user)] }, select: { id: true } });
    if (!row) notFound();
  }
  return <InquiryDetailView id={id} role={await currentRole()} />;
}
