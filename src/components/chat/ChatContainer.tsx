'use client';

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Status } from '@/components/ui/Status';
import type { ClientApiFailure, ClientLocale } from '@/lib/client/api-errors';
import {
  appendChatMessage,
  chatStartTracker,
  classifyChatFailureTerminal,
  createChatConversation,
  fetchChatConversationUpdates,
  isConversationTerminalStatus,
  mergeChatAuthors,
  mergeChatMessages,
  openChatSession,
  randomChatUuid,
  validateVisitorComposer,
  type ChatFieldErrorCode,
  type ChatTerminalReason,
} from '@/lib/client/chat';
import type {
  ChatAuthorReferenceDTO,
  ChatConversationDTO,
  ChatMessageDTO,
} from '@/lib/contracts/chat';
import { INQUIRY_EMAIL_EVENT } from '@/lib/inquiry/events';
import Composer from './Composer';
import MessageList, { type ChatReceiptBanner } from './MessageList';

export type PersistedChatThreadState = {
  conversation: ChatConversationDTO;
  messages: ChatMessageDTO[];
  authors: ChatAuthorReferenceDTO[];
  lastSeq: number;
  receipt: ChatReceiptBanner | null;
  receivedAtEntries: Array<[string, string]>;
};

type ChatContainerProps = {
  panelId: string;
  locale: ClientLocale;
  productSlug?: string;
  sourcePath?: string;
  persistedThread: PersistedChatThreadState | null;
  onThreadChange: (next: PersistedChatThreadState | null) => void;
  onClose: () => void;
  entryButtonRef: RefObject<HTMLButtonElement | null>;
};

type SessionPhase = 'checking' | 'ready' | 'unavailable';

