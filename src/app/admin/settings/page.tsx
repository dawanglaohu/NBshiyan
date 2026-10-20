import { enforceAdminPage } from '@/lib/server/admin/page-access';
import { routing } from '@/i18n/routing';
import { PUBLISHED_LOCALES } from '@/lib/server/published-locales';
import { SITE_URL } from '@/lib/site';
import { ORGANIZATION_DEFAULTS } from '@/lib/seo/organization-defaults';
import AboutSettings from '@/components/admin/settings/AboutSettings';
import OrgSettings from '@/components/admin/settings/OrgSettings';
import { sectionFrom } from '@/components/admin/settings/SettingsSections';

// #350 站点设置（关于我们 / 组织信息）：只给 ADMIN。layout 已按路由拦截（ADMIN_ROUTE_ROLES['/admin/settings'] = ['ADMIN']），
// 这里再做一次页面自己的服务端检查：未登录→登录页，停用/角色不符→404（与 /admin/users 一致）。数据接口另由后端 requireAdmin(['ADMIN'])。
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await enforceAdminPage(['ADMIN'], '/admin/settings');
  const section = sectionFrom((await searchParams).section);
  // 组织信息：网站地址只读，取 SITE_URL；一句话介绍的灰色占位是 SEO 的默认句（只做占位，不预填、不提交）
  if (section === 'org') return <OrgSettings siteUrl={SITE_URL} descriptionPlaceholder={ORGANIZATION_DEFAULTS.description} />;
  // 语言标签按 routing.locales 生成；第 0 期加语言后自动出现。前台是否显示还要看是否已上线（PUBLISHED_LOCALES）
  return <AboutSettings locales={[...routing.locales]} publishedLocales={[...PUBLISHED_LOCALES]} />;
}
