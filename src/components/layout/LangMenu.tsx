'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, usePathname } from '@/i18n/navigation';
import { LOCALE_META } from '@/i18n/locale-meta';
import { useLangTargets } from './LangLink';

/**
 * 语言下拉（多语言第 0 期，UX 规格）：
 * - 按钮：地球图标 + 当前语言缩写（EN/RU），aria-label 是当前语言全称，aria-haspopup / aria-expanded / aria-controls。
 *   本期不新增文案键（RU 文案需要母语审核），列表用 aria-labelledby 指向按钮。
 * - 列表：母语名称、不用国旗；当前语言排第一并打勾（aria-current），每项带 lang / hrefLang / dir（ar 为 rtl，按 LOCALE_META 统一处理）。
 * - 键盘：Enter/Space/↓ 打开并聚焦第一项，↑ 打开并聚焦最后一项；列表内 ↑↓ 循环、Home/End；Esc 关闭并把焦点还给按钮；Tab 移出即关闭；点外面关闭。
 * - 样式全部走 CSS class（globals.css 的 .lang-menu），不用 style 属性。
 */
export default function LangMenu({ className }: { className?: string }) {
  const { current, targets } = useLangTargets();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<'first' | 'last' | null>(null);
  const id = useId();
  const listId = `${id}-langs`;
  const btnId = `${id}-btn`;

  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]') ?? []);
  const close = useCallback((focusButton: boolean) => { setOpen(false); if (focusButton) btnRef.current?.focus(); }, []);

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const els = items();
    if (pendingFocus.current) (pendingFocus.current === 'last' ? els[els.length - 1] : els[0])?.focus();
    pendingFocus.current = null;
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const openWith = (focus: 'first' | 'last' | null) => { pendingFocus.current = focus; setOpen(true); };

  const onButtonKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); if (open && e.key !== 'ArrowDown') close(false); else if (open) items()[0]?.focus(); else openWith('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) { const els = items(); els[els.length - 1]?.focus(); } else openWith('last'); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); close(true); }
  };

  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const els = items();
    const i = els.indexOf(document.activeElement as HTMLAnchorElement);
    const move = (n: number) => { e.preventDefault(); els[(n + els.length) % els.length]?.focus(); };
    switch (e.key) {
      case 'ArrowDown': return move(i + 1);
      case 'ArrowUp': return move(i < 0 ? els.length - 1 : i - 1);
      case 'Home': return move(0);
      case 'End': return move(els.length - 1);
      case 'Escape': e.preventDefault(); return close(true);
      case 'Tab': return setOpen(false);
      case ' ': e.preventDefault(); (document.activeElement as HTMLElement | null)?.click(); return;
    }
  };

  const meta = LOCALE_META[current];
  return (
    <div ref={rootRef} className={`lang-menu${className ? ` ${className}` : ''}`} data-open={open ? 'true' : undefined}>
      <button
        ref={btnRef}
        id={btnId}
        type="button"
        className="lang lang-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={meta.nativeName}
        onClick={() => (open ? setOpen(false) : openWith(null))}
        onKeyDown={onButtonKey}
      >
        <svg className="lang-globe" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 12h18M12 3c2.6 2.8 3.9 5.8 3.9 9s-1.3 6.2-3.9 9c-2.6-2.8-3.9-5.8-3.9-9S9.4 5.8 12 3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        <span className="lang-code">{meta.short}</span>
        <svg className="lang-caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" focusable="false"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <ul ref={listRef} id={listId} role="menu" aria-labelledby={btnId} className="lang-list" hidden={!open} onKeyDown={onListKey}>
        {targets.map((x) => {
          const m = LOCALE_META[x.locale];
          const isCur = x.locale === current;
          return (
            <li key={x.locale} role="none">
              <Link
                role="menuitem"
                tabIndex={-1}
                href={x.href}
                locale={x.locale}
                hrefLang={x.locale}
                lang={x.locale}
                dir={m.dir}
                aria-current={isCur ? 'true' : undefined}
                className={isCur ? 'lang-item is-current' : 'lang-item'}
                onClick={(e) => { x.onClick(e); setOpen(false); }}
              >
                <span className="lang-name">{m.nativeName}</span>
                {isCur && <svg className="lang-check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
