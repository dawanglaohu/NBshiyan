'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { INQUIRY_EMAIL_EVENT } from '@/lib/inquiry/events';

/**
 * 联系页在 intro 下的说明和邮箱跳转。
 * 聊天开关默认关闭，只切换自身状态和旁边的状态句。
 * 不写 pj-consent，不挂聊天脚本；询盘和邮箱不放进开关条件。
 */

export default function HumanContactNotice() {
  const t = useTranslations('Contact');
  const statusId = useId();
  const [chatEnabled, setChatEnabled] = useState(false);
  return (
    <div id="human-contact-notice" className="contact-human">
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
      <br />
      <button
        id="contact-chat-switch"
        type="button"
        role="switch"
        className="pj-button"
        data-variant={chatEnabled ? 'primary' : 'secondary'}
        data-context="public"
        aria-checked={chatEnabled}
        aria-describedby={statusId}
        onClick={() => setChatEnabled((value) => !value)}
      >
        {t('chatSwitch')}
      </button>{' '}
      <span id={statusId}>{chatEnabled ? t('chatOn') : t('chatOff')}</span>
    </div>
  );
}
