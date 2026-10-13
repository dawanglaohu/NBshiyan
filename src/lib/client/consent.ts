'use client';
// TODO: 全栈的 Cookie 同意条上线后，改为读取它的同意状态。
// 目前约定：同意后 localStorage 写入 pj-consent = "granted"（或包含 "chat"/"all" 的 JSON），并派发 window 事件 "pj:consent"。
export const CONSENT_KEY = 'pj-consent';
export const CONSENT_EVENT = 'pj:consent';

export function hasChatConsent(): boolean {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (!v) return false;
    if (v === 'granted' || v === 'all') return true;
    const j = JSON.parse(v);
    return j === true || j?.chat === true || j?.all === true || j?.functional === true;
  } catch { return false; }
}

export function onConsentChange(cb: () => void) {
  const h = () => cb();
  window.addEventListener(CONSENT_EVENT, h);
  window.addEventListener('storage', h);
  return () => { window.removeEventListener(CONSENT_EVENT, h); window.removeEventListener('storage', h); };
}

/** 是否同意统计类 Cookie/上报（web-vitals RUM）。只认显式 analytics 或 all。 */
export function hasAnalyticsConsent(): boolean {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (!v) return false;
    if (v === 'all') return true;
    const j = JSON.parse(v);
    return j?.analytics === true || j?.all === true;
  } catch { return false; }
}
