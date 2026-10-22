'use client';

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { BRAND_MEDIA } from '@/lib/home/brandMedia';

/** Full city loop. The 960×500 preview is a different frame and cannot share this pause still. */
export const CITY_GIF_SRC = '/brand/packjoyu-industrial-city-v3-loop.gif';
export const CITY_GIF_WIDTH = 1384;
export const CITY_GIF_HEIGHT = 720;
/** Load only once the section is this close to the viewport. */
export const CITY_GIF_ROOT_MARGIN = '300px 0px 300px 0px';

type Labels = { alt: string; play: string; pause: string; title?: string };

export default function BrandScene({ labels, stillSrc }: { labels: Labels; stillSrc?: string }) {
  const section = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState(false);
  const [admitted, setAdmitted] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const prefetched = useRef(false);
  const [reduced, setReduced] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [userArmed, setUserArmed] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMounted(true);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReduced(motion.matches);
    // Commit the still or the GIF before the page freezes. A later paint never runs while frozen.
    const updateVisibility = () => { flushSync(() => setPageVisible(document.visibilityState === 'visible')); };
    const hidePage = () => { flushSync(() => setPageVisible(false)); };
    updateMotion();
    updateVisibility();
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    document.addEventListener('freeze', hidePage);
    document.addEventListener('resume', updateVisibility);
    let loadObserver: IntersectionObserver | undefined;
    let viewObserver: IntersectionObserver | undefined;
    if ('IntersectionObserver' in window && section.current) {
      loadObserver = new IntersectionObserver(([entry]) => setAdmitted(entry.isIntersecting), { rootMargin: CITY_GIF_ROOT_MARGIN });
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
  useEffect(() => {
    if (!allowDownload || prefetched.current) return;
    prefetched.current = true;
    const img = new Image();
    img.decoding = 'async';
    img.src = CITY_GIF_SRC;
  }, [allowDownload]);

  // 300px only admits the download. Playback needs the real viewport, a visible page, and no user pause.
  const showGif = allowDownload && inView && pageVisible && !userPaused;
  const still = stillSrc ?? BRAND_MEDIA.scene.poster;

  const toggle = () => {
    if (showGif) {
      setUserPaused(true);
      setUserArmed(false);
      return;
    }
    setUserPaused(false);
    setUserArmed(true);
    setFailed(false);
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
      data-state={showGif ? 'playing' : 'still'}
      {...(labels.title ? { 'aria-labelledby': 'brand-scene-title' } : { 'aria-label': labels.alt })}
    >
      {labels.title ? <h2 id="brand-scene-title">{labels.title}</h2> : null}
      <div className="brand-scene-media">
        <img
          src={still}
          alt={labels.alt}
          width={CITY_GIF_WIDTH}
          height={CITY_GIF_HEIGHT}
          loading="lazy"
          decoding="async"
          data-testid="brand-scene-still"
        />
        {showGif && (
          <img
            src={CITY_GIF_SRC}
            alt=""
            aria-hidden="true"
            width={CITY_GIF_WIDTH}
            height={CITY_GIF_HEIGHT}
            data-testid="brand-scene-gif"
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {mounted && (
        <div className="brand-scene-controls">
          <Button context="public" variant="secondary" aria-pressed={showGif} onClick={toggle}>
            {showGif ? labels.pause : labels.play}
          </Button>
        </div>
      )}
    </section>
  );
}
