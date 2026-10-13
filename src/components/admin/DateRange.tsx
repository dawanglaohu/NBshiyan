'use client';
import { useEffect, useRef, useState } from 'react';

/** 统一样式的日期范围选择器；显示格式按后台语言本地化（zh-CN / ru-RU），值仍为 YYYY-MM-DD */
const T = {
  'zh-CN': { any: '全部日期', today: '今天', d7: '近 7 天', d30: '近 30 天', month: '本月', from: '从', to: '到', clear: '清除', apply: '确定' },
  'ru-RU': { any: 'Все даты', today: 'Сегодня', d7: '7 дней', d30: '30 дней', month: 'Этот месяц', from: 'С', to: 'По', clear: 'Сбросить', apply: 'Готово' }
} as const;
type Lang = keyof typeof T;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function DateRange({ from, to, onChange, lang = 'zh-CN' }: { from?: string; to?: string; onChange: (from?: string, to?: string) => void; lang?: Lang }) {
  const t = T[lang];
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(from ?? ''); const [tt, setT] = useState(to ?? '');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setF(from ?? ''); setT(to ?? ''); }, [from, to]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const fmt = (s: string) => new Intl.DateTimeFormat(lang, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(`${s}T00:00:00`));
  const label = from || to ? `${from ? fmt(from) : '…'} – ${to ? fmt(to) : '…'}` : t.any;
  const preset = (days: number | 'month') => {
    const end = new Date(); const start = new Date();
    if (days === 'month') start.setDate(1); else start.setDate(end.getDate() - days);
    onChange(iso(start), iso(end)); setOpen(false);
  };
  return (
    <div className="drp" ref={ref}>
      <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>📅 {label}</button>
      {open && (
        <div className="drp-pop" role="dialog" aria-label={t.any}>
          <div className="presets">
            <button type="button" onClick={() => preset(0)}>{t.today}</button>
            <button type="button" onClick={() => preset(7)}>{t.d7}</button>
            <button type="button" onClick={() => preset(30)}>{t.d30}</button>
            <button type="button" onClick={() => preset('month')}>{t.month}</button>
          </div>
          <label>{t.from}<input type="date" lang={lang} value={f} max={tt || undefined} onChange={(e) => setF(e.target.value)} /></label>
          <label>{t.to}<input type="date" lang={lang} value={tt} min={f || undefined} onChange={(e) => setT(e.target.value)} /></label>
          <div className="adm-row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
            <button type="button" className="adm-btn" onClick={() => { onChange(undefined, undefined); setOpen(false); }}>{t.clear}</button>
            <button type="button" className="adm-btn primary" onClick={() => { onChange(f || undefined, tt || undefined); setOpen(false); }}>{t.apply}</button>
          </div>
        </div>
      )}
    </div>
  );
}
