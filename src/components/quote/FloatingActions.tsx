'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '@/i18n/navigation';
import { useQuote } from './QuoteProvider';

// 右下角悬浮按钮组：询价清单、客服、回到顶部；手机上收成一个按钮
export default function FloatingActions() {
  const t = useTranslations('Fab');
  const q = useTranslations('Quote');
  const names = useTranslations('Products.names');
  const { items, remove, open, setOpen } = useQuote();
  const [expanded, setExpanded] = useState(false);
  // 收起规则只在 ≤767px 生效。桌面端没有折叠，expanded 初始为 false，不能据此把按钮标成 inert。
  const [narrow, setNarrow] = useState(false);
  const fabRef = useRef<HTMLDivElement>(null);
  // #116 询价流程（/contact 里的 InquiryWizard）中手机端隐藏悬浮按钮组，避免挡住选项
  const inQuote = usePathname() === '/contact';
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  // 收起时菜单仍占展开高度（visibility 隐藏，不用 display:none），所以这里测到的一直是展开高度。
  // 整组被 display:none（询价页）时高度为 0，不把 --fab-h 写成 0。
  useEffect(() => {
    const el = fabRef.current;
    if (!el) return;
    const root = document.documentElement;
    const write = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) root.style.setProperty('--fab-h', `${h}px`);
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty('--fab-h'); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  const menuHidden = narrow && !expanded;
  const toTop = () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };
  return (
    <>
      <div ref={fabRef} className={`fab${expanded ? ' open' : ''}${inQuote ? ' fab-quote' : ''}`}>
        <button type="button" className="item" aria-label={`${t('quote')} (${items.length})`} title={t('quote')} onClick={() => setOpen(true)} aria-hidden={menuHidden || undefined} inert={menuHidden || undefined}>
          🧾{items.length > 0 && <span className="badge">{items.length}</span>}
        </button>
        <Link id="floating-human-contact" className="item" href="/contact" aria-label={t('chat')} title={t('chat')} aria-hidden={menuHidden || undefined} inert={menuHidden || undefined}>💬</Link>
        <button type="button" className="item" aria-label={t('top')} title={t('top')} onClick={toTop} aria-hidden={menuHidden || undefined} inert={menuHidden || undefined}>↑</button>
        <button type="button" className="toggle" aria-expanded={expanded} aria-label={t('menu')} onClick={() => setExpanded((v) => !v)}>
          {expanded ? '×' : '☰'}{!expanded && items.length > 0 && <span className="badge">{items.length}</span>}
        </button>
      </div>
      {open && (
        <>
          <div className="drawer-mask" onClick={() => setOpen(false)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={q('title')}>
            <header>
              <strong>{q('title')} ({items.length})</strong>
              <button type="button" className="linkbtn" onClick={() => setOpen(false)} aria-label={q('close')}>✕</button>
            </header>
            {items.length === 0 ? (
              <p style={{ padding: '16px 20px', flex: 1 }}>{q('empty')}</p>
            ) : (
              <ul>
                {items.map((i) => (
                  <li key={i.slug}>
                    <span>{names.has(i.slug) ? names(i.slug) : i.slug}</span>
                    <button type="button" className="linkbtn" onClick={() => remove(i.slug)}>{q('remove')}</button>
                  </li>
                ))}
              </ul>
            )}
            <footer>
              {items.length > 0 ? (
                <Link className="btn" style={{ width: '100%' }} href="/contact?from=quote" onClick={() => setOpen(false)}>{q('continue')}</Link>
              ) : (
                <Link className="btn ghost" style={{ width: '100%' }} href="/products" onClick={() => setOpen(false)}>{q('browse')}</Link>
              )}
            </footer>
          </aside>
        </>
      )}
    </>
  );
}
