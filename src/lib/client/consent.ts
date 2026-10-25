'use client';
// 兼容旧接口：内部改用 src/lib/consent.ts（Cookie 同意条写入的 pj-consent）
import { getConsent, onConsent } from '@/lib/consent';
export { CONSENT_KEY, CONSENT_EVENT } from '@/lib/consent';

/**
 * Legacy pj-consent.chat bit. Older browsers still store it.
 * It is not the independent human-chat switch and must not load a third-party script.
 */
export function hasChatConsent(): boolean {
  return getConsent()?.chat === true;
}

export function onConsentChange(cb: () => void) {
  return onConsent(() => cb());
}

/** 是否同意统计类 Cookie/上报（web-vitals RUM）。只认显式 analytics 或 all。 */
export function hasAnalyticsConsent(): boolean {
  return getConsent()?.analytics === true;
}
