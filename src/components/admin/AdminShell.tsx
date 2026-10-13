'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usingMock } from '@/lib/admin/api';
import AdminGuard from './AdminGuard';

const NAV: { href: string; label: string; ready?: boolean }[] = [
  { href: '/admin/inquiries', label: '询盘', ready: true },
  { href: '/admin/samples', label: '样品申请' }, { href: '/admin/models', label: '3D 模型' },
  { href: '/admin/content', label: '内容（Sanity）' }, { href: '/admin/stats', label: '数据看板' },
  { href: '/admin/settings', label: '站点设置' }, { href: '/admin/users', label: '账号权限' }
];

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  return (
    <div className="adm">
      <nav className="adm-side" aria-label="后台导航">
        <div className="brand">PackJoyU</div>
        {NAV.map((n) => n.ready
          ? <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? 'page' : undefined}>{n.label}</Link>
          : <a key={n.href} className="soon" aria-disabled="true" title="待开发">{n.label}</a>)}
      </nav>
      <main className="adm-main">
        {usingMock && <div className="adm-mock">当前使用示例数据（mock），接入 /api/admin/* 后设置 NEXT_PUBLIC_ADMIN_API=http 切换。</div>}
        <AdminGuard>{children}</AdminGuard>
      </main>
    </div>
  );
}
