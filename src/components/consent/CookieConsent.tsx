'use client';
import { useEffect, useState } from 'react';
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

  if (!show) return null;
  const choose = (all: boolean) => { setConsent({ analytics: all, chat: all }); setShow(false); };

  return (
    <div className="consent" role="region" aria-label={t('label')}>
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
