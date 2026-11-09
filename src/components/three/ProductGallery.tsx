'use client';
import dynamic from 'next/dynamic';
import { createRef, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useLocale } from 'next-intl';
import type { Product } from '@/data/products';
import type { BoxView } from './FoldBox';
import SceneErrorBoundary from './SceneErrorBoundary';
import { hintText, COARSE_QUERY } from './hint';
import AddToQuoteButton from '@/components/quote/AddToQuoteButton';
import InquireProductLink from '@/components/quote/InquireProductLink';
import { Link } from '@/i18n/navigation';
import { controlCopy, createModelPointerState, reduceModelPointer, shouldAutoRotate, wheelAdmission } from '@/lib/three/model-pointer';
import { accessibilityCopy, keyToCameraCommand, TOUCH_TARGET_PX } from '@/lib/three/model-accessibility';
import { fallbackCopy, retryAllowed, type ModelFailureReason, type ModelLoadResult } from '@/lib/three/model-fallback';
import { detectWebGLSupport } from '@/lib/three/webgl-support';
import {
  MODEL_LOAD_TIMEOUT_MS,
  cancelAllModelAttempts,
  noteModelCancel,
  noteModelFailure,
  noteModelStart,
  noteModelSuccess,
  noteModelTimeout,
} from '@/components/analytics/model-events-producer';
import type { CameraAction } from './GalleryScene';

/**
 * 触控目标下限 44×44（E-101、E-102）。内联样式随组件走：不依赖 globals.css 的 pointer:coarse 断点，
 * 因此键盘与鼠标用户在桌面也能拿到 44px 目标，而不是只有触屏设备才有。
 */
