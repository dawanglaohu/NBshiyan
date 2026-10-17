'use client';
// #104 首屏视频：封面图（next/image priority）先渲染，是 LCP 元素；空闲后才加载视频（preload="none"）
// ≤767px 用 4:5 竖版素材（#115 portrait）：<picture>/<source media> 选封面，<video><source media> 选视频，桌面不下载竖版
// 仅首次访问自动播放；有 暂停/播放 + 跳过 两个按钮（WCAG 2.2.2）；播完/跳过停在封面，不循环
// #291 控件统一在左下（所有状态同一容器），和品牌文字一组、间距 ≥24px；所有宽度只显示图标（44×44 + aria-label），不压产品
// #291 品牌文字是 HTML 叠层（素材已无文字，#305）：始终显示在封面和视频上；alt 已含品牌和标语，所以 aria-hidden
// #291 封面是视频最后一帧、视频从开箱镜头开始：视频真正开始播放（playing 事件）后再 300ms 交叉淡入
import { getImageProps } from 'next/image';
import { type ReactNode, useEffect, useReducer, useRef, useState } from 'react';
import { heroReducer, isFatalMediaError, markSeen, readEnv, shouldAutoplay, whenIdle } from '@/lib/home/heroVideo';

export const PORTRAIT_MQ = '(max-width: 767px)';
const DESKTOP_MQ = '(min-width: 768px)';
const POSTER_SIZES = '1280px';

type Labels = { brand: ReactNode; tagline: string; poster: string; skip: string; play: string; pause: string };

export default function HeroVideo({ labels }: { labels: Labels }) {
  const [state, dispatch] = useReducer(heroReducer, 'poster');
  const [mounted, setMounted] = useState(false);
  const [canPlay, setCanPlay] = useState(false);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const autoRef = useRef(false);
  const rewindRef = useRef(false);

  useEffect(() => {
    const env = readEnv();
    if (env.reducedMotion || env.saveData) return; // 只显示封面
    setCanPlay(true);
    if (shouldAutoplay(env)) {
      autoRef.current = true;
      whenIdle(window, () => { setMounted(true); dispatch('play'); });
    }
  }, []);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (state === 'playing') {
      if (autoRef.current) { markSeen(readEnv().storage); autoRef.current = false; }
      if (rewindRef.current) { rewindRef.current = false; try { v.currentTime = 0; } catch { /* ignore */ } }
      v.play().catch(() => dispatch('error'));
    } else if (state === 'paused') v.pause();
  }, [state, mounted]);

  const stop = (ev: 'skip' | 'ended' | 'error') => {
    const v = ref.current;
    // 不在这里回到第 0 帧：否则淡出的 300ms 里会闪一下开箱镜头；下次播放前再回到开头
    if (v) { v.pause(); rewindRef.current = true; }
    setStarted(false);
    dispatch(ev);
  };

  const active = state !== 'poster';
  // 桌面封面仍走 next/image 优化；竖版封面直接用 3D 产出的 AVIF/WebP（已是 1080x1350 小文件）
  // #291 LCP：封面原始尺寸必须不小于视频（1280×720），否则 Chrome 会把 <video> 首帧当成更大的 LCP 候选。
  // 所以 sizes 按封面原图宽度 1280px 写（srcset 选 w=1920 条目，优化器不放大，实际返回 1280 宽）；竖版封面与竖版视频同为 1080×1350
  const { props: { srcSet: desktopSrcSet, ...posterImg } } = getImageProps({
    className: 'hero-media-poster', src: '/video/hero-115-poster.59e587a1.webp', alt: labels.poster,
    fill: true, priority: true, sizes: POSTER_SIZES,
  });
  return (
    <div className="hero-media" data-state={state}>
      <picture>
        <source media={PORTRAIT_MQ} type="image/avif" srcSet="/video/hero-115-portrait-poster.avif" />
        <source media={PORTRAIT_MQ} type="image/webp" srcSet="/video/hero-115-portrait-poster.webp" />
        <source media={DESKTOP_MQ} srcSet={desktopSrcSet} sizes={POSTER_SIZES} />
        {/* eslint-disable-next-line jsx-a11y/alt-text -- alt 来自 getImageProps */}
        <img {...posterImg} srcSet={desktopSrcSet} />
      </picture>
      {mounted && (
        <video ref={ref} className="hero-media-video" muted playsInline preload="none"
          aria-hidden="true" tabIndex={-1} data-visible={active && started ? '1' : '0'}
          onPlaying={() => setStarted(true)}
          onEnded={() => stop('ended')} onError={(e) => { if (isFatalMediaError(e.target as Element, e.currentTarget)) stop('error'); }}>
          <source media={PORTRAIT_MQ} src="/video/hero-115-portrait.webm" type="video/webm" />
          <source media={PORTRAIT_MQ} src="/video/hero-115-portrait.mp4" type="video/mp4" />
          <source src="/video/hero-115.c293080a.webm" type="video/webm" />
          <source src="/video/hero-115.c2be059f.mp4" type="video/mp4" />
        </video>
      )}
      <p className="hero-brand" aria-hidden="true">
        <span className="hero-brand-inner">
          <span className="hero-brand-name">{labels.brand}</span>
          <span className="hero-brand-tagline">{labels.tagline}</span>
        </span>
      </p>
      <div className="hero-media-ctrls">
        {active ? (
          <>
            <button type="button" className="hero-media-btn" aria-pressed={state === 'paused'}
              aria-label={state === 'playing' ? labels.pause : labels.play}
              onClick={() => dispatch(state === 'playing' ? 'pause' : 'play')}>
              <span aria-hidden="true">{state === 'playing' ? '❚❚' : '▶'}</span>
              <span className="hero-media-btn-text" aria-hidden="true">{state === 'playing' ? labels.pause : labels.play}</span>
            </button>
            <button type="button" className="hero-media-btn" aria-label={labels.skip} onClick={() => stop('skip')}>
              <span aria-hidden="true">✕</span>
              <span className="hero-media-btn-text" aria-hidden="true">{labels.skip}</span>
            </button>
          </>
        ) : canPlay ? (
          <button type="button" className="hero-media-btn" aria-label={labels.play} onClick={() => { setMounted(true); dispatch('play'); }}>
            <span aria-hidden="true">▶</span>
            <span className="hero-media-btn-text" aria-hidden="true">{labels.play}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
