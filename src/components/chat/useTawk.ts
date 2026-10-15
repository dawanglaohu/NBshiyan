'use client';
import { useCallback, useEffect, useState } from 'react';
import { hasChatConsent, onConsentChange } from '@/lib/client/consent';
import { isAdminPath } from '@/lib/chat/adminPath';

type TawkApi = {
  onLoad?: () => void;
  onChatMinimized?: () => void;
  hideWidget?: () => void;
  showWidget?: () => void;
  maximize?: () => void;
  setAttributes?: (a: Record<string, string>, cb?: (e?: unknown) => void) => void;
  customStyle?: Record<string, unknown>;
};
declare global { interface Window { Tawk_API?: TawkApi; Tawk_LoadStart?: Date } }

const PROPERTY = process.env.NEXT_PUBLIC_TAWK_PROPERTY_ID;
const WIDGET = process.env.NEXT_PUBLIC_TAWK_WIDGET_ID;
const WIDGET_RU = process.env.NEXT_PUBLIC_TAWK_WIDGET_ID_RU;
const ID_RE = /^[A-Za-z0-9]{1,40}$/;

export const tawkConfigured = Boolean(PROPERTY && WIDGET && ID_RE.test(PROPERTY) && ID_RE.test(WIDGET));

/**
 * Tawk.to 客服：不进首屏。满足“已同意 Cookie”并且“用户有过交互或页面空闲”后才加载脚本。
 * 默认启动器隐藏，由右下角悬浮按钮组打开。
 */
export function useTawk(locale: string) {
  const [consent, setConsent] = useState(false);
  const [armed, setArmed] = useState(false);
  const [ready, setReady] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);

  useEffect(() => {
    if (!tawkConfigured) return;
    // 管理后台（含 /en/admin、/admin/*）明确拒绝加载 Tawk，即使已同意聊天
    const allowed = () => !isAdminPath(window.location.pathname) && hasChatConsent();
    setConsent(allowed());
    return onConsentChange(() => setConsent(allowed()));
  }, []);

  useEffect(() => {
    if (!tawkConfigured || armed) return;
    const arm = () => setArmed(true);
    const evts = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    evts.forEach((e) => window.addEventListener(e, arm, { once: true, passive: true }));
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const timer = window.setTimeout(() => (ric ? ric(arm, { timeout: 3000 }) : arm()), 6000);
    return () => { evts.forEach((e) => window.removeEventListener(e, arm)); window.clearTimeout(timer); };
  }, [armed]);

  useEffect(() => {
    if (!tawkConfigured || !consent || !armed || isAdminPath(window.location.pathname) || document.getElementById('tawk-js')) return;
    const widget = locale === 'ru' && WIDGET_RU && ID_RE.test(WIDGET_RU) ? WIDGET_RU : WIDGET;
    const api: TawkApi = (window.Tawk_API = window.Tawk_API || {});
    window.Tawk_LoadStart = new Date();
    api.onLoad = () => {
      api.hideWidget?.();
      api.setAttributes?.({ language: locale }, () => {});
      setReady(true);
    };
    // 访客收起聊天窗后，再次隐藏默认启动器
    api.onChatMinimized = () => api.hideWidget?.();
    const s = document.createElement('script');
    s.id = 'tawk-js';
    s.async = true;
    s.src = `https://embed.tawk.to/${PROPERTY}/${widget}`;
    s.charset = 'UTF-8';
    s.setAttribute('crossorigin', '*');
    document.body.appendChild(s);
  }, [consent, armed, locale]);

  const open = useCallback(() => {
    const api = window.Tawk_API;
    if (ready && api?.maximize) { api.showWidget?.(); api.maximize(); return true; }
    setArmed(true); setPendingOpen(true);
    return false;
  }, [ready]);

  useEffect(() => {
    if (ready && pendingOpen) { window.Tawk_API?.showWidget?.(); window.Tawk_API?.maximize?.(); setPendingOpen(false); }
  }, [ready, pendingOpen]);

  // 只有配置了 ID 且已同意 Cookie 时，悬浮按钮才改为打开聊天
  return { enabled: tawkConfigured && consent, ready, open };
}
