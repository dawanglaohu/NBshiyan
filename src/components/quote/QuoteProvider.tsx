'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type QuoteItem = { slug: string; quantity?: number };
type Ctx = {
  items: QuoteItem[];
  add: (slug: string) => void;
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
  // 询价清单存在 localStorage，刷新和换页都保留
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setItems(parsed.filter((i) => typeof i?.slug === 'string').slice(0, 30));
    } catch {}
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {}
  }, [items, loaded]);
  const add = useCallback((slug: string) => setItems((p) => (p.some((i) => i.slug === slug) ? p : [...p, { slug }].slice(0, 30))), []);
  const remove = useCallback((slug: string) => setItems((p) => p.filter((i) => i.slug !== slug)), []);
  const clear = useCallback(() => setItems([]), []);
  const value = useMemo(() => ({ items, add, remove, clear, open, setOpen }), [items, add, remove, clear, open]);
  return <QuoteCtx.Provider value={value}>{children}</QuoteCtx.Provider>;
}

export function useQuote() {
  const c = useContext(QuoteCtx);
  if (!c) throw new Error('useQuote outside QuoteProvider');
  return c;
}
