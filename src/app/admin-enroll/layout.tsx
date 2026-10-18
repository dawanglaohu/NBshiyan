import { Manrope } from 'next/font/google';
import './enroll.css';

// P1 管理员首次绑定 2FA。不放在 /admin 下（那里的 layout 会把未登录的人重定向到登录页）。
// 不收录：noindex + next.config 里的 X-Robots-Tag / no-store；robots.txt 的 Disallow: /admin 按前缀匹配也覆盖 /admin-enroll。
// 中间件 matcher 的 (?!...admin...) 前缀排除同样覆盖 /admin-enroll，不会被加语言前缀。
export const metadata = { title: '绑定 2FA · PackJoyU 管理后台', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const manrope = Manrope({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-sans' });

export default function AdminEnrollLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="zh-CN" className={manrope.variable}><body style={{ margin: 0 }}>{children}</body></html>);
}
