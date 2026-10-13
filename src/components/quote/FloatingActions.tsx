'use client';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useTawk } from '@/components/chat/useTawk';
import { Link } from '@/i18n/navigation';
import { useQuote } from './QuoteProvider';

// 右下角悬浮按钮组：询价清单、客服、回到顶部；手机上收成一个按钮
export default function FloatingActions() {
  const t = useTranslations('Fab');
  const q = useTranslations('Quote');
  const names = useTranslations('Products.names');
  const { items, remove, open, setOpen } = useQuote();
  const [expanded, setExpanded] = useState(false);
  const chat = useTawk(useLocale());
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  const toTop = () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };
  return (
    <>
      <div className={`fab${expanded ? ' open' : ''}`}>
        <button type="button" className="item" aria-label={`${t('quote')} (${items.length})`} title={t('quote')} onClick={() => setOpen(true)}>
          🧾{items.length > 0 && <span className="badge">{items.length}</span>}
        </button>
        {/* 配置了 Tawk.to 且已同意 Cookie 时打开在线客服，否则跳到联系页 */}
        {chat.enabled ? (
          <button type="button" className="item" aria-label={t('chat')} title={t('chat')} onClick={() => chat.open()}>💬</button>
        ) : (
          <Link className="item" href="/contact" aria-label={t('chat')} title={t('chat')}>💬</Link>
        )}
        <button type="button" className="item" aria-label={t('top')} title={t('top')} onClick={toTop}>↑</button>
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
