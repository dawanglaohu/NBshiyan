'use client';
import dynamic from 'next/dynamic';
import { createRef, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import type { Product } from '@/data/products';
import type { BoxView } from './FoldBox';
import SceneErrorBoundary from './SceneErrorBoundary';
import { hintText, COARSE_QUERY } from './hint';
import AddToQuoteButton from '@/components/quote/AddToQuoteButton';
import { Link } from '@/i18n/navigation';
import { controlCopy, createModelPointerState, reduceModelPointer, shouldAutoRotate, wheelAction } from '@/lib/three/model-pointer';

/** 深色卡片（.theme-premium）：卡片样式和 3D 轮廓光共用这一份 */
export const PREMIUM = new Set(['gift-boxes', 'wine-boxes']);
// 支持“合盖 / 开盖 / 展开刀模”切换的品类
const VIEW_SLUGS = new Set(['gift-boxes', 'wine-boxes', 'corrugated-boxes']);
/** 开合途中按整条盖子弧线取景的产品（盖子中途会从顶部出画）；礼盒开盖后静止就放不下，本来就走这条路 */
export const FIT_ARC = new Set(['wine-boxes']);
const VIEWS: BoxView[] = ['closed', 'open', 'dieline'];

// three.js 只在客户端按需加载，不进首屏包
const GalleryScene = dynamic(() => import('./GalleryScene'), { ssr: false });

type Item = Product & { name: string; desc?: string; alt?: string; specs?: string[] };

/** 未上线时地址是本页锚点（`#key` 或 `/products#key`）。这种地址不做成链接。 */
export function isCatalogSelfAnchor(href: string): boolean {
  if (href.startsWith('#')) return true;
  const hash = href.indexOf('#');
  if (hash < 0) return false;
  return /\/products$/.test(href.slice(0, hash));
}

/** 站内品类路径走 Link，才会带上语言前缀。本页锚点由调用方改成纯文本，不会进这里。 */
function CatalogLink({ href, className, testId, children }: { href: string; className: string; testId: string; children: ReactNode }) {
  return <Link href={href} className={className} data-testid={testId}>{children}</Link>;
}

type Labels = { learnMore: string; specsLabel: string; tap: string; drag: string; loading: string; add: string; details: string; done: string; views: Record<BoxView, string>; viewsLabel: string };

export default function ProductGallery({ items, labels }: { items: Item[]; labels: Labels }) {
  const copy = controlCopy(useLocale());
  const rootRef = useRef<HTMLDivElement>(null);
  const tracks = useMemo(() => items.map(() => createRef<HTMLDivElement>()), [items]);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState<Set<string>>(new Set());
  // 模型加载失败的卡片继续显示静态图
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const onError = useCallback((slug: string) => setFailed((prev) => (prev.has(slug) ? prev : new Set(prev).add(slug))), []);
  const [sceneDead, setSceneDead] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, BoxView>>({});
  const [pointer, dispatch] = useReducer(reduceModelPointer, false, createModelPointerState);
  const pointerRef = useRef(pointer);
  pointerRef.current = pointer;
  const pointerId = useRef<number | null>(null);
  const zoomSeq = useRef(0);
  const [zoom, setZoom] = useState<{ slug: string; delta: number; id: number } | null>(null);
  const [fine, setFine] = useState(false);
  const [mouse, setMouse] = useState(false);
  // 角标文案按指针类型选（#172 第 10 点）；SSR 时角标不渲染（模型未就绪），无水合差异
  const [coarse, setCoarse] = useState(false);
  const requestZoom = useCallback((slug: string, delta: number) => {
    if (!delta) return;
    zoomSeq.current += 1;
    setZoom({ slug, delta, id: zoomSeq.current });
  }, []);
  const releaseDom = useCallback(() => {
    const slug = pointerRef.current.ownerSlug;
    const id = pointerId.current;
    const index = slug ? items.findIndex((item) => item.slug === slug) : -1;
    const el = index >= 0 ? tracks[index]?.current : null;
    if (el && id != null) {
      el.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, bubbles: true, cancelable: true }));
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    }
    pointerId.current = null;
  }, [items, tracks]);
  useEffect(() => {
    const mq = window.matchMedia(COARSE_QUERY);
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: fine)');
    const sync = () => setFine(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => dispatch({ type: 'reduced', on: mq.matches });
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  useEffect(() => {
    dispatch({ type: 'visible', slugs: [...visible] });
  }, [visible]);
  useEffect(() => {
    const onUp = () => dispatch({ type: 'pointerup' });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const current = pointerRef.current;
      if (!current.focusedSlug && !current.dragging && !current.ownerSlug) return;
      event.preventDefault();
      releaseDom();
      dispatch({ type: 'escape' });
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLElement && rootRef.current?.contains(activeEl)) activeEl.blur();
    };
    const onWindowBlur = () => {
      releaseDom();
      dispatch({ type: 'window-blur' });
    };
    const onVis = () => dispatch({ type: 'foreground', on: document.visibilityState === 'visible' });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      releaseDom();
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [releaseDom]);
  useEffect(() => {
    const slug = pointer.focusedSlug;
    if (!slug) return;
    const index = items.findIndex((item) => item.slug === slug);
    const el = index >= 0 ? tracks[index]?.current : null;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (wheelAction({ focused: true, ctrlKey: event.ctrlKey, metaKey: event.metaKey }) !== 'zoom-camera') return;
      event.preventDefault();
      requestZoom(slug, event.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pointer.focusedSlug, items, tracks, requestZoom]);
  const onEnter = (slug: string) => (event: React.PointerEvent) => {
    if (event.pointerType === 'mouse') setMouse(true);
    dispatch({ type: 'pointerenter', slug, pointerType: event.pointerType });
  };
  const onLeave = (slug: string) => () => {
    dispatch({ type: 'pointerleave', slug });
  };
  const onDown = (slug: string) => (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    pointerId.current = event.pointerId;
    dispatch({ type: 'pointerdown', slug, pointerType: event.pointerType, button: event.button });
    event.currentTarget.focus({ preventScroll: true });
  };
  const onCancel = () => {
    releaseDom();
    dispatch({ type: 'pointercancel' });
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
    <div ref={rootRef} data-capture-owner={pointer.ownerSlug ?? ''} data-focused-model={pointer.focusedSlug ?? ''} data-direct-rotate={fine || mouse ? '1' : '0'}>
      <div className="grid product-grid">
        {items.map((p, idx) => {
          const catalogHref = p.landing ?? `#${p.slug}`;
          const linked = !isCatalogSelfAnchor(catalogHref);
          const spinning = shouldAutoRotate(pointer, p.slug);
          const paused = pointer.userPaused.includes(p.slug);
          return (
          <article key={p.slug} id={p.slug} className={`card${PREMIUM.has(p.slug) ? ' theme-premium' : ''}`}>
            <div
              style={{ minWidth: 0 }}
              onFocus={() => dispatch({ type: 'focus', slug: p.slug })}
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                if (next && event.currentTarget.contains(next)) return;
                dispatch({ type: 'blur-region', slug: p.slug });
              }}
            >
            <div
              ref={tracks[idx]}
              data-slug={p.slug}
              data-testid="product-viewport"
              data-spinning={spinning ? '1' : '0'}
              data-user-paused={paused ? '1' : '0'}
              data-focused={pointer.focusedSlug === p.slug ? '1' : '0'}
              tabIndex={0}
              className={`stage${active === p.slug ? ' active' : ''}`}
              onClick={() => { if (!fine) setActive(p.slug); }}
              onPointerEnter={onEnter(p.slug)}
              onPointerLeave={onLeave(p.slug)}
              onPointerDown={onDown(p.slug)}
              onPointerCancel={onCancel}
            >
              {/* 静态图先显示，模型就绪后淡出，不造成布局偏移 */}
              <img src={p.poster} alt={p.alt ?? p.name} draggable={false} loading={idx < 3 ? 'eager' : 'lazy'} style={{ opacity: ready.has(p.slug) && !failed.has(p.slug) && !sceneDead ? 0 : 1 }} />
              {(() => {
                const h = hintText({ failed: failed.has(p.slug) || sceneDead, started: armed && visible.has(p.slug), ready: ready.has(p.slug), interacting: pointer.dragging && pointer.ownerSlug === p.slug, coarse }, labels);
                return h && <span className="hint">{h}</span>;
              })()}
              {/* 手机端：点卡片进入旋转模式，出现“完成”按钮退出，恢复单指滚动页面 */}
              {active === p.slug && (
                <button type="button" className="btn sm done" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setActive(null); }}>{labels.done}</button>
              )}
            </div>
            <div className="views" role="group" aria-label={VIEW_SLUGS.has(p.slug) ? `${copy.controls}, ${labels.viewsLabel}` : copy.controls} data-testid="model-controls">
              <button type="button" data-testid="model-zoom-in" onClick={() => { setArmed(true); requestZoom(p.slug, -100); }}>{copy.zoomIn}</button>
              <button type="button" data-testid="model-zoom-out" onClick={() => { setArmed(true); requestZoom(p.slug, 100); }}>{copy.zoomOut}</button>
              <button type="button" data-testid="model-pause-rotation" aria-pressed={paused}
                onClick={() => dispatch({ type: 'user-pause', slug: p.slug, paused: !paused })}>
                {paused ? copy.resume : copy.pause}
              </button>
              {VIEW_SLUGS.has(p.slug) && VIEWS.map((v) => (
                <button key={v} type="button" aria-pressed={(views[p.slug] ?? 'closed') === v}
                  onClick={(e) => { e.stopPropagation(); setArmed(true); setViews((s) => ({ ...s, [p.slug]: v })); }}>
                  {labels.views[v]}
                </button>
              ))}
            </div>
            </div>
            <div className="body">
              <h2>
                {linked ? <CatalogLink href={catalogHref} className="product-name-link" testId="product-name-link">{p.name}</CatalogLink> : p.name}
              </h2>
              {p.desc && <p className="desc">{p.desc}</p>}
              {p.specs && p.specs.length > 0 && (
                <ul className="specs" aria-label={labels.specsLabel}>{p.specs.slice(0, 3).map((s) => <li key={s}>{s}</li>)}</ul>
              )}
              <div className="actions">
                <AddToQuoteButton slug={p.slug} />
                {linked && <CatalogLink href={catalogHref} className="category-link" testId="category-link">{labels.learnMore}<span className="sr-only"> {p.name}</span></CatalogLink>}
              </div>
            </div>
          </article>
          );
        })}
      </div>
      {armed && visible.size > 0 && !sceneDead && (<SceneErrorBoundary onError={() => setSceneDead(true)}><GalleryScene
        eventSource={rootRef}
        onReady={onReady}
        onError={onError}
        items={items.map((p, i) => ({ slug: p.slug, model: p.model, visible: visible.has(p.slug), active: active === p.slug, directRotate: fine || mouse, spin: shouldAutoRotate(pointer, p.slug), zoomId: zoom?.slug === p.slug ? zoom.id : 0, zoomDelta: zoom?.slug === p.slug ? zoom.delta : 0, view: VIEW_SLUGS.has(p.slug) ? views[p.slug] ?? 'closed' : undefined, animationClips: p.animationClips, fitArc: FIT_ARC.has(p.slug), dark: PREMIUM.has(p.slug), track: tracks[i] }))}
      /></SceneErrorBoundary>)}
    </div>
  );
}
