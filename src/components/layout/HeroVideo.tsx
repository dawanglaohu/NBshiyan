'use client';
// The selected factory video and its own poster retain their complete 16:9 frame on every screen.
import { getImageProps } from 'next/image';
import { useEffect, useReducer, useRef, useState } from 'react';
import { BRAND_MEDIA } from '@/lib/home/brandMedia';
import { heroReducer, isFatalMediaError, markSeen, readEnv, shouldAutoplay, whenIdle } from '@/lib/home/heroVideo';

export const COMPACT_MQ = '(max-width: 767px)';
/** One attempt to reach a decoded frame. A blocked start, a decode error, or this deadline returns to the poster. */
const LOAD_MS = 15_000;

type Labels = { poster: string; skip: string; play: string; pause: string };

export default function HeroVideo({ labels }: { labels: Labels }) {
  const [state, dispatch] = useReducer(heroReducer, 'poster');
  const [mounted, setMounted] = useState(false);
  const [canPlay, setCanPlay] = useState(false);
  const [manualOffer, setManualOffer] = useState(false);
  const [started, setStarted] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const ref = useRef<HTMLVideoElement>(null);
  const autoRef = useRef(false);
  const rewindRef = useRef(false);

  useEffect(() => {
    const env = readEnv();
    setManualOffer(true);
    if (env.reducedMotion || env.saveData) return; // 只显示封面
    setCanPlay(true);
    if (shouldAutoplay(env)) {
      autoRef.current = true;
      whenIdle(window, () => { setMounted(true); dispatch('play'); });
    }
  }, []);

  useEffect(() => {
    const onVis = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (state === 'playing' && pageVisible) {
      if (autoRef.current) { markSeen(readEnv().storage); autoRef.current = false; }
      if (rewindRef.current) { rewindRef.current = false; try { v.currentTime = 0; } catch { /* ignore */ } }
      v.play().catch(() => {
        setStarted(false);
        setMounted(false);
        dispatch('error');
      });
    } else if (state === 'paused' || !pageVisible) v.pause();
  }, [state, mounted, pageVisible]);

  useEffect(() => {
    if (state !== 'playing' || started) return;
    const timer = window.setTimeout(() => {
      const v = ref.current;
      if (v) { v.pause(); rewindRef.current = true; }
      setStarted(false);
      setMounted(false);
      dispatch('error');
    }, LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [state, started]);

  const stop = (ev: 'skip' | 'ended' | 'error') => {
    const v = ref.current;
    // 不在这里回到第 0 帧：否则淡出的 300ms 里会闪一下开箱镜头；下次播放前再回到开头
    if (v) { v.pause(); rewindRef.current = true; }
    setStarted(false);
    setMounted(false);
    dispatch(ev);
  };

  const active = state !== 'poster';
  const { props: posterImg } = getImageProps({
    className: 'hero-media-poster', src: BRAND_MEDIA.video.poster, alt: labels.poster,
    fill: true, priority: true, sizes: '50vw',
  });
  return (
    <div className="hero-stage" data-testid="home-video">
      <div className="hero-media" data-state={state}>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- alt comes from getImageProps */}
        <img {...posterImg} />
        {mounted && (
          <video ref={ref} className="hero-media-video" muted playsInline preload="none"
            aria-hidden="true" tabIndex={-1} data-visible={active && started ? '1' : '0'}
            onPlaying={() => setStarted(true)}
            onEnded={() => stop('ended')} onError={(e) => { if (isFatalMediaError(e.target as Element, e.currentTarget)) stop('error'); }}>
            <source media={COMPACT_MQ} src={BRAND_MEDIA.video.compact} type="video/mp4" />
            <source src={BRAND_MEDIA.video.full} type="video/mp4" />
          </video>
        )}
      </div>
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
        ) : (canPlay || manualOffer) ? (
          <button type="button" className="hero-media-btn" aria-label={labels.play} onClick={() => { setMounted(true); dispatch('play'); }}>
            <span aria-hidden="true">▶</span>
            <span className="hero-media-btn-text" aria-hidden="true">{labels.play}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
