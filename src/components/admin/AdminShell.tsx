'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { adminApi, usingMock } from '@/lib/admin/api';

const NAV: { href: string; label: string; ready?: boolean }[] = [
  { href: '/admin/inquiries', label: '询盘', ready: true },
  { href: '/admin/samples', label: '样品申请' }, { href: '/admin/models/new', label: '3D 模型', ready: true },
  { href: '/admin/specs', label: '产品规格', ready: true }, { href: '/admin/content', label: '内容' }, { href: '/admin/stats', label: '数据看板' },
  { href: '/admin/settings', label: '站点设置' }, { href: '/admin/users', label: '账号权限' }
];

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [newCount, setNewCount] = useState<number>();
  useEffect(() => { adminApi.listInquiries({ status: 'NEW', pageSize: 1 }).then((d) => setNewCount(d.total)).catch(() => {}); }, [path]);
  return (
    <div className="adm">
      <nav className="adm-side" aria-label="后台导航">
        <div className="brand">Pack<i>Joy</i>U<small>Admin</small></div>
        {NAV.map((n) => n.ready
          ? <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? 'page' : undefined}>
              {n.label}{n.href === '/admin/inquiries' && newCount ? <span className="count" aria-label={`${newCount} 条新询盘`}>{newCount}</span> : null}
            </Link>
          : <a key={n.href} className="soon" aria-disabled="true" title="待开发">{n.label}</a>)}
      </nav>
      <main className="adm-main">
        {usingMock && <div className="adm-mock">当前使用示例数据（mock），接入 /api/admin/* 后设置 NEXT_PUBLIC_ADMIN_API=http 切换。</div>}
        {children}
      </main>
    </div>
  );
}
