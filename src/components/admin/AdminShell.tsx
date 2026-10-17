'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, usingMock } from '@/lib/admin/api';
import UnassignedNav from './mail/UnassignedNav';
import { mailEnabled, usingMailMock } from '@/lib/admin/mail/api';
import { DRAWER_FOCUSABLE, DRAWER_MQ, drawerKeyAction } from '@/lib/admin/drawer';

const NAV: { href: string; label: string; ready?: boolean }[] = [
  { href: '/admin/inquiries', label: '询盘', ready: true },
  { href: '/admin/samples', label: '样品申请' }, { href: '/admin/models/new', label: '3D 模型', ready: true },
  { href: '/admin/specs', label: '产品规格', ready: true }, { href: '/admin/content', label: '内容' }, { href: '/admin/stats', label: '数据看板' },
  { href: '/admin/settings', label: '站点设置' }, { href: '/admin/users', label: '账号权限', ready: true }
];

/** role：layout 从服务端会话读出；只用于决定是否显示仅 ADMIN 的入口，权限仍由服务端页面 / 接口判断 */
export default function AdminShell({ children, role }: { children: React.ReactNode; role?: string }) {
  const path = usePathname();
  const [newCount, setNewCount] = useState<number>();
  useEffect(() => { adminApi.listInquiries({ status: 'NEW', pageSize: 1 }).then((d) => setNewCount(d.total)).catch(() => {}); }, [path]);

  // #291 手机版（<768px）侧栏改成抽屉：菜单按钮 aria-expanded/aria-controls；打开后焦点进抽屉并在里面循环，
  // Esc / 点遮罩 / 切换页面关闭，关闭后焦点回到菜单按钮。桌面端侧栏常驻，菜单按钮隐藏。
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const mq = window.matchMedia(DRAWER_MQ);
    const sync = () => { setMobile(mq.matches); if (!mq.matches) setOpen(false); };
    sync(); mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  const close = useCallback((restore = true) => { setOpen(false); if (restore) toggleRef.current?.focus(); }, []);
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    if (!open) return;
    navRef.current?.querySelector<HTMLElement>(DRAWER_FOCUSABLE)?.focus();
    const root = document.documentElement; const prev = root.style.overflow; root.style.overflow = 'hidden';
    return () => { root.style.overflow = prev; };
  }, [open]);
  const onKey = (e: React.KeyboardEvent) => {
    if (!open || !navRef.current) return;
    const f = Array.from(navRef.current.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE));
    const act = drawerKeyAction(e, f.indexOf(document.activeElement as HTMLElement), f.length);
    if (act === 'close') { e.preventDefault(); close(); }
    else if (act === 'wrap-first') { e.preventDefault(); f[0]?.focus(); }
    else if (act === 'wrap-last') { e.preventDefault(); f[f.length - 1]?.focus(); }
  };
  // 手机端抽屉关着时侧栏整块 inert（不可聚焦、读屏读不到）；桌面端常驻
  const hidden = mobile && !open;

  return (
    <div className="adm" data-nav={open ? 'open' : 'closed'}>
      <header className="adm-top">
        <button ref={toggleRef} type="button" className="adm-menu" aria-expanded={open} aria-controls="adm-nav" aria-label={open ? '关闭导航菜单' : '打开导航菜单'} onClick={() => (open ? close() : setOpen(true))}>
          <span aria-hidden="true">☰</span>
        </button>
        <div className="brand">Pack<i>Joy</i>U<small>Admin</small></div>
      </header>
      {open && <div className="adm-scrim" aria-hidden="true" onClick={() => close()} />}
      <nav ref={navRef} id="adm-nav" className="adm-side" aria-label="后台导航" onKeyDown={onKey} inert={hidden || undefined}>
        <div className="brand">Pack<i>Joy</i>U<small>Admin</small></div>
        {mobile && <button type="button" className="adm-nav-close" aria-label="关闭导航菜单" onClick={() => close()}><span aria-hidden="true">✕</span></button>}
        {NAV.map((n) => n.ready
          ? <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? 'page' : undefined}>
              {n.label}{n.href === '/admin/inquiries' && newCount ? <span className="count" aria-label={`${newCount} 条新询盘`}>{newCount}</span> : null}
            </Link>
          : <a key={n.href} className="soon" aria-disabled="true" title="待开发">{n.label}</a>)}
        {mailEnabled && role === 'ADMIN' && <UnassignedNav active={path.startsWith('/admin/mail')} />}
      </nav>
      <main className="adm-main">
        {usingMailMock && <div className="adm-mock" data-testid="mail-mock">邮件功能当前使用示例数据（NEXT_PUBLIC_ADMIN_MAIL=mock），发信不会真的发出。</div>}
        {usingMock && <div className="adm-mock">当前使用示例数据（mock），接入 /api/admin/* 后设置 NEXT_PUBLIC_ADMIN_API=http 切换。</div>}
        {children}
      </main>
    </div>
  );
}
