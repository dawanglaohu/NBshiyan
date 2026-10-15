'use client';
// 横向滚动筛选：不换行；0 条的类目 aria-disabled 不可点（§2.8）
export type Chip = { id: string; label: string; count: number };
export default function FilterChips({ chips, value, onChange, label }: { chips: Chip[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <div className="sx-chips-wrap">
      <div className="sx-chips" role="group" aria-label={label}>
        {chips.map((c) => {
          const off = c.count === 0 && c.id !== 'all';
          return (
            <button key={c.id} type="button" className="sx-chip" aria-pressed={value === c.id} aria-disabled={off || undefined}
              onClick={off ? undefined : () => onChange(c.id)}>{c.label}</button>
          );
        })}
      </div>
    </div>
  );
}