const TOUCH_TARGET_STYLE = { minWidth: TOUCH_TARGET_PX, minHeight: TOUCH_TARGET_PX } as const;
/** 失败条只占视口底部一条，产品海报仍然可见；2px 黑边、0 圆角、无阴影（11 节）。 */
const FALLBACK_STYLE = { position: 'absolute', left: 8, right: 8, bottom: 8, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', background: '#ffffff', border: '2px solid #000000', padding: '6px 8px', textAlign: 'left', zIndex: 1 } as const;
const FALLBACK_TEXT_STYLE = { margin: 0, fontSize: 13, lineHeight: '18px', flex: '1 1 auto' } as const;

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

type Labels = { learnMore: string; specsLabel: string; tap: string; drag: string; loading: string; add: string; inquire?: string; details: string; done: string; views: Record<BoxView, string>; viewsLabel: string };

export default function ProductGallery({ items, labels, onModelResult }: { items: Item[]; labels: Labels; onModelResult?: (result: ModelLoadResult) => void }) {
  const locale = useLocale();
  const copy = controlCopy(locale);
  const keys = accessibilityCopy(locale);
  const fallback = fallbackCopy(locale);
  const rootRef = useRef<HTMLDivElement>(null);
  const tracks = useMemo(() => items.map(() => createRef<HTMLDivElement>()), [items]);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState<Set<string>>(new Set());
  // 模型加载失败的卡片继续显示静态图
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [failureReason, setFailureReason] = useState<Record<string, ModelFailureReason>>({});
  // 每张卡的手动重试次数：只由按钮驱动，没有自动重试循环
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const reportedReady = useRef<Set<string>>(new Set());
  /** 每次真实 GLB 尝试的超时定时器；成功、失败、取消、卸载都必须清掉。 */
  const modelTimers = useRef<Map<string, number>>(new Map());
  const clearModelTimer = useCallback((slug: string) => {
    const timer = modelTimers.current.get(slug);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      modelTimers.current.delete(slug);
    }
  }, []);
  const onError = useCallback((slug: string, reason: ModelFailureReason = 'LOAD_ERROR') => {
    clearModelTimer(slug);
    noteModelFailure(slug, reason);
    setFailed((prev) => (prev.has(slug) ? prev : new Set(prev).add(slug)));
    setFailureReason((prev) => ({ ...prev, [slug]: reason }));
    onModelResult?.({ slug, status: 'failed', reason });
  }, [onModelResult, clearModelTimer]);
  const onModelStart = useCallback((slug: string, attempt: number) => {
    clearModelTimer(slug);
    if (!noteModelStart(slug, attempt)) return;
    const timer = window.setTimeout(() => {
      modelTimers.current.delete(slug);
      noteModelTimeout(slug);
      onError(slug, 'TIMEOUT');
    }, MODEL_LOAD_TIMEOUT_MS);
    modelTimers.current.set(slug, timer);
  }, [clearModelTimer, onError]);
  const onModelLoaded = useCallback((slug: string) => {
    clearModelTimer(slug);
    noteModelSuccess(slug);
  }, [clearModelTimer]);
  const [sceneDead, setSceneDead] = useState(false);
  // WebGL 探测在客户端挂载后跑一次；unknown 期间不挂载画布，避免直接吃浏览器错误
  const [webgl, setWebgl] = useState<'unknown' | 'ok' | 'unavailable'>('unknown');
  const [contextLost, setContextLost] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, BoxView>>({});
  const [pointer, dispatch] = useReducer(reduceModelPointer, false, createModelPointerState);
  const pointerRef = useRef(pointer);
  pointerRef.current = pointer;
  const pointerId = useRef<number | null>(null);
  const zoomSeq = useRef(0);
  /**
   * 滚轮准入许可证（E-98「退出后不得凭遗留 DOM 焦点再次接管」）。
   * 退出路径在调用 dispatch 的同一时刻同步清空它，因此即使 reducer 的新状态还没渲染、
   * 旧 wheel 监听的 cleanup 还没执行，遗留 DOM 焦点也无法让该监听再次缩放相机。
   * 只由「本模型取得焦点」重新签发；明确的 Zoom 按钮不走这条判定，始终可用。
   */
  const wheelPermit = useRef<string | null>(null);
  const [zoom, setZoom] = useState<{ slug: string; delta: number; id: number } | null>(null);
  /**
   * 方向键/旋转按钮/复位的动作通道（E-101、E-104）。与 `zoom` 分开记账：
   * 缩放沿用 M2-T2 已验收的 `requestZoom` 通道，新增动作不会覆盖它的 id。
   */
  const commandSeq = useRef(0);
  const [command, setCommand] = useState<{ slug: string; action: CameraAction; id: number } | null>(null);
  const [fine, setFine] = useState(false);
  const [mouse, setMouse] = useState(false);
  // 角标文案按指针类型选（#172 第 10 点）；SSR 时角标不渲染（模型未就绪），无水合差异
  const [coarse, setCoarse] = useState(false);
  const requestZoom = useCallback((slug: string, delta: number) => {
    if (!delta) return;
    zoomSeq.current += 1;
    setZoom({ slug, delta, id: zoomSeq.current });
  }, []);
  const requestCamera = useCallback((slug: string, action: CameraAction) => {
    commandSeq.current += 1;
    setCommand({ slug, action, id: commandSeq.current });
  }, []);
  const releaseDom = useCallback(() => {
    const slug = pointerRef.current.ownerSlug;
    const id = pointerId.current;
    const index = slug ? items.findIndex((item) => item.slug === slug) : -1;
    const el = index >= 0 ? tracks[index]?.current : null;
    if (el && id != null) {
      el.dispatchEvent(new PointerEvent('pointerup', { pointerId: id, bubbles: true, cancelable: true }));
      // OrbitControls 只在自己内部 releasePointerCapture，从不 set（已核 three-stdlib 2.36.1 全文）：
      // 捕获从来不在我们手里，这里不能再碰捕获状态。合成一个 pointerup 已让它结束本次手势。
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
  useEffect(() => { setWebgl(detectWebGLSupport() ? 'ok' : 'unavailable'); }, []);
  const onContextLost = useCallback(() => setContextLost(true), []);
  // 场景级失败（WebGL 不可用 / context lost / 整块画布异常）对全部卡片生效；
  // 单模型失败只影响该卡片。两种状态都先显示对应产品海报，再由用户手动重试。
  const sceneBlocked = sceneDead || webgl === 'unavailable' || contextLost;
  const sceneReported = useRef(false);
  useEffect(() => {
    if (!sceneBlocked) { sceneReported.current = false; return; }
    if (sceneReported.current) return;
    sceneReported.current = true;
    for (const p of items) {
      if (!p.model) continue;
      // 场景级故障当场结束未决真实尝试（含已滚出视口但计时器仍在跑的卡片）：
      // 写 WEBGL_UNAVAILABLE 终态并清掉计时器，否则 30s 后会再补一条 TIMEOUT 并改掉可见的失败原因（E-103）。
      clearModelTimer(p.slug);
      noteModelFailure(p.slug, 'WEBGL_UNAVAILABLE');
      if (visible.has(p.slug)) onModelResult?.({ slug: p.slug, status: 'failed', reason: 'WEBGL_UNAVAILABLE' });
    }
  }, [sceneBlocked, items, visible, onModelResult, clearModelTimer]);
  const retry = useCallback((slug: string) => {
    const attempt = attempts[slug] ?? 0;
    if (!retryAllowed(attempt)) return;
    clearModelTimer(slug);
    setAttempts((prev) => ({ ...prev, [slug]: attempt + 1 }));
    reportedReady.current.delete(slug);
    setFailed((prev) => { if (!prev.has(slug)) return prev; const next = new Set(prev); next.delete(slug); return next; });
    setReady((prev) => { if (!prev.has(slug)) return prev; const next = new Set(prev); next.delete(slug); return next; });
    if (contextLost || sceneDead) {
      setContextLost(false);
      setSceneDead(false);
      // 场景级失败会让所有卡片一起回退；重挂画布后所有模型都会重新加载
      setReady(new Set());
    }
    if (webgl === 'unavailable') {
      const ok = detectWebGLSupport();
      setWebgl(ok ? 'ok' : 'unavailable');
      if (!ok) onError(slug, 'WEBGL_UNAVAILABLE');
    }
  }, [attempts, contextLost, sceneDead, webgl, onError, clearModelTimer]);
  useEffect(() => {
    dispatch({ type: 'visible', slugs: [...visible] });
  }, [visible]);
  // 切到只渲染程序化 FoldBox 的刀模视图：未决的真实 GLB 尝试按取消处理，不写终态。
  useEffect(() => {
    for (const [slug, view] of Object.entries(views)) {
      if (view !== 'dieline') continue;
      const item = items.find((p) => p.slug === slug);
      if (item?.animationClips?.unfold) continue;
      noteModelCancel(slug);
      clearModelTimer(slug);
    }
  }, [views, items, clearModelTimer]);
  // 页面卸载（路由离开）取消所有未决尝试并清定时器；不补写 failure。
  useEffect(() => () => {
    cancelAllModelAttempts();
    for (const timer of modelTimers.current.values()) window.clearTimeout(timer);
    modelTimers.current.clear();
  }, []);
  useEffect(() => {
    const onUp = () => dispatch({ type: 'pointerup' });
    const onKey = (event: KeyboardEvent) => {
      const current = pointerRef.current;
      if (event.key === 'Escape') {
        if (!current.focusedSlug && !current.dragging && !current.ownerSlug) return;
        event.preventDefault();
        releaseDom();
        // 同步撤销滚轮许可：不等 reducer 渲染，遗留 DOM 焦点也不能再接管 wheel。
        wheelPermit.current = null;
        dispatch({ type: 'escape' });
        const activeEl = document.activeElement;
        if (activeEl instanceof HTMLElement && rootRef.current?.contains(activeEl)) activeEl.blur();
        return;
      }
      // 键盘相机动作（E-101）：只有焦点确实落在某个模型控制区时才接管，其余键一律放行。
      // 焦点一旦移出控制区，focusedSlug 已被 blur-region 清空，这里自然不再命中，Tab 不会被锁住。
      const slug = current.focusedSlug;
      if (!slug) return;
      const cmd = keyToCameraCommand({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey });
      if (!cmd) return;
      event.preventDefault();
      if (cmd.type === 'zoom') requestZoom(slug, cmd.factor < 1 ? -100 : 100);
      else if (cmd.type === 'rotate') requestCamera(slug, { kind: 'rotate', azimuth: cmd.azimuth, polar: cmd.polar });
      else requestCamera(slug, { kind: 'reset' });
    };
    const onWindowBlur = () => {
      releaseDom();
      wheelPermit.current = null;
      dispatch({ type: 'window-blur' });
    };
    const onVis = () => dispatch({ type: 'foreground', on: document.visibilityState === 'visible' });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      releaseDom();
      wheelPermit.current = null;
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [releaseDom, requestZoom, requestCamera]);
  useEffect(() => {
    const slug = pointer.focusedSlug;
    if (!slug) return;
    const index = items.findIndex((item) => item.slug === slug);
    const viewport = index >= 0 ? tracks[index]?.current : null;
    // 焦点 wrapper = article > div[style=min-width:0]，只含视口与命名工具条，不含标题/说明/购买。
    // 监听挂它而不是 article：整张卡片会把正文区也算进准入域（E-98 禁止）。
    const surface = viewport?.parentElement ?? null;
    if (!surface) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      // 语义命中：必须落在本模型的视口或命名工具条内，且在该 wrapper 之内。
      const hitsViewport = !!target?.closest('[data-testid="product-viewport"]');
      const hitsToolbar = !!target?.closest('[data-testid="model-controls"]');
      const inSurface = !!target && surface.contains(target);
      const verdict = wheelAdmission({
        // 焦点归属取真实 DOM 焦点，不用缓存的 focusedSlug 代替（E-98）。
        // 同时要求同步许可证仍属于本模型：退出后即使遗留 DOM 焦点，旧监听也不能再缩放。
        focusBelongsToModel: wheelPermit.current === slug && surface.contains(document.activeElement),
        pointerHitsViewport: hitsViewport && inSurface,
        pointerHitsToolbar: hitsToolbar && inSurface,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
      if (verdict !== 'zoom-camera') return;
      event.preventDefault();
      requestZoom(slug, event.deltaY);
    };
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
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
    // 焦点可能已在该视口上（例如刚取消后 DOM 焦点仍在），此时浏览器不会再派发 focus 事件，
    // 只靠 onFocus 会漏掉重新签发。按下是明确的主动重入，这里同步补发许可。
    wheelPermit.current = slug;
  };
  const onCancel = () => {
    releaseDom();
    wheelPermit.current = null;
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
    if (!reportedReady.current.has(slug)) {
      reportedReady.current.add(slug);
      onModelResult?.({ slug, status: 'ready' });
    }
  }, [onModelResult]);

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
              onFocus={() => {
                // 真实焦点进入本模型控制区才签发滚轮许可。
                wheelPermit.current = p.slug;
                dispatch({ type: 'focus', slug: p.slug });
              }}
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                if (next && event.currentTarget.contains(next)) return;
                // 焦点离开本模型控制区时同步撤销许可，guard 不依赖后续渲染。
                if (wheelPermit.current === p.slug) wheelPermit.current = null;
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
              data-model-state={failed.has(p.slug) || sceneBlocked ? 'failed' : ready.has(p.slug) ? 'ready' : 'pending'}
              data-failure-reason={failed.has(p.slug) ? (failureReason[p.slug] ?? 'LOAD_ERROR') : sceneBlocked ? 'WEBGL_UNAVAILABLE' : ''}
              tabIndex={0}
              className={`stage${active === p.slug ? ' active' : ''}`}
              role="group"
              aria-label={`${copy.controls}: ${p.name}`}
              aria-describedby={`${p.slug}-model-keys`}
              onClick={() => { if (!fine) setActive(p.slug); }}
              onPointerEnter={onEnter(p.slug)}
              onPointerLeave={onLeave(p.slug)}
              onPointerDown={onDown(p.slug)}
              onPointerCancel={onCancel}
            >
              {/* 静态图先显示，模型就绪后淡出，不造成布局偏移 */}
              <img src={p.poster} alt={p.alt ?? p.name} draggable={false} loading={idx < 3 ? 'eager' : 'lazy'} style={{ opacity: ready.has(p.slug) && !failed.has(p.slug) && !sceneBlocked ? 0 : 1 }} />
              {(() => {
                const h = hintText({ failed: failed.has(p.slug) || sceneBlocked, started: !!p.model && armed && visible.has(p.slug), ready: ready.has(p.slug), interacting: pointer.dragging && pointer.ownerSlug === p.slug, coarse }, labels);
                return h && <span className="hint">{h}</span>;
              })()}
              {p.model && (failed.has(p.slug) || sceneBlocked) && (
                <div style={FALLBACK_STYLE} data-testid="model-fallback" data-slug={p.slug} data-reason={failed.has(p.slug) ? (failureReason[p.slug] ?? 'LOAD_ERROR') : 'WEBGL_UNAVAILABLE'}>
                  <p style={FALLBACK_TEXT_STYLE}>{sceneBlocked && webgl !== 'ok' ? fallback.webgl : fallback.failed}</p>
                  <button type="button" className="btn sm" style={TOUCH_TARGET_STYLE} data-testid="model-retry" data-slug={p.slug} disabled={!retryAllowed(attempts[p.slug] ?? 0)} onClick={(e) => { e.stopPropagation(); retry(p.slug); }}>{retryAllowed(attempts[p.slug] ?? 0) ? fallback.retry : fallback.retryLimit}</button>
                </div>
              )}
              {/* 手机端：点卡片进入旋转模式，出现“完成”按钮退出，恢复单指滚动页面（E-102 的退出控件 ≥44px） */}
              {active === p.slug && (
                <button type="button" className="btn sm done" style={TOUCH_TARGET_STYLE} data-testid="model-finish" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setActive(null); }}>{labels.done}</button>
              )}
            </div>
            {/* 键盘操作说明：给屏幕阅读器读，视觉上不占位；内容与真实按键一致 */}
            <p id={`${p.slug}-model-keys`} className="sr-only">{keys.keyboardHint}</p>
            <div className="views" role="group" aria-label={VIEW_SLUGS.has(p.slug) ? `${copy.controls}, ${labels.viewsLabel}` : copy.controls} data-testid="model-controls">
              <button type="button" data-testid="model-rotate-left" style={TOUCH_TARGET_STYLE} aria-label={`${keys.rotateLeft}: ${p.name}`} onClick={(e) => { e.stopPropagation(); setArmed(true); requestCamera(p.slug, { kind: 'rotate', azimuth: Math.PI / 12 }); }}>{keys.rotateLeft}</button>
              <button type="button" data-testid="model-rotate-right" style={TOUCH_TARGET_STYLE} aria-label={`${keys.rotateRight}: ${p.name}`} onClick={(e) => { e.stopPropagation(); setArmed(true); requestCamera(p.slug, { kind: 'rotate', azimuth: -Math.PI / 12 }); }}>{keys.rotateRight}</button>
              <button type="button" data-testid="model-zoom-in" style={TOUCH_TARGET_STYLE} onClick={() => { setArmed(true); requestZoom(p.slug, -100); }}>{copy.zoomIn}</button>
              <button type="button" data-testid="model-zoom-out" style={TOUCH_TARGET_STYLE} onClick={() => { setArmed(true); requestZoom(p.slug, 100); }}>{copy.zoomOut}</button>
              <button type="button" data-testid="model-reset" style={TOUCH_TARGET_STYLE} aria-label={`${keys.resetView}: ${p.name}`} onClick={(e) => { e.stopPropagation(); setArmed(true); requestCamera(p.slug, { kind: 'reset' }); }}>{keys.resetView}</button>
              <button type="button" data-testid="model-pause-rotation" style={TOUCH_TARGET_STYLE} aria-pressed={paused}
                onClick={() => dispatch({ type: 'user-pause', slug: p.slug, paused: !paused })}>
                {paused ? copy.resume : copy.pause}
              </button>
              {VIEW_SLUGS.has(p.slug) && VIEWS.map((v) => (
                <button key={v} type="button" style={TOUCH_TARGET_STYLE} aria-pressed={(views[p.slug] ?? 'closed') === v}
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
                <InquireProductLink slug={p.slug} name={p.name} label={labels.inquire ?? labels.add} />
                {linked && <CatalogLink href={catalogHref} className="category-link" testId="category-link">{labels.learnMore}<span className="sr-only"> {p.name}</span></CatalogLink>}
              </div>
            </div>
          </article>
          );
        })}
      </div>
      {armed && visible.size > 0 && webgl === 'ok' && !sceneBlocked && (<SceneErrorBoundary onError={() => setSceneDead(true)}><GalleryScene
        eventSource={rootRef}
        onReady={onReady}
        onError={onError}
        onContextLost={onContextLost}
        onModelStart={onModelStart}
        onModelLoaded={onModelLoaded}
        items={items.map((p, i) => ({ slug: p.slug, model: p.model, visible: visible.has(p.slug), active: active === p.slug, directRotate: fine || mouse, spin: shouldAutoRotate(pointer, p.slug), zoomId: zoom?.slug === p.slug ? zoom.id : 0, zoomDelta: zoom?.slug === p.slug ? zoom.delta : 0, commandId: command?.slug === p.slug ? command.id : 0, command: command?.slug === p.slug ? command.action : undefined, view: VIEW_SLUGS.has(p.slug) ? views[p.slug] ?? 'closed' : undefined, animationClips: p.animationClips, fitArc: FIT_ARC.has(p.slug), dark: PREMIUM.has(p.slug), attempt: attempts[p.slug] ?? 0, track: tracks[i] })).filter((i) => !!i.model)}
      /></SceneErrorBoundary>)}
    </div>
  );
}
