// Cookie 同意状态（与前端约定）：localStorage `pj-consent` + window 事件 `pj:consent`
// v2（#185）：{ v:2, analytics, chat, ts }。v1、缺 ts、超过 12 个月都当作“未选择”，重新询问。ts 只用于判断过期。
export const CONSENT_KEY = 'pj-consent';
export const CONSENT_EVENT = 'pj:consent';
export const CONSENT_OPEN_EVENT = 'pj:consent-open';
export const CONSENT_VERSION = 2;
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export type Consent = { v: 2; analytics: boolean; chat: boolean; ts: number };

export function parseConsent(raw: string | null, now = Date.now()): Consent | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || j.v !== CONSENT_VERSION) return null;
    const ts = typeof j.ts === 'number' && Number.isFinite(j.ts) ? j.ts : 0;
    if (ts <= 0 || ts > now + 60_000 || now - ts > CONSENT_MAX_AGE_MS) return null;
    return { v: 2, analytics: j.analytics === true, chat: j.chat === true, ts };
  } catch {
    return null;
  }
}

export function getConsent(): Consent | null {
  if (typeof window === 'undefined') return null;
  try { return parseConsent(window.localStorage.getItem(CONSENT_KEY)); } catch { return null; }
}

export function setConsent(choice: { analytics: boolean; chat: boolean }): Consent {
  const value: Consent = { v: 2, analytics: choice.analytics === true, chat: choice.chat === true, ts: Date.now() };
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
  const onStorage = (e: StorageEvent) => { if (e.key === CONSENT_KEY || e.key === null) cb(getConsent()); };
  window.addEventListener(CONSENT_EVENT, onEvt);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onEvt);
    window.removeEventListener('storage', onStorage);
  };
}

/** 打开 Cookie 设置面板（页脚链接等调用）；opener 用于关闭后归还焦点 */
export function openConsentSettings(opener?: HTMLElement | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CONSENT_OPEN_EVENT, { detail: { opener: opener ?? (document.activeElement as HTMLElement | null) } }));
}

const TAWK_KEY = /^(twk_|tawk|__tawk|TawkConnectionTime)/i;

/** 清掉浏览器里残留的第三方聊天脚本、全局对象和存储。不决定第一方咨询是否可用，也不读取分析标识。 */
export function clearTawkData() {
  document.getElementById('tawk-js')?.remove();
  document.querySelectorAll('script[src*="tawk.to"], iframe[src*="tawk.to"]').forEach((el) => el.remove());
  const w = window as unknown as Record<string, unknown>;
  for (const k of Object.keys(w)) if (/^(Tawk_|\$_Tawk)/.test(k)) { try { delete w[k]; } catch { w[k] = undefined; } }
  for (const store of [window.localStorage, window.sessionStorage]) {
    try { for (const k of Object.keys(store)) if (TAWK_KEY.test(k)) store.removeItem(k); } catch { /* ignore */ }
  }
  const host = location.hostname;
  const domains = ['', host, `.${host}`, `.${host.split('.').slice(-2).join('.')}`];
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim();
    if (!name || !TAWK_KEY.test(name)) continue;
    for (const d of domains) document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ''}`;
  }
}
