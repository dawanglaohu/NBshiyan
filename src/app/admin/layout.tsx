import { Manrope } from 'next/font/google';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import './admin.css';
import AdminShell from '@/components/admin/AdminShell';
import { checkAdminSession } from '@/lib/server/admin/guard';
import { adminGate, ADMIN_AREA_ROLES } from '@/lib/server/admin/layout-gate';

// 后台不收录：noindex，且不在 sitemap（sitemap.ts 只列多语言前台页面），robots.txt 已 disallow /admin
export const metadata = { title: 'PackJoyU 管理后台', robots: { index: false, follow: false } };
// 每次请求都在服务端检查会话，不缓存
export const dynamic = 'force-dynamic';

// 和前台一样用 next/font 加载 Manrope（latin + cyrillic），通过 --font-sans 使用（#150）；中文回落到系统字体
const manrope = Manrope({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-sans' });

/**
 * 第一道防线：所有 /admin 页面渲染前在服务端检查会话、账号状态和角色。
 * 未登录 → 登录页（callbackUrl 只允许站内路径）；角色不对或该页面（ADMIN_ROUTE_ROLES）不允许此角色 → 404。
 * 注意：layout 不能替代各页面 / 接口自己的检查（客户端导航时 layout 不一定重新执行），/api/admin/* 仍各自 requireAdmin。
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const check = await checkAdminSession([...ADMIN_AREA_ROLES]);
  const gate = adminGate(check.ok ? { ok: true, role: check.user.role } : { ok: false, status: check.status }, (await headers()).get('x-admin-path'));
  if (gate.action === 'redirect') redirect(gate.to);
  if (gate.action === 'notFound') notFound();
  return (<html lang="zh-CN" className={manrope.variable}><body style={{ margin: 0 }}><AdminShell>{children}</AdminShell></body></html>);
}
