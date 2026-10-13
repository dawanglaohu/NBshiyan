// Cookie 同意状态（与前端约定）：localStorage `pj-consent` + window 事件 `pj:consent`
export const CONSENT_KEY = 'pj-consent';
export const CONSENT_EVENT = 'pj:consent';

export type Consent = { v: 1; analytics: boolean; chat: boolean; ts: number };

export function getConsent(): Consent | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.v === 1) {
      return { v: 1, analytics: j.analytics === true, chat: j.chat === true, ts: Number(j.ts) || 0 };
    }
    return null;
  } catch {
    return null;
  }
}

export function setConsent(choice: { analytics: boolean; chat: boolean }): Consent {
  const value: Consent = { v: 1, analytics: choice.analytics, chat: choice.chat, ts: Date.now() };
  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(value));
  } catch {
    /* 隐私模式等写入失败时，仅本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: value }));
  return value;
}

/** 订阅同意变化（本页事件 + 其他标签页的 storage 事件），返回取消订阅函数 */
export function onConsent(cb: (c: Consent | null) => void): () => void {
  const onEvt = (e: Event) => cb((e as CustomEvent<Consent>).detail ?? getConsent());
  const onStorage = (e: StorageEvent) => { if (e.key === CONSENT_KEY) cb(getConsent()); };
  window.addEventListener(CONSENT_EVENT, onEvt);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onEvt);
    window.removeEventListener('storage', onStorage);
  };
}
