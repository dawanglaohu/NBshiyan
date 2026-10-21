'use client';

import { useEffect, useRef, useState } from 'react';
import { BRAND_MEDIA } from '@/lib/home/brandMedia';

type Labels = { alt: string; play: string; pause: string };

export default function BrandScene({ labels }: { labels: Labels }) {
  const section = useRef<HTMLElement>(null);
  const [requested, setRequested] = useState(false);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [canAnimate, setCanAnimate] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const navigatorWithConnection = navigator as Navigator & { connection?: { saveData?: boolean } };
    const updateMotion = () => setCanAnimate(!motion.matches && navigatorWithConnection.connection?.saveData !== true);
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible');
    updateMotion();
    updateVisibility();
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    if (!('IntersectionObserver' in window)) {
      setInView(true);
      return () => { motion.removeEventListener('change', updateMotion); document.removeEventListener('visibilitychange', updateVisibility); };
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    if (section.current) observer.observe(section.current);
    return () => { observer.disconnect(); motion.removeEventListener('change', updateMotion); document.removeEventListener('visibilitychange', updateVisibility); };
  }, []);

  const active = requested && inView && pageVisible && canAnimate;
  return (
    <section ref={section} className="block container brand-scene-section" aria-label={labels.alt}>
      <div className="brand-scene-media">
        <img src={BRAND_MEDIA.scene.poster} alt={labels.alt} width={BRAND_MEDIA.scene.width} height={BRAND_MEDIA.scene.height} loading="lazy" decoding="async" />
        {active && <img src={BRAND_MEDIA.scene.animation} alt="" aria-hidden="true" width={BRAND_MEDIA.scene.width} height={BRAND_MEDIA.scene.height} onError={() => setRequested(false)} />}
      </div>
      <div className="brand-scene-controls">
        {canAnimate && <button type="button" className="btn ghost" aria-pressed={requested} onClick={() => setRequested((value) => !value)}>{requested ? labels.pause : labels.play}</button>}
      </div>
    </section>
  );
}
