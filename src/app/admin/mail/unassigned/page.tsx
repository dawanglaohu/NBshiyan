import { enforceAdminPage } from '@/lib/server/admin/page-access';
import UnassignedInbox from '@/components/admin/mail/UnassignedInbox';

// #74 未归类邮件只给 ADMIN（backend-plan v4 8.0：SALES 一律 404）。layout 已按 ADMIN_ROUTE_ROLES 拦截，这里再做页面自己的服务端检查；
// mock 模式同样要求真实会话，不绕过。数据接口另有 requireAdmin(['ADMIN'])。
export const dynamic = 'force-dynamic';

export default async function Page() {
  await enforceAdminPage(['ADMIN'], '/admin/mail/unassigned');
  return <UnassignedInbox />;
}
