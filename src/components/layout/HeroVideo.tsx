'use client';
// #104 首屏视频：封面图（next/image priority）先渲染，是 LCP 元素；空闲后才加载视频（preload="none"）
// 仅首次访问自动播放；有 暂停/播放 + 跳过 两个按钮（WCAG 2.2.2）；播完/跳过停在封面，不循环
import Image from 'next/image';
import { useEffect, useReducer, useRef, useState } from 'react';
import { heroReducer, markSeen, readEnv, shouldAutoplay, whenIdle } from '@/lib/home/heroVideo';

type Labels = { poster: string; skip: string; play: string; pause: string };

export default function HeroVideo({ labels }: { labels: Labels }) {
  const [state, dispatch] = useReducer(heroReducer, 'poster');
  const [mounted, setMounted] = useState(false);
  const [canPlay, setCanPlay] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);
  const autoRef = useRef(false);

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
      v.play().catch(() => dispatch('error'));
    } else if (state === 'paused') v.pause();
  }, [state, mounted]);

  const stop = (ev: 'skip' | 'ended' | 'error') => {
    const v = ref.current;
    if (v) { v.pause(); try { v.currentTime = 0; } catch { /* ignore */ } }
    dispatch(ev);
  };

  const active = state !== 'poster';
  return (
    <div className="hero-media" data-state={state}>
      <Image className="hero-media-poster" src="/video/hero-115-poster.webp" alt={labels.poster}
        fill priority sizes="(max-width: 767px) 100vw, 50vw" />
      {mounted && (
        <video ref={ref} className="hero-media-video" muted playsInline preload="none"
          aria-hidden="true" tabIndex={-1} data-visible={active ? '1' : '0'}
          onEnded={() => stop('ended')} onError={() => stop('error')}>
          <source src="/video/hero-115.webm" type="video/webm" />
          <source src="/video/hero-115.mp4" type="video/mp4" />
        </video>
      )}
      <div className="hero-media-ctrls">
        {active ? (
          <>
            <button type="button" className="hero-media-btn" aria-pressed={state === 'paused'}
              onClick={() => dispatch(state === 'playing' ? 'pause' : 'play')}>
              <span aria-hidden="true">{state === 'playing' ? '❚❚' : '▶'}</span> {state === 'playing' ? labels.pause : labels.play}
            </button>
            <button type="button" className="hero-media-btn" onClick={() => stop('skip')}>
              <span aria-hidden="true">✕</span> {labels.skip}
            </button>
          </>
        ) : canPlay ? (
          <button type="button" className="hero-media-btn" onClick={() => { setMounted(true); dispatch('play'); }}>
            <span aria-hidden="true">▶</span> {labels.play}
          </button>
        ) : null}
      </div>
    </div>
  );
}
