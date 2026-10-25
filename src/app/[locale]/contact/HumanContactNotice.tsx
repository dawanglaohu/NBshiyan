'use client';

import { useTranslations } from 'next-intl';

/** 联系页在 intro 下的一行说明。点击后由询价向导切到邮箱那一步。 */
export const INQUIRY_EMAIL_EVENT = 'pj:inquiry-email';

export default function HumanContactNotice() {
  const t = useTranslations('Contact');
  return (
    <p id="human-contact-notice" className="contact-human">
      {t('humanBody')}{' '}
      <a
        id="inquiry-email-entry"
        href="#iq-email"
        onClick={(e) => {
          e.preventDefault();
          window.dispatchEvent(new Event(INQUIRY_EMAIL_EVENT));
        }}
      >
        {t('emailEntry')}
      </a>
    </p>
  );
}
