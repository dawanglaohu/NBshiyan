'use client';
import { openConsentSettings } from '@/lib/consent';

/** 页脚常驻“Cookie 设置”入口（#185）：真实 <button>，样式为链接，可点高度 ≥44px */
export default function CookieSettingsLink({ label }: { label: string }) {
  return <button type="button" id="cookie-settings-link" className="linklike" onClick={(e) => openConsentSettings(e.currentTarget)}>{label}</button>;
}
