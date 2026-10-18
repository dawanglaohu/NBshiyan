'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useLangSwitch } from './LangLink';

// 站点头部：桌面端一行链接；手机端只留 Logo + 语言切换 + 菜单按钮，链接收进抽屉（#63）
// #350 aboutVisible：由服务端 layout 按站点设置传入（当前语言的 /about 是否显示），隐藏时直接不渲染入口，避免先出现再消失
export default function SiteHeader({ aboutVisible = false }: { aboutVisible?: boolean }) {
  const t = useTranslations('Nav');
  const pathname = usePathname();
  const langSw = useLangSwitch();
  const other = langSw.other;
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // 路由变化时关闭抽屉
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? []);
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
      if (e.key !== 'Tab') return;
      const els = focusables();
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const btn = btnRef.current;
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; btn?.focus(); };
  }, [open]);

  const links = (
    <>
      <Link href="/">{t('home')}</Link>
      <Link href="/products">{t('products')}</Link>
      {aboutVisible && <Link href="/about" aria-current={pathname === '/about' ? 'page' : undefined}>{t('about')}</Link>}
      <Link href="/contact">{t('contact')}</Link>
    </>
  );
  const lang = (
    <Link href={langSw.href} locale={other} onClick={langSw.onClick} className="lang" hrefLang={other} aria-label={t('switchLang')}>{other.toUpperCase()}</Link>
  );

  return (
    <header className="site">
      <Link href="/" className="logo">Pack<i>Joy</i>U</Link>
      <nav className="nav-desktop" aria-label={t('main')}>
        {links}
        {lang}
        <Link href="/contact" className="btn sm">{t('quote')}</Link>
      </nav>
      <div className="nav-mobile">
        {lang}
        <button ref={btnRef} type="button" className="menu-btn" aria-expanded={open} aria-controls="mobile-menu" aria-label={open ? t('closeMenu') : t('openMenu')} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
        </button>
      </div>
      {open && (
        <>
          <div className="drawer-mask" onClick={() => setOpen(false)} aria-hidden="true" />
          <div ref={panelRef} id="mobile-menu" className="nav-drawer" role="dialog" aria-modal="true" aria-label={t('menu')}>
            <div className="nav-drawer-head">
              <span className="logo">Pack<i>Joy</i>U</span>
              <button type="button" className="linkbtn close" aria-label={t('closeMenu')} onClick={() => setOpen(false)}>✕</button>
            </div>
            <nav aria-label={t('main')}>{links}</nav>
            <Link href="/contact" className="btn">{t('quote')}</Link>
          </div>
        </>
      )}
    </header>
  );
}
