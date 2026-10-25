'use client';

import { useTranslations } from 'next-intl';
import { INQUIRY_EMAIL_EVENT } from '@/lib/inquiry/events';

/** 联系页在 intro 下的一行说明。点击后由询价向导切到邮箱那一步。 */

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
