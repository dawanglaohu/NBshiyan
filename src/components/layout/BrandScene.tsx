'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { BRAND_MEDIA } from '@/lib/home/brandMedia';
import { shouldAutoplay } from '@/lib/home/heroVideo';

export const CITY_VIDEO_1384 = BRAND_MEDIA.scene.video1384;
export const CITY_VIDEO_2000 = BRAND_MEDIA.scene.video2000;
export const CITY_FRAME_WIDTH = 1384;
export const CITY_FRAME_HEIGHT = 720;
/** Wider than the 1384 master, in CSS pixels times devicePixelRatio, selects the 2000 file. */
export const CITY_VIDEO_WIDTH_CUTOFF = 1384;
/** Pause still. src is the 1384 WebP; the 2000w file is only a srcset candidate. */
export const CITY_STILL_SRC = '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp';
export const CITY_STILL_SRCSET = '/brand/packjoyu-industrial-city-v3-loop-poster-1384.webp 1384w, /brand/packjoyu-industrial-city-v3-loop-poster-2000.webp 2000w';
export const CITY_STILL_SIZES = '(min-width:1489px) calc(100vw - 48px), min(1240px, 100vw - 40px)';
const CITY_STILL_PNG = '/brand/packjoyu-industrial-city-v3-loop-poster.png';
/** Load only once the section is this close to the viewport. */
export const CITY_SCENE_ROOT_MARGIN = '300px 0px 300px 0px';
/** Hero's idle callback gives up at 3s. Wait past that, then start the city file anyway. */
const HERO_FIRST_REQUEST_WAIT_MS = 5000;

const VIDEO_BOX: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
  objectPosition: 'center',
  pointerEvents: 'none',
};

type Labels = { alt: string; play: string; pause: string; title?: string };

/** One choice for the life of the player. Does not repeat the still sizes formula. */
export function cityVideoForFrame(width: number, dpr: number): string {
  return width * dpr > CITY_VIDEO_WIDTH_CUTOFF ? CITY_VIDEO_2000 : CITY_VIDEO_1384;
}

