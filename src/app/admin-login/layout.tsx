import { Manrope } from 'next/font/google';
import './login.css';

// 自定义后台登录页。不放在 /admin 下，避免未登录时被后台 layout 再送去登录。
// 不收录、不缓存、不带 Referer：noindex + next.config 的 X-Robots-Tag / no-store / Referrer-Policy。
// robots.txt 的 Disallow: /admin 按前缀覆盖 /admin-login。中间件 matcher 的 admin 前缀排除同样覆盖这里。
export const metadata = {
  title: '登录 · PackJoyU 管理后台',
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
};
export const dynamic = 'force-dynamic';

const manrope = Manrope({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-sans' });

export default function AdminLoginLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="zh-CN" className={manrope.variable}><body style={{ margin: 0 }}>{children}</body></html>);
}
