'use client';

import { useEffect, useRef, useState } from 'react';
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
  const [near, setNear] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [reduced, setReduced] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [userArmed, setUserArmed] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMounted(true);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReduced(motion.matches);
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible');
    updateMotion();
    updateVisibility();
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    let observer: IntersectionObserver | undefined;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: CITY_GIF_ROOT_MARGIN });
      if (section.current) observer.observe(section.current);
    } else {
      setNear(true);
    }
    return () => {
      observer?.disconnect();
      motion.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  // Reduced motion stays on the still until the visitor presses play. A pause choice survives scroll and tab hide.
  const showGif = near && pageVisible && !userPaused && !failed && (!reduced || userArmed);
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
