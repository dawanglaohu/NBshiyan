'use client';
import { useState } from 'react';
import FilterChips, { type Chip } from './FilterChips';
import { Button, ImagePlaceholder, Tag } from './ui';

// 案例墙（§3.3）。PM：上线前没有示例客户/数据；cases 为空时只显示空状态。
export type CaseItem = { id: string; industry: string; meta: string; title: string; quote?: string; tags: string[]; image: { path: string; src?: string; alt?: string; ratio?: string } };
type Txt = { all: string; filter: string; empty: string; showAll: string };

export function CaseCard({ c }: { c: CaseItem }) {
  return (
    <article className="sx-case">
      <ImagePlaceholder {...c.image} />
      <div className="sx-card-body">
        <p className="sx-case-meta">{c.meta}</p>
        <h3>{c.title}</h3>
        {c.quote && <blockquote>{c.quote}</blockquote>}
        {c.tags.length > 0 && <div className="sx-tags">{c.tags.map((x) => <Tag key={x}>{x}</Tag>)}</div>}
      </div>
    </article>
  );
}

export default function CaseWall({ cases, industries, t }: { cases: CaseItem[]; industries: { id: string; label: string }[]; t: Txt }) {
  const [sel, setSel] = useState('all');
  const chips: Chip[] = [{ id: 'all', label: t.all, count: cases.length }, ...industries.map((i) => ({ ...i, count: cases.filter((c) => c.industry === i.id).length }))];
  const shown = sel === 'all' ? cases : cases.filter((c) => c.industry === sel);
  return (
    <>
      <FilterChips chips={chips} value={sel} onChange={setSel} label={t.filter} />
      {shown.length === 0 ? (
        <div className="sx-empty">
          <span className="sx-empty-icon" aria-hidden="true" />
          <p>{t.empty}</p>
          {sel !== 'all' && <Button variant="ghost" onClick={() => setSel('all')}>{t.showAll}</Button>}
        </div>
      ) : (
        <div className="sx-masonry">{shown.map((c) => <CaseCard key={c.id} c={c} />)}</div>
      )}
    </>
  );
}