function heroStillTakingFirstRequest(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  let storage: Storage | null = null;
  try { storage = localStorage; } catch { storage = null; }
  if (!shouldAutoplay({
    storage,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    saveData: connection?.saveData === true,
  })) return false;
  return document.querySelector('[data-testid="home-video"] video') === null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export default function BrandScene({ labels, stillSrc }: { labels: Labels; stillSrc?: string }) {
  const section = useRef<HTMLElement>(null);
  const media = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const chosenSrc = useRef<string | null>(null);
  const didLoad = useRef(false);
  const wantPlayRef = useRef(false);
  const failedRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [admitted, setAdmitted] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [userArmed, setUserArmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setMounted(true);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReduced(motion.matches);
    // Commit the pause before the page freezes. A later paint never runs while frozen.
    const updateVisibility = () => {
      const visible = document.visibilityState === 'visible';
      flushSync(() => setPageVisible(visible));
      if (!visible) videoRef.current?.pause();
    };
    const hidePage = () => {
      flushSync(() => setPageVisible(false));
      videoRef.current?.pause();
    };
    updateMotion();
    updateVisibility();
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    document.addEventListener('freeze', hidePage);
    document.addEventListener('resume', updateVisibility);
    let loadObserver: IntersectionObserver | undefined;
    let viewObserver: IntersectionObserver | undefined;
    if ('IntersectionObserver' in window && section.current) {
      loadObserver = new IntersectionObserver(([entry]) => setAdmitted(entry.isIntersecting), { rootMargin: CITY_SCENE_ROOT_MARGIN });
      viewObserver = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
      loadObserver.observe(section.current);
      viewObserver.observe(section.current);
    } else {
      setAdmitted(true);
      setInView(true);
    }
    return () => {
      loadObserver?.disconnect();
      viewObserver?.disconnect();
      motion.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
      document.removeEventListener('freeze', hidePage);
      document.removeEventListener('resume', updateVisibility);
    };
  }, []);

  const allowDownload = admitted && !failed && (!reduced || userArmed);
  const wantPlay = allowDownload && inView && pageVisible && !userPaused;
  wantPlayRef.current = wantPlay;
  failedRef.current = failed;

  useEffect(() => {
    if (!allowDownload || chosenSrc.current) return;
    let cancelled = false;
    let timer = 0;
    const started = performance.now();
    const attempt = () => {
      if (cancelled || chosenSrc.current) return;
      if (heroStillTakingFirstRequest() && performance.now() - started < HERO_FIRST_REQUEST_WAIT_MS) {
        timer = window.setTimeout(attempt, 50);
        return;
      }
      const frame = media.current;
      const width = frame?.getBoundingClientRect().width ?? 0;
      if (width <= 0) {
        timer = window.setTimeout(attempt, 50);
        return;
      }
      chosenSrc.current = cityVideoForFrame(width, window.devicePixelRatio || 1);
      if (!cancelled) setSrc(chosenSrc.current);
    };
    attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [allowDownload]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let active = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('disableremoteplayback', '');
    const player = video as HTMLVideoElement & { disablePictureInPicture?: boolean; disableRemotePlayback?: boolean };
    player.disablePictureInPicture = true;
    player.disableRemotePlayback = true;
    // preload=none does not fetch when src is assigned. load() once starts that fetch.
    // Pause and resume must not call it again: load() drops the current frame.
    if (!didLoad.current) {
      didLoad.current = true;
      video.load();
    }
    if (wantPlay) {
      video.play().catch((error: unknown) => {
        if (!active || !wantPlayRef.current || isAbort(error)) return;
        setRevealed(false);
        setFailed(true);
      });
    } else {
      video.pause();
    }
    return () => { active = false; };
  }, [wantPlay, src]);

  const requestedStill = stillSrc ?? BRAND_MEDIA.scene.poster;
  const cityStill = requestedStill === CITY_STILL_SRC || requestedStill === CITY_STILL_PNG || requestedStill === BRAND_MEDIA.scene.pauseStill;
  const still = cityStill ? CITY_STILL_SRC : requestedStill;
  const showFrame = revealed && !failed;

  const toggle = () => {
    if (wantPlay) {
      videoRef.current?.pause();
      setUserPaused(true);
      setUserArmed(false);
      return;
    }
    const frame = media.current;
    const width = frame?.getBoundingClientRect().width ?? 0;
    const canAttach = admitted && width > 0 && !heroStillTakingFirstRequest();
    if (!canAttach) {
      setFailed(false);
      setUserPaused(false);
      setUserArmed(true);
      return;
    }
    if (!chosenSrc.current) chosenSrc.current = cityVideoForFrame(width, window.devicePixelRatio || 1);
    // flushSync runs the play effect inside this click, so play() stays on the user gesture.
    flushSync(() => {
      setFailed(false);
      setUserPaused(false);
      setUserArmed(true);
      setSrc(chosenSrc.current);
    });
  };

  return (
    <section
      ref={section}
      className="block container brand-scene-section"
      data-testid="brand-scene"
      data-admitted={admitted ? '1' : '0'}
      data-in-view={inView ? '1' : '0'}
      data-page-visible={pageVisible ? '1' : '0'}
      data-user-paused={userPaused ? '1' : '0'}
      data-state={wantPlay ? 'playing' : 'still'}
      {...(labels.title ? { 'aria-labelledby': 'brand-scene-title' } : { 'aria-label': labels.alt })}
    >
      {labels.title ? <h2 id="brand-scene-title">{labels.title}</h2> : null}
      <div ref={media} className="brand-scene-media">
        <img
          src={still}
          alt={labels.alt}
          width={CITY_FRAME_WIDTH}
          height={CITY_FRAME_HEIGHT}
          loading="lazy"
          decoding="async"
          data-testid="brand-scene-still"
          srcSet={cityStill ? CITY_STILL_SRCSET : undefined}
          sizes={cityStill ? CITY_STILL_SIZES : undefined}
        />
        {src && (
          <video
            ref={videoRef}
            src={src}
            muted
            playsInline
            loop
            preload="none"
            aria-hidden="true"
            data-testid="brand-scene-video"
            data-revealed={showFrame ? '1' : '0'}
            width={CITY_FRAME_WIDTH}
            height={CITY_FRAME_HEIGHT}
            style={{ ...VIDEO_BOX, opacity: showFrame ? 1 : 0 }}
            onPlaying={() => {
              if (failedRef.current) {
                videoRef.current?.pause();
                return;
              }
              setRevealed(true);
              if (!wantPlayRef.current) videoRef.current?.pause();
            }}
            onError={() => {
              if (!videoRef.current?.error) return;
              setRevealed(false);
              setFailed(true);
            }}
          />
        )}
      </div>
      {mounted && (
        <div className="brand-scene-controls">
          <Button context="public" variant="secondary" aria-pressed={wantPlay} onClick={toggle}>
            {wantPlay ? labels.pause : labels.play}
          </Button>
        </div>
      )}
    </section>
  );
}
