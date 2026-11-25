'use client';

import '@/app/[locale]/contact/contact-chat.css';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useQuote } from '@/components/quote/QuoteProvider';
import { usePathname } from '@/i18n/navigation';
import type { ClientLocale } from '@/lib/client/api-errors';
import { resolveChatProductSlug, sanitizeChatSourcePath } from '@/lib/client/chat';
import ChatContainer, { type PersistedChatThreadState } from './ChatContainer';

export default function ContactChatEntry() {
  const t = useTranslations('Chat');
  const locale = (useLocale() === 'ru' ? 'ru' : 'en') as ClientLocale;
  const pathname = usePathname();
  const quote = useQuote();
  const panelId = useId();
  const entryButtonRef = useRef<HTMLButtonElement | null>(null);

  const [open, setOpen] = useState(false);
  const [productSlug, setProductSlug] = useState<string | undefined>(undefined);
  const [persistedThread, setPersistedThread] = useState<PersistedChatThreadState | null>(null);

  useEffect(() => {
    const slugs = quote.items.map((item) => item.slug);
    setProductSlug(resolveChatProductSlug(window.location.search, slugs));
  }, [quote.items]);

  const sourcePath = sanitizeChatSourcePath(locale, pathname);

  return (
    <div className="pj-chat-entry-wrap">
      <Button
        ref={entryButtonRef}
        type="button"
        variant="secondary"
        context="public"
        id="contact-human-chat"
        data-testid="contact-human-chat"
        className="pj-chat-entry-button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {t('entryButton')}
      </Button>

      {open && (
        <ChatContainer
          panelId={panelId}
          locale={locale}
          productSlug={productSlug}
          sourcePath={sourcePath}
          persistedThread={persistedThread}
          onThreadChange={setPersistedThread}
          onClose={() => setOpen(false)}
          entryButtonRef={entryButtonRef}
        />
      )}
    </div>
  );
}
