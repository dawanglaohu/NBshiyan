'use client';

import type { FormEvent, RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';

type ComposerProps = {
  showEmailField: boolean;
  email: string;
  bodyText: string;
  emailError?: string;
  bodyError?: string;
  submitting: boolean;
  awaitingReceipt: boolean;
  disabled: boolean;
  disabledReason?: string;
  emailInputRef: RefObject<HTMLInputElement | null>;
  bodyInputRef: RefObject<HTMLTextAreaElement | null>;
  onEmailChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function Composer({
  showEmailField,
  email,
  bodyText,
  emailError,
  bodyError,
  submitting,
  awaitingReceipt,
  disabled,
  disabledReason,
  emailInputRef,
  bodyInputRef,
  onEmailChange,
  onBodyChange,
  onSubmit,
}: ComposerProps) {
  const t = useTranslations('Chat');

  return (
    <form className="pj-chat-composer" onSubmit={onSubmit} noValidate data-testid="chat-composer">
      {showEmailField && (
        <Input
          ref={emailInputRef}
          id="chat-email"
          name="email"
          type="email"
          autoComplete="email"
          context="public"
          label={t('emailLabel')}
          description={t('emailDescription')}
          error={emailError}
          readOnly={awaitingReceipt}
          disabled={disabled || submitting}
          disabledReason={disabled ? disabledReason : undefined}
          placeholder={t('emailPlaceholder')}
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          data-testid="chat-email"
        />
      )}

      <Textarea
        ref={bodyInputRef}
        id="chat-message"
        name="message"
        rows={3}
        context="public"
        label={t('messageLabel')}
        error={bodyError}
        readOnly={awaitingReceipt}
        disabled={disabled || submitting}
        disabledReason={disabled ? disabledReason : undefined}
        placeholder={t('messagePlaceholder')}
        value={bodyText}
        onChange={(event) => onBodyChange(event.target.value)}
        data-testid="chat-message"
      />

      <div className="pj-chat-composer-actions">
        <Button
          type="submit"
          variant="primary"
          context="public"
          id="chat-send"
          data-testid="chat-send"
          busy={submitting}
          busyLabel={t('sending')}
          disabled={disabled || submitting}
          disabledReason={disabled ? disabledReason : undefined}
        >
          {t('sendMessage')}
        </Button>
      </div>
    </form>
  );
}
