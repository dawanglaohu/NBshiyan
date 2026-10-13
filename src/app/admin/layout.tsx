import './admin.css';
import AdminShell from '@/components/admin/AdminShell';

// 后台不收录：noindex，且不在 sitemap（sitemap.ts 只列多语言前台页面），robots.txt 已 disallow /admin
export const metadata = { title: 'PackJoyU 管理后台', robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="zh-CN"><body style={{ margin: 0 }}><AdminShell>{children}</AdminShell></body></html>);
}
