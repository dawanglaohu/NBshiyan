export const metadata = { robots: { index: false, follow: false } };
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="zh-CN"><body style={{ fontFamily: 'system-ui', margin: 0 }}>{children}</body></html>);
}
