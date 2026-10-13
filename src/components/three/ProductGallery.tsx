'use client';
import dynamic from 'next/dynamic';
import { createRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '@/data/products';

// three.js 只在客户端按需加载，不进首屏包
const GalleryScene = dynamic(() => import('./GalleryScene'), { ssr: false });

type Item = Product & { name: string };
type Labels = { tap: string; loading: string; add: string; details: string };

export default function ProductGallery({ items, labels }: { items: Item[]; labels: Labels }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tracks = useMemo(() => items.map(() => createRef<HTMLDivElement>()), [items]);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);

  // 视口内才加载和渲染模型，提前 200px 预热
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      setVisible((prev) => {
        const next = new Set(prev);
        for (const e of entries) {
          const slug = (e.target as HTMLElement).dataset.slug!;
          if (e.isIntersecting) next.add(slug); else next.delete(slug);
        }
        return next;
      });
    }, { rootMargin: '200px' });
    tracks.forEach((t) => t.current && io.observe(t.current));
    return () => io.disconnect();
  }, [tracks]);

  const onReady = useCallback((slug: string) => {
    setReady((prev) => (prev.has(slug) ? prev : new Set(prev).add(slug)));
  }, []);

  return (
    <div ref={rootRef}>
      <div className="grid">
        {items.map((p, idx) => (
          <article key={p.slug} id={p.slug} className="card">
            <div
              ref={tracks[idx]}
              data-slug={p.slug}
              className={`stage${active === p.slug ? ' active' : ''}`}
              onClick={() => setActive(p.slug)}
            >
              {/* 静态图先显示，模型就绪后淡出，不造成布局偏移 */}
              <img src={p.poster} alt={p.name} loading={idx < 3 ? 'eager' : 'lazy'} style={{ opacity: ready.has(p.slug) ? 0 : 1 }} />
              <span className="hint">{ready.has(p.slug) ? (active === p.slug ? '↻' : labels.tap) : labels.loading}</span>
            </div>
            <div className="body">
              <h2 style={{ fontSize: 16, margin: 0 }}>{p.name}</h2>
              <button type="button">{labels.add}</button>
            </div>
          </article>
        ))}
      </div>
      <GalleryScene
        eventSource={rootRef}
        onReady={onReady}
        items={items.map((p, i) => ({ slug: p.slug, model: p.model, visible: visible.has(p.slug), active: active === p.slug, track: tracks[i] }))}
      />
    </div>
  );
}
