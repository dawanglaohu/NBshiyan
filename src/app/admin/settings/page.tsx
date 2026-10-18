import { enforceAdminPage } from '@/lib/server/admin/page-access';
import { routing } from '@/i18n/routing';
import { PUBLISHED_LOCALES } from '@/lib/server/published-locales';
import AboutSettings from '@/components/admin/settings/AboutSettings';

// #350 站点设置 · 公司介绍：只给 ADMIN。layout 已按路由拦截（ADMIN_ROUTE_ROLES['/admin/settings'] = ['ADMIN']），
// 这里再做一次页面自己的服务端检查：未登录→登录页，停用/角色不符→404（与 /admin/users 一致）。数据接口另由后端 requireAdmin(['ADMIN'])。
export const dynamic = 'force-dynamic';

export default async function Page() {
  await enforceAdminPage(['ADMIN'], '/admin/settings');
  // 语言标签按 routing.locales 生成；第 0 期加语言后自动出现。前台是否显示还要看是否已上线（PUBLISHED_LOCALES）
  return <AboutSettings locales={[...routing.locales]} publishedLocales={[...PUBLISHED_LOCALES]} />;
}
