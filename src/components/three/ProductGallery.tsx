'use client';
import '@/styles/views.css';
import dynamic from 'next/dynamic';
import { createRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '@/data/products';
import type { BoxView } from './FoldBox';
import SceneErrorBoundary from './SceneErrorBoundary';
import AddToQuoteButton from '@/components/quote/AddToQuoteButton';

const PREMIUM = new Set(['gift-boxes', 'wine-boxes']);
const HOVER_ZOOM_MS = 500;
// 支持“合盖 / 开盖 / 展开刀模”切换的品类
const VIEW_SLUGS = new Set(['gift-boxes', 'wine-boxes', 'corrugated-boxes']);
const VIEWS: BoxView[] = ['closed', 'open', 'dieline'];

// three.js 只在客户端按需加载，不进首屏包
const GalleryScene = dynamic(() => import('./GalleryScene'), { ssr: false });

type Item = Product & { name: string; desc?: string; alt?: string };
type Labels = { tap: string; loading: string; add: string; details: string; done: string; views: Record<BoxView, string>; viewsLabel: string };

export default function ProductGallery({ items, labels }: { items: Item[]; labels: Labels }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tracks = useMemo(() => items.map(() => createRef<HTMLDivElement>()), [items]);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState<Set<string>>(new Set());
  // 模型加载失败的卡片继续显示静态图
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const onError = useCallback((slug: string) => setFailed((prev) => (prev.has(slug) ? prev : new Set(prev).add(slug))), []);
  const [sceneDead, setSceneDead] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  // 桌面端滚轮缩放：只有按住鼠标或悬停 0.5 秒后才交给模型，否则滚轮照常滚动页面
  const [views, setViews] = useState<Record<string, BoxView>>({});
  const [zoomSlug, setZoomSlug] = useState<string | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const pressed = useRef(false);
  const finePointer = useRef(false);
  useEffect(() => {
    finePointer.current = window.matchMedia('(pointer: fine)').matches;
    const up = () => { pressed.current = false; };
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointerup', up); window.clearTimeout(hoverTimer.current); };
  }, []);
  const onEnter = (slug: string) => (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setZoomSlug(slug), HOVER_ZOOM_MS);
  };
  const onLeave = () => { window.clearTimeout(hoverTimer.current); if (!pressed.current) setZoomSlug(null); };
  const onDown = (slug: string) => (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    pressed.current = true;
    setZoomSlug(slug);
  };
  // three.js 不参与首屏：用户第一次交互（移动鼠标、滚动、触摸、按键）后才加载 3D，
  // 或页面完全空闲 4 秒后兜底加载，避免阻塞主线程影响首屏指标
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (armed) return;
    const arm = () => setArmed(true);
    const evts = ['pointermove', 'pointerdown', 'wheel', 'touchstart', 'keydown', 'scroll'] as const;
    evts.forEach((e) => window.addEventListener(e, arm, { once: true, passive: true }));
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const timer = window.setTimeout(() => (ric ? ric(arm, { timeout: 2000 }) : arm()), 4000);
    return () => { evts.forEach((e) => window.removeEventListener(e, arm)); window.clearTimeout(timer); };
  }, [armed]);

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
          <article key={p.slug} id={p.slug} className={`card${PREMIUM.has(p.slug) ? ' theme-premium' : ''}`}>
            <div
              ref={tracks[idx]}
              data-slug={p.slug}
              className={`stage${active === p.slug ? ' active' : ''}`}
              onClick={() => { if (!finePointer.current) setActive(p.slug); }}
              onPointerEnter={onEnter(p.slug)}
              onPointerLeave={onLeave}
              onPointerDown={onDown(p.slug)}
            >
              {/* 静态图先显示，模型就绪后淡出，不造成布局偏移 */}
              <img src={p.poster} alt={p.alt ?? p.name} loading={idx < 3 ? 'eager' : 'lazy'} style={{ opacity: ready.has(p.slug) && !failed.has(p.slug) && !sceneDead ? 0 : 1 }} />
              {!failed.has(p.slug) && !sceneDead && <span className="hint">{ready.has(p.slug) ? (active === p.slug || zoomSlug === p.slug ? '↻' : labels.tap) : labels.loading}</span>}
              {/* 手机端：点卡片进入旋转模式，出现“完成”按钮退出，恢复单指滚动页面 */}
              {active === p.slug && (
                <button type="button" className="btn sm done" onClick={(e) => { e.stopPropagation(); setActive(null); }}>{labels.done}</button>
              )}
            </div>
            <div className="body">
              <h2 style={{ fontSize: 16, margin: 0 }}>{p.name}</h2>
              <AddToQuoteButton slug={p.slug} />
            </div>
            {p.desc && <p className="desc">{p.desc}</p>}
            {VIEW_SLUGS.has(p.slug) && (
              <div className="views" role="group" aria-label={labels.viewsLabel}>
                {VIEWS.map((v) => (
                  <button key={v} type="button" aria-pressed={(views[p.slug] ?? 'closed') === v}
                    onClick={(e) => { e.stopPropagation(); setArmed(true); setViews((s) => ({ ...s, [p.slug]: v })); }}>
                    {labels.views[v]}
                  </button>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      {armed && visible.size > 0 && !sceneDead && (<SceneErrorBoundary onError={() => setSceneDead(true)}><GalleryScene
        eventSource={rootRef}
        onReady={onReady}
        onError={onError}
        items={items.map((p, i) => ({ slug: p.slug, model: p.model, visible: visible.has(p.slug), active: active === p.slug || zoomSlug === p.slug, zoom: zoomSlug === p.slug || (active === p.slug && !finePointer.current), view: VIEW_SLUGS.has(p.slug) ? views[p.slug] ?? 'closed' : undefined, animationClips: p.animationClips, track: tracks[i] }))}
      /></SceneErrorBoundary>)}
    </div>
  );
}