export default function ChatContainer({
  panelId,
  locale,
  productSlug,
  sourcePath,
  persistedThread,
  onThreadChange,
  onClose,
  entryButtonRef,
}: ChatContainerProps) {
  const t = useTranslations('Chat');
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const bodyInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);

  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('checking');
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [terminalReason, setTerminalReason] = useState<ChatTerminalReason | null>(null);

  const [conversation, setConversation] = useState<ChatConversationDTO | null>(
    persistedThread?.conversation ?? null,
  );
  const [messages, setMessages] = useState<ChatMessageDTO[]>(persistedThread?.messages ?? []);
  const [authors, setAuthors] = useState<ChatAuthorReferenceDTO[]>(persistedThread?.authors ?? []);
  const [lastSeq, setLastSeq] = useState<number>(persistedThread?.lastSeq ?? 0);
  const [receipt, setReceipt] = useState<ChatReceiptBanner | null>(persistedThread?.receipt ?? null);
  const [receivedAtByMessageId, setReceivedAtByMessageId] = useState<Map<string, string>>(
    () => new Map(persistedThread?.receivedAtEntries ?? []),
  );

  const [email, setEmail] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ bodyText?: string; email?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [startingNew, setStartingNew] = useState(false);

  const [clientConversationId, setClientConversationId] = useState(() => randomChatUuid());
  const [clientMessageId, setClientMessageId] = useState(() => randomChatUuid());

  const [vvVars, setVvVars] = useState<{ height?: string; offsetBottom?: string }>({});

  const syncThreadUp = useCallback(
    (
      nextConversation: ChatConversationDTO | null,
      nextMessages: ChatMessageDTO[],
      nextAuthors: ChatAuthorReferenceDTO[],
      nextLastSeq: number,
      nextReceipt: ChatReceiptBanner | null,
      nextMap: Map<string, string>,
      ended: ChatTerminalReason | null,
    ) => {
      if (!nextConversation || ended !== null) {
        onThreadChange(null);
        return;
      }
      onThreadChange({
        conversation: nextConversation,
        messages: nextMessages,
        authors: nextAuthors,
        lastSeq: nextLastSeq,
        receipt: nextReceipt,
        receivedAtEntries: Array.from(nextMap.entries()),
      });
    },
    [onThreadChange],
  );

  const translateFieldCode = useCallback(
    (code: ChatFieldErrorCode): string => {
      switch (code) {
        case 'body_required':
          return t('errorBodyRequired');
        case 'body_too_long':
          return t('errorBodyTooLong');
        case 'body_html_disallowed':
          return t('errorBodyHtml');
        case 'body_invalid':
          return t('errorBodyInvalid');
        case 'email_too_long':
          return t('errorEmailTooLong');
        case 'email_invalid':
          return t('errorEmailInvalid');
      }
    },
    [t],
  );

  const runSessionCheck = useCallback(
    async (options?: { resetTerminal?: boolean }) => {
      sessionAbortRef.current?.abort();
      const controller = new AbortController();
      sessionAbortRef.current = controller;

      setSessionPhase('checking');
      setSessionError(null);
      if (options?.resetTerminal) {
        setTerminalReason(null);
      }

      const result = await openChatSession(locale, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;

      if (!result.ok) {
        const terminal = classifyChatFailureTerminal(result);
        if (terminal) {
          setTerminalReason(terminal);
          setSessionPhase('unavailable');
          onThreadChange(null);
          return;
        }
        setSessionPhase('unavailable');
        setSessionError(result.text || t('sessionUnavailable'));
        return;
      }

      if (!result.data.available) {
        setSessionPhase('unavailable');
        setSessionError(t('sessionUnavailable'));
        return;
      }

      setSessionPhase('ready');
      setSessionError(null);
    },
    [locale, onThreadChange, t],
  );

  useEffect(() => {
    mountedRef.current = true;
    panelRef.current?.focus();
    void runSessionCheck();

    return () => {
      mountedRef.current = false;
      sessionAbortRef.current?.abort();
      sendAbortRef.current?.abort();
      syncAbortRef.current?.abort();
    };
  }, [runSessionCheck]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
      entryButtonRef.current?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [entryButtonRef, onClose]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const updateViewport = () => {
      const height = Math.max(260, Math.round(vv.height));
      const offsetBottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      setVvVars({
        height: `${height}px`,
        offsetBottom: `${offsetBottom}px`,
      });
    };
    updateViewport();
    vv.addEventListener('resize', updateViewport);
    vv.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    return () => {
      vv.removeEventListener('resize', updateViewport);
      vv.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, []);

  const handleCloseClick = () => {
    onClose();
    entryButtonRef.current?.focus();
  };

  const handleFallbackEmail = () => {
    onClose();
    window.dispatchEvent(new Event(INQUIRY_EMAIL_EVENT));
  };

  const handleStartNewConversation = async () => {
    if (startingNew) return;
    sendAbortRef.current?.abort();
    syncAbortRef.current?.abort();

    setStartingNew(true);
    setTerminalReason(null);
    setConversation(null);
    setMessages([]);
    setAuthors([]);
    setLastSeq(0);
    setReceipt(null);
    setReceivedAtByMessageId(new Map());
    setEmail('');
    setBodyText('');
    setFieldErrors({});
    setSubmitError(null);
    setRefreshError(null);
    setClientConversationId(randomChatUuid());
    setClientMessageId(randomChatUuid());
    onThreadChange(null);

    await runSessionCheck({ resetTerminal: true });
    if (mountedRef.current) {
      setStartingNew(false);
    }
  };

  const applyServerFailure = (failure: ClientApiFailure) => {
    const terminal = classifyChatFailureTerminal(failure);
    if (terminal) {
      setTerminalReason(terminal);
      setSubmitError(null);
      onThreadChange(null);
      return;
    }

    const mappedFieldErrors: { bodyText?: string; email?: string } = {};
    if (failure.fieldErrors?.email) {
      mappedFieldErrors.email = failure.fieldErrors.email;
    }
    if (failure.fieldErrors?.bodyText) {
      mappedFieldErrors.bodyText = failure.fieldErrors.bodyText;
    }
    if (mappedFieldErrors.email || mappedFieldErrors.bodyText) {
      setFieldErrors(mappedFieldErrors);
      setSubmitError(null);
      if (mappedFieldErrors.email) emailInputRef.current?.focus();
      else if (mappedFieldErrors.bodyText) bodyInputRef.current?.focus();
      return;
    }

    setSubmitError(t('sendFailedNotice'));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || sessionPhase !== 'ready' || terminalReason !== null) return;

    const includeEmail = conversation === null;
    const validation = validateVisitorComposer({
      bodyText,
      email,
      includeEmail,
    });

    if (!validation.valid) {
      const nextErrors: { bodyText?: string; email?: string } = {};
      if (validation.errors.email) {
        nextErrors.email = translateFieldCode(validation.errors.email);
      }
      if (validation.errors.bodyText) {
        nextErrors.bodyText = translateFieldCode(validation.errors.bodyText);
      }
      setFieldErrors(nextErrors);
      setSubmitError(null);
      if (nextErrors.email) {
        emailInputRef.current?.focus();
      } else if (nextErrors.bodyText) {
        bodyInputRef.current?.focus();
      }
      return;
    }

    setFieldErrors({});
    setSubmitError(null);
    setRefreshError(null);
    setSubmitting(true);

    sendAbortRef.current?.abort();
    const controller = new AbortController();
    sendAbortRef.current = controller;

    if (conversation === null) {
      const analyticsContext = chatStartTracker.captureAttemptContext();
      const attemptConversationId = clientConversationId;
      const res = await createChatConversation(
        {
          clientConversationId: attemptConversationId,
          clientMessageId,
          locale,
          bodyText: validation.bodyText,
          email: validation.email,
          productSlug,
          sourcePath,
        },
        { signal: controller.signal },
      );

      if (!mountedRef.current || controller.signal.aborted) return;
      setSubmitting(false);

      if (!res.ok) {
        applyServerFailure(res);
        return;
      }

      chatStartTracker.emitOnCreateSuccess({
        context: analyticsContext,
        clientConversationId: attemptConversationId,
        productSlug,
      });

      const nowIso = res.data.receivedAt;
      const createdConversation: ChatConversationDTO = {
        id: res.data.conversationId,
        locale,
        productSlug: productSlug ?? null,
        sourcePath: sourcePath ?? null,
        status: 'OPEN',
        version: 1,
        createdAt: res.data.message.createdAt,
        updatedAt: res.data.message.createdAt,
        lastActivityAt: res.data.message.createdAt,
        retainUntil: new Date(Date.parse(nowIso) + 90 * 24 * 60 * 60 * 1000).toISOString(),
        anonymizedAt: null,
      };

      const nextMessages = mergeChatMessages(messages, [res.data.message]);
      const nextMap = new Map(receivedAtByMessageId);
      nextMap.set(res.data.message.id, res.data.receivedAt);
      const nextReceipt: ChatReceiptBanner = {
        conversationId: res.data.conversationId,
        messageId: res.data.message.id,
        seq: res.data.message.seq,
        receivedAt: res.data.receivedAt,
      };
      const nextSeq = Math.max(lastSeq, res.data.message.seq);

      setConversation(createdConversation);
      setMessages(nextMessages);
      setLastSeq(nextSeq);
      setReceivedAtByMessageId(nextMap);
      setReceipt(nextReceipt);
      setBodyText('');
      setEmail('');
      setClientMessageId(randomChatUuid());
      syncThreadUp(createdConversation, nextMessages, authors, nextSeq, nextReceipt, nextMap, null);
      return;
    }

    const res = await appendChatMessage(
      {
        conversationId: conversation.id,
        clientMessageId,
        locale,
        bodyText: validation.bodyText,
      },
      { signal: controller.signal },
    );

    if (!mountedRef.current || controller.signal.aborted) return;
    setSubmitting(false);

    if (!res.ok) {
      applyServerFailure(res);
      return;
    }

    const nextMessages = mergeChatMessages(messages, [res.data.message]);
    const nextMap = new Map(receivedAtByMessageId);
    nextMap.set(res.data.message.id, res.data.receivedAt);
    const nextReceipt: ChatReceiptBanner = {
      conversationId: conversation.id,
      messageId: res.data.message.id,
      seq: res.data.message.seq,
      receivedAt: res.data.receivedAt,
    };
    const nextSeq = Math.max(lastSeq, res.data.message.seq);

    setMessages(nextMessages);
    setLastSeq(nextSeq);
    setReceivedAtByMessageId(nextMap);
    setReceipt(nextReceipt);
    setBodyText('');
    setClientMessageId(randomChatUuid());
    syncThreadUp(conversation, nextMessages, authors, nextSeq, nextReceipt, nextMap, null);
  };

  const handleRefreshMessages = async () => {
    if (!conversation || refreshing) return;
    setRefreshing(true);
    setRefreshError(null);

    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    const res = await fetchChatConversationUpdates(conversation.id, lastSeq, locale, {
      signal: controller.signal,
    });
    if (!mountedRef.current || controller.signal.aborted) return;
    setRefreshing(false);

    if (!res.ok) {
      const terminal = classifyChatFailureTerminal(res);
      if (terminal) {
        setTerminalReason(terminal);
        onThreadChange(null);
      } else {
        setRefreshError(res.text || t('refreshFailed'));
      }
      return;
    }

    const nextConversation = res.data.conversation;
    const nextMessages = mergeChatMessages(messages, res.data.messages);
    const nextAuthors = mergeChatAuthors(authors, res.data.authors);
    const nextSeq = Math.max(lastSeq, res.data.lastSeq);
    const nextMap = new Map(receivedAtByMessageId);
    for (const msg of res.data.messages) {
      if (!nextMap.has(msg.id)) {
        nextMap.set(msg.id, msg.createdAt);
      }
    }

    setConversation(nextConversation);
    setMessages(nextMessages);
    setAuthors(nextAuthors);
    setLastSeq(nextSeq);
    setReceivedAtByMessageId(nextMap);

    if (isConversationTerminalStatus(nextConversation)) {
      const ended: ChatTerminalReason =
        nextConversation.anonymizedAt !== null ? 'anonymized' : 'closed';
      setTerminalReason(ended);
      onThreadChange(null);
    } else {
      syncThreadUp(nextConversation, nextMessages, nextAuthors, nextSeq, receipt, nextMap, null);
    }
  };

  const terminalMessage =
    terminalReason === 'closed' || terminalReason === 'anonymized'
      ? t('endedClosedNotice')
      : terminalReason !== null
        ? t('endedExpiredNotice')
        : null;

  const composerDisabled = sessionPhase !== 'ready' || terminalReason !== null;
  const composerDisabledReason =
    terminalMessage ?? (sessionPhase === 'checking' ? t('checkingSession') : sessionError ?? t('sessionUnavailable'));

  const panelStyle: CSSProperties = {
    ...(vvVars.height ? { '--chat-vv-height': vvVars.height } : {}),
    ...(vvVars.offsetBottom ? { '--chat-vv-offset-bottom': vvVars.offsetBottom } : {}),
  } as CSSProperties;

  return (
    <section
      ref={panelRef}
      id={panelId}
      className="pj-chat-panel"
      style={panelStyle}
      tabIndex={-1}
      role="region"
      aria-labelledby={titleId}
      data-testid="chat-panel"
      data-conversation-id={conversation?.id ?? ''}
      data-status={terminalReason ?? sessionPhase}
    >
      <header className="pj-chat-header">
        <div className="pj-chat-header-title-group">
          <h2 id={titleId} className="pj-chat-title">
            {t('panelTitle')}
          </h2>
          {sessionPhase === 'ready' && terminalReason === null && (
            <span className="pj-chat-badge" data-testid="chat-availability-status">
              {t('offlineMessage')}
            </span>
          )}
        </div>
        <div className="pj-chat-header-actions">
          {conversation && (
            <Button
              type="button"
              variant="secondary"
              context="public"
              id="chat-refresh"
              data-testid="chat-refresh"
              busy={refreshing}
              busyLabel={t('refreshing')}
              onClick={handleRefreshMessages}
            >
              {t('refreshMessages')}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            context="public"
            id="chat-close"
            data-testid="chat-close"
            aria-label={t('closeChatAria')}
            onClick={handleCloseClick}
          >
            {t('closeChat')}
          </Button>
        </div>
      </header>

      <div className="pj-chat-body">
        {sessionPhase === 'checking' && (
          <Status tone="loading" prefix={t('statusPrefix')} data-testid="chat-session-loading">
            {t('checkingSession')}
          </Status>
        )}

        {sessionPhase === 'ready' && terminalReason === null && (
          <p className="pj-chat-note" data-testid="chat-offline-note">
            {t('offlineNote')}
          </p>
        )}

        {sessionPhase === 'unavailable' && terminalReason === null && (
          <div className="pj-chat-recovery" data-testid="chat-session-unavailable">
            <Status tone="warning" urgent prefix={t('unavailablePrefix')}>
              {sessionError || t('sessionUnavailable')}
            </Status>
            <div className="pj-chat-recovery-actions">
              <Button
                type="button"
                variant="secondary"
                context="public"
                data-testid="chat-session-retry"
                onClick={() => void runSessionCheck()}
              >
                {t('retryAction')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                context="public"
                data-testid="chat-fallback-email"
                onClick={handleFallbackEmail}
              >
                {t('useEmailEntry')}
              </Button>
            </div>
          </div>
        )}

        {terminalReason !== null && (
          <div className="pj-chat-recovery" data-testid="chat-terminal-banner">
            <Status tone="warning" urgent prefix={t('endedPrefix')}>
              {terminalMessage}
            </Status>
            <div className="pj-chat-recovery-actions">
              <Button
                type="button"
                variant="primary"
                context="public"
                id="chat-start-new"
                data-testid="chat-start-new"
                busy={startingNew}
                busyLabel={t('startingNew')}
                onClick={() => void handleStartNewConversation()}
              >
                {t('startNewConversation')}
              </Button>
            </div>
          </div>
        )}

        {refreshError && (
          <Status tone="error" urgent prefix={t('errorPrefix')} data-testid="chat-refresh-error">
            {refreshError}
          </Status>
        )}

        {submitError && terminalReason === null && (
          <div className="pj-chat-recovery" data-testid="chat-send-error">
            <Status tone="error" urgent prefix={t('errorPrefix')}>
              {submitError}
            </Status>
            <div className="pj-chat-recovery-actions">
              <Button
                type="button"
                variant="secondary"
                context="public"
                data-testid="chat-fallback-email"
                onClick={handleFallbackEmail}
              >
                {t('useEmailEntry')}
              </Button>
            </div>
          </div>
        )}

        <MessageList
          conversation={conversation}
          messages={messages}
          receipt={receipt}
          receivedAtByMessageId={receivedAtByMessageId}
          loading={sessionPhase === 'checking'}
          locale={locale}
        />
      </div>

      <Composer
        showEmailField={conversation === null}
        email={email}
        bodyText={bodyText}
        emailError={fieldErrors.email}
        bodyError={fieldErrors.bodyText}
        submitting={submitting}
        disabled={composerDisabled}
        disabledReason={composerDisabledReason}
        emailInputRef={emailInputRef}
        bodyInputRef={bodyInputRef}
        onEmailChange={(value) => {
          setEmail(value);
          if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: undefined }));
        }}
        onBodyChange={(value) => {
          setBodyText(value);
          if (fieldErrors.bodyText) setFieldErrors((prev) => ({ ...prev, bodyText: undefined }));
        }}
        onSubmit={handleSubmit}
      />
    </section>
  );
}
