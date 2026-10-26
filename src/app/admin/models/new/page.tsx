import ModelUpload from '@/components/admin/models/ModelUpload';
import { enforceAdminPage } from '@/lib/server/admin/page-access';
// 页面自己的服务端检查：未登录→登录页，停用/角色不符→404
export const dynamic = 'force-dynamic';
export default async function Page() {
  const gate = await enforceAdminPage(['ADMIN', 'EDITOR'], '/admin/models/new');
  if (!gate.ok) return gate.notice;
  return <ModelUpload />;
}
