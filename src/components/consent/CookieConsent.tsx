'use client';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { CONSENT_OPEN_EVENT, clearTawkData, getConsent, onConsent, setConsent, type Consent } from '@/lib/consent';

const TOAST_KEY = 'pj-consent-toast';
type Toast = 'saved' | 'withdrawn';

/**
 * Cookie 同意条 + 设置面板（#185，design/cookie-settings.html）。服务端不渲染，挂载后再判断，避免水合闪烁。
 * 撤回：analytics → WebVitals 监听到后立即停止上报；chat → 清掉 Tawk.to 脚本/存储/cookie 并刷新本页，其他标签页通过 storage 事件同样刷新。
 */
export default function CookieConsent() {
  const t = useTranslations('Consent');
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ analytics: false, chat: false });
  const [toast, setToast] = useState<Toast | null>(null);
  const prev = useRef<Consent | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prev.current = getConsent();
    setShow(prev.current === null);
    try { const f = sessionStorage.getItem(TOAST_KEY) as Toast | null; if (f) { sessionStorage.removeItem(TOAST_KEY); setToast(f); } } catch { /* ignore */ }
    return onConsent((c) => {
      const before = prev.current; prev.current = c;
      setShow(c === null);
      // 撤回聊天同意（本页或其他标签页）：清理 Tawk.to 并刷新，保证当前页不再有请求
      if (before?.chat && !c?.chat) { clearTawkData(); window.location.reload(); }
    });
  }, []);

  const openSettings = useCallback((from?: HTMLElement | null) => {
    opener.current = from ?? null;
    const c = getConsent();
    // 首访（还没选过）可选项全部默认关；从页脚重开时按已保存的选择预填
    setDraft({ analytics: c?.analytics === true, chat: c?.chat === true });
    setOpen(true);
  }, []);

  useEffect(() => {
    const h = (e: Event) => openSettings((e as CustomEvent<{ opener?: HTMLElement | null }>).detail?.opener);
    window.addEventListener(CONSENT_OPEN_EVENT, h);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, h);
  }, [openSettings]);

  useEffect(() => { if (!toast) return; const id = window.setTimeout(() => setToast(null), 5000); return () => window.clearTimeout(id); }, [toast]);

  // 确认 toast 显示时把（高度 + 12px）写进 --pj-consent-h，其他底部提示（如询价清单提示）据此上移；隐藏/卸载时归 0
  const toastRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = toastRef.current; const root = document.documentElement;
    if (!toast || !el) { root.style.setProperty('--pj-consent-h', '0px'); return; }
    const sync = () => root.style.setProperty('--pj-consent-h', `${Math.ceil(el.getBoundingClientRect().height) + 12}px`);
    sync();
    const ro = new ResizeObserver(sync); ro.observe(el);
    return () => { ro.disconnect(); root.style.setProperty('--pj-consent-h', '0px'); };
  }, [toast]);

  // 手机端同意条占满底部：把实际高度写进 CSS 变量，悬浮按钮组据此上移到同意条上方 12px，关闭后复原
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current; const root = document.documentElement;
    if (!show || !el) return;
    const sync = () => root.style.setProperty('--consent-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    sync(); root.classList.add('has-consent');
    const ro = new ResizeObserver(sync); ro.observe(el);
    return () => { ro.disconnect(); root.classList.remove('has-consent'); root.style.removeProperty('--consent-h'); };
  }, [show]);

  const save = (choice: { analytics: boolean; chat: boolean }, fromDialog: boolean) => {
    const before = getConsent();
    const chatWithdrawn = Boolean(before?.chat && !choice.chat);
    const withdrawn = chatWithdrawn || Boolean(before?.analytics && !choice.analytics && !choice.chat);
    const kind: Toast = withdrawn ? 'withdrawn' : 'saved';
    setOpen(false);
    // 撤回聊天：onConsent 会清理 Tawk.to 并刷新页面，提示放到 sessionStorage，刷新后再显示
    if (chatWithdrawn) { try { sessionStorage.setItem(TOAST_KEY, kind); } catch { /* ignore */ } }
    setConsent(choice);
    if (chatWithdrawn) return;
    if (fromDialog || withdrawn) setToast(kind);
    restoreFocus();
  };

  const restoreFocus = () => {
    window.setTimeout(() => {
      // 优先归还给打开它的按钮；条上的按钮已被重新渲染时找条上的“设置”，条已消失则回到页脚链接
      const el = opener.current && document.contains(opener.current) && opener.current.offsetParent !== null ? opener.current
        : document.querySelector<HTMLElement>('.consent .consent-set') ?? document.getElementById('cookie-settings-link');
      el?.focus();
    }, 50);
  };
  const close = () => { setOpen(false); restoreFocus(); };

  return (
    <>
      {show && !open && (
        <div ref={ref} className="consent" role="region" aria-label={t('label')}>
          <p>{t('text')} <Link href="/privacy">{t('policy')}</Link></p>
          <div className="consent-actions">
            <button type="button" className="consent-main" onClick={() => save({ analytics: false, chat: false }, false)}>{t('reject')}</button>
            <button type="button" className="consent-main" onClick={() => save({ analytics: true, chat: true }, false)}>{t('accept')}</button>
            <button type="button" className="consent-set" onClick={(e) => openSettings(e.currentTarget)}>{t('settings')}</button>
          </div>
        </div>
      )}
      {open && <SettingsDialog draft={draft} setDraft={setDraft} onClose={close} onSave={(c) => save(c, true)} />}
      {toast && (
        <div ref={toastRef} className="consent-toast" role="status">
          <span>{t(toast === 'saved' ? 'saved' : 'withdrawn')}</span>
          <button type="button" onClick={(e) => { setToast(null); openSettings(e.currentTarget); }}>{t('change')}</button>
        </div>
      )}
    </>
  );
}

