import '../globals.css';

// 方案短链接不在多语言路由下（middleware 已排除 /s/），单独的根布局。robots.txt 已 disallow /s/。
export const metadata = { robots: { index: false, follow: false } };

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>);
}
