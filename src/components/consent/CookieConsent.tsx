'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { getConsent, onConsent, setConsent } from '@/lib/consent';

/** 左下角 Cookie 同意细条。服务端不渲染，挂载后再判断，避免水合闪烁。 */
export default function CookieConsent() {
  const t = useTranslations('Consent');
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(getConsent() === null);
    return onConsent((c) => setShow(c === null));
  }, []);

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

  if (!show) return null;
  const choose = (all: boolean) => { setConsent({ analytics: all, chat: all }); setShow(false); };

  return (
    <div ref={ref} className="consent" role="region" aria-label={t('label')}>
      <p>
        {t('text')} <Link href="/privacy">{t('policy')}</Link>
      </p>
      <div className="consent-actions">
        <button type="button" onClick={() => choose(false)}>{t('reject')}</button>
        <button type="button" onClick={() => choose(true)}>{t('accept')}</button>
      </div>
    </div>
  );
}
