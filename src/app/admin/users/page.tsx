import { enforceAdminPage } from '@/lib/server/admin/page-access';
import UsersAdmin from '@/components/admin/users/UsersAdmin';

// 账号管理只给 ADMIN。layout 已按路由拦截，这里再做一次页面自己的服务端检查：未登录→登录页，停用/角色不符→404；数据接口另有 requireAdmin(['ADMIN'])
export const dynamic = 'force-dynamic';

export default async function Page() {
  await enforceAdminPage(['ADMIN'], '/admin/users');
  return <UsersAdmin />;
}
