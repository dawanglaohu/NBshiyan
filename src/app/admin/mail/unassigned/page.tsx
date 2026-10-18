import { enforceAdminPage } from '@/lib/server/admin/page-access';
import { notFound } from 'next/navigation';
import UnassignedInbox from '@/components/admin/mail/UnassignedInbox';
import { mailEnabled } from '@/lib/admin/mail/api';
import { UNASSIGNED_MAIL_LIVE } from '@/lib/admin/mail/features';

// #74 未归类邮件只给 ADMIN（backend-plan v4 8.0：SALES 一律 404）。layout 已按 ADMIN_ROUTE_ROLES 拦截，这里再做页面自己的服务端检查；
// mock 模式同样要求真实会话，不绕过。数据接口另有 requireAdmin(['ADMIN'])。
export const dynamic = 'force-dynamic';

export default async function Page() {
  await enforceAdminPage(['ADMIN'], '/admin/mail/unassigned');
  if (!mailEnabled) notFound(); // 邮件功能未开启（NEXT_PUBLIC_ADMIN_MAIL 未设置）
  if (!UNASSIGNED_MAIL_LIVE) notFound(); // #340：未归类接口后端还没有，入口整体关闭
  return <UnassignedInbox />;
}
