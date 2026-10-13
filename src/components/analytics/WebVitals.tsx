'use client';
import { useEffect, useRef } from 'react';
import { useReportWebVitals } from 'next/web-vitals';
import { hasAnalyticsConsent, onConsentChange } from '@/lib/client/consent';

// 只有用户同意 analytics 后才上报；发到本站 /api/rum（CSP connect-src 'self' 即可）
export default function WebVitals() {
  const ok = useRef(false);
  useEffect(() => { ok.current = hasAnalyticsConsent(); return onConsentChange(() => { ok.current = hasAnalyticsConsent(); }); }, []);
  useReportWebVitals((m) => {
    if (!ok.current || !['LCP', 'CLS', 'INP', 'FCP', 'TTFB'].includes(m.name)) return;
    const body = JSON.stringify({
      name: m.name, value: m.value, rating: m.rating, id: m.id, nav: m.navigationType,
      path: location.pathname.slice(0, 200),
      device: matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop'
    });
    if (!navigator.sendBeacon?.('/api/rum', new Blob([body], { type: 'application/json' })))
      fetch('/api/rum', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
  });
  return null;
}
