import { Manrope } from 'next/font/google';
import './admin.css';
import AdminShell from '@/components/admin/AdminShell';

// 后台不收录：noindex，且不在 sitemap（sitemap.ts 只列多语言前台页面），robots.txt 已 disallow /admin
export const metadata = { title: 'PackJoyU 管理后台', robots: { index: false, follow: false } };

// 和前台一样用 next/font 加载 Manrope（latin + cyrillic），通过 --font-sans 使用（#150）；中文回落到系统字体
const manrope = Manrope({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-sans' });

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="zh-CN" className={manrope.variable}><body style={{ margin: 0 }}><AdminShell>{children}</AdminShell></body></html>);
}
