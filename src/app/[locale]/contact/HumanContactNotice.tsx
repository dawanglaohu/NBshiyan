'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

const flat = {
  boxSizing: 'border-box' as const,
  border: 'var(--pj-border-width) solid var(--pj-border)',
  borderRadius: 'var(--pj-radius)',
  boxShadow: 'var(--pj-shadow)',
  background: 'var(--pj-bg)',
  color: 'var(--pj-fg)',
};

/**
 * Session-only availability for first-party chat. Default off: capacity has not been measured.
 * Turning it on does not load a third-party script, create an analytics id, or buy capacity.
 * The inquiry form beside this notice stays usable in both positions.
 */
export default function HumanContactNotice() {
  const t = useTranslations('Contact');
  const [chatOn, setChatOn] = useState(false);
  return (
    <section id="human-contact-notice" aria-labelledby="human-contact-title" style={{ ...flat, maxWidth: 640, padding: 16, margin: '0 0 24px' }}>
      <h2 id="human-contact-title" style={{ margin: '0 0 8px', fontSize: 'var(--pj-h3-desktop-size)', lineHeight: 'var(--pj-h3-desktop-line)' }}>{t('humanTitle')}</h2>
      <p style={{ margin: '0 0 8px' }}>{t('humanBody')}</p>
      <p style={{ margin: '0 0 16px' }}>{t('capacityLimit')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        <button
          type="button"
          role="switch"
          id="chat-availability"
          aria-checked={chatOn}
          aria-describedby="chat-availability-desc"
          onClick={() => setChatOn((on) => !on)}
          style={{
            ...flat,
            minWidth: 44,
            minHeight: 44,
            padding: '8px 16px',
            font: 'inherit',
            fontWeight: 600,
            cursor: 'pointer',
            color: chatOn ? 'var(--pj-on-accent)' : 'var(--pj-accent)',
            background: chatOn ? 'var(--pj-accent)' : 'var(--pj-bg)',
          }}
        >
          {t('chatSwitch')}
        </button>
        <a
          id="inquiry-email-entry"
          href="#iq-email"
          style={{ ...flat, display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '8px 16px', color: 'var(--pj-accent)', textDecoration: 'none', fontWeight: 600 }}
        >
          {t('emailEntry')}
        </a>
      </div>
      <p id="chat-availability-desc" style={{ margin: '12px 0 0' }}>{chatOn ? t('chatOn') : t('chatOff')}</p>
    </section>
  );
}
