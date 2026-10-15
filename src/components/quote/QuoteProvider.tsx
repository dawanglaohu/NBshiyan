'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { addQuoteItem, parseQuoteItems, QUOTE_MAX_ITEMS, type QuoteItem } from '@/lib/quote/list';

export type { QuoteItem };
type Ctx = {
  items: QuoteItem[];
  /** 返回 false 表示清单已满（20 项），没有添加；同时显示提示 */
  add: (slug: string) => boolean;
  full: boolean;
  remove: (slug: string) => void;
  clear: () => void;
  open: boolean;
  setOpen: (v: boolean) => void;
};
const KEY = 'pj-quote-v1';
const QuoteCtx = createContext<Ctx | null>(null);

export function QuoteProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<QuoteItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const t = useTranslations('Quote');
  const itemsRef = useRef(items); itemsRef.current = items;
  const noticeTimer = useRef<number | undefined>(undefined);
  // 询价清单存在 localStorage，刷新和换页都保留
  useEffect(() => {
    try { setItems(parseQuoteItems(localStorage.getItem(KEY))); } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
  }, [items, loaded]);
  const add = useCallback((slug: string) => {
    const r = addQuoteItem(itemsRef.current, slug);
    if (r.status === 'full') {
      // 满 20 项：不添加、不丢弃已有项，显示提示（aria-live）
      setNotice(''); window.setTimeout(() => setNotice(t('full', { max: QUOTE_MAX_ITEMS })), 0);
      window.clearTimeout(noticeTimer.current); noticeTimer.current = window.setTimeout(() => setNotice(''), 6000);
      return false;
    }
    if (r.status === 'added') { itemsRef.current = r.items; setItems(r.items); }
    return true;
  }, [t]);
  const remove = useCallback((slug: string) => setItems((p) => p.filter((i) => i.slug !== slug)), []);
  const clear = useCallback(() => setItems([]), []);
  const full = items.length >= QUOTE_MAX_ITEMS;
  const value = useMemo(() => ({ items, add, full, remove, clear, open, setOpen }), [items, add, full, remove, clear, open]);
  return (
    <QuoteCtx.Provider value={value}>
      {children}
      <div className={`quote-notice${notice ? ' on' : ''}`} role="status" aria-live="polite">{notice}</div>
    </QuoteCtx.Provider>
  );
}

export function useQuote() {
  const c = useContext(QuoteCtx);
  if (!c) throw new Error('useQuote outside QuoteProvider');
  return c;
}