function SettingsDialog({ draft, setDraft, onClose, onSave }: {
  draft: { analytics: boolean; chat: boolean };
  setDraft: (d: { analytics: boolean; chat: boolean }) => void;
  onClose: () => void;
  onSave: (c: { analytics: boolean; chat: boolean }) => void;
}) {
  const t = useTranslations('Consent');
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.createElement('div'); el.className = 'consent-layer';
    document.body.appendChild(el); setHost(el);
    // 背景不可交互、不可被读屏读到
    const others = Array.from(document.body.children).filter((c) => c !== el) as HTMLElement[];
    const wasInert = others.map((o) => o.hasAttribute('inert'));
    others.forEach((o) => o.setAttribute('inert', ''));
    return () => { others.forEach((o, i) => { if (!wasInert[i]) o.removeAttribute('inert'); }); el.remove(); };
  }, []);

  useEffect(() => { if (host) first.current?.focus(); }, [host]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab' || !box.current) return;
    const f = Array.from(box.current.querySelectorAll<HTMLElement>('button:not([disabled]):not([aria-disabled="true"]), a[href]'));
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };

  if (!host) return null;
  const sw = (key: 'analytics' | 'chat', label: string, ref?: React.Ref<HTMLButtonElement>) => (
    <button ref={ref} type="button" role="switch" className="cs-switch" aria-checked={draft[key]} aria-label={label} aria-describedby={`${id}-${key}`}
      onClick={() => setDraft({ ...draft, [key]: !draft[key] })}><i aria-hidden="true" /></button>
  );
  return createPortal(
    <div className="cs-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="cs-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} onKeyDown={onKey}>
        <div className="cs-head">
          <h2 id={`${id}-t`}>{t('title')}</h2>
          <button type="button" className="cs-x" aria-label={t('close')} onClick={onClose}>✕</button>
        </div>
        <div className="cs-body">
          <p id={`${id}-d`} className="cs-lead">{t('lead')} <Link href="/privacy">{t('policy')}</Link></p>
          <div className="cs-cat">
            <div><b>{t('necessary')}</b> <em>{t('alwaysOn')}</em><span id={`${id}-nec`}>{t('necessaryDesc')}</span></div>
            <button type="button" role="switch" className="cs-switch" aria-checked="true" aria-disabled="true" aria-label={t('necessary')} aria-describedby={`${id}-nec`} tabIndex={-1}><i aria-hidden="true" /></button>
          </div>
          <div className="cs-cat">
            <div><b>{t('analytics')}</b><span id={`${id}-analytics`}>{t('analyticsDesc')}</span></div>
            {sw('analytics', t('analytics'), first)}
          </div>
          <div className="cs-cat">
            <div><b>{t('chat')}</b><span id={`${id}-chat`}>{t('chatDesc')}</span></div>
            {sw('chat', t('chat'))}
          </div>
        </div>
        <div className="cs-foot">
          <button type="button" className="consent-main" onClick={() => onSave({ analytics: false, chat: false })}>{t('reject')}</button>
          <button type="button" className="consent-main" onClick={() => onSave({ analytics: true, chat: true })}>{t('accept')}</button>
          <button type="button" className="consent-set" onClick={() => onSave(draft)}>{t('save')}</button>
        </div>
      </div>
    </div>,
    host
  );
}
