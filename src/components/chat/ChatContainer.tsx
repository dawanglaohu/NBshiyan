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
  contiguousMessageSeq,
  createChatConversation,
  fetchChatConversationUpdates,
  isConversationTerminalStatus,
  mergeChatAuthors,
  mergeChatMessages,
  mergeConversationSnapshot,
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
  terminalReason: ChatTerminalReason | null;
};

type ThreadSnapshot = {
  conversation: ChatConversationDTO | null;
  messages: ChatMessageDTO[];
  authors: ChatAuthorReferenceDTO[];
  lastSeq: number;
  receipt: ChatReceiptBanner | null;
  receivedAtByMessageId: Map<string, string>;
  terminalReason: ChatTerminalReason | null;
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

function createInitialThread(persisted: PersistedChatThreadState | null): ThreadSnapshot {
  if (!persisted) {
    return {
      conversation: null,
      messages: [],
      authors: [],
      lastSeq: 0,
      receipt: null,
      receivedAtByMessageId: new Map(),
      terminalReason: null,
    };
  }
  return {
    conversation: persisted.conversation,
    messages: persisted.messages,
    authors: persisted.authors,
    lastSeq: contiguousMessageSeq(persisted.messages),
    receipt: persisted.receipt,
    receivedAtByMessageId: new Map(persisted.receivedAtEntries),
    terminalReason: persisted.terminalReason,
  };
}

function pickLatestReceipt(
  current: ChatReceiptBanner | null,
  incoming: ChatReceiptBanner,
): ChatReceiptBanner {
  if (!current) return incoming;
  if (current.conversationId !== incoming.conversationId) return incoming;
  return incoming.seq >= current.seq ? incoming : current;
}

function toPersistedState(snapshot: ThreadSnapshot): PersistedChatThreadState | null {
  if (!snapshot.conversation) return null;
  return {
    conversation: snapshot.conversation,
    messages: snapshot.messages,
    authors: snapshot.authors,
    lastSeq: snapshot.lastSeq,
    receipt: snapshot.receipt,
    receivedAtEntries: Array.from(snapshot.receivedAtByMessageId.entries()),
    terminalReason: snapshot.terminalReason,
  };
}

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
  const epochRef = useRef(0);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const syncAbortRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const refreshingRef = useRef(false);
  const startingNewRef = useRef(false);

  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('checking');
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [thread, setThread] = useState<ThreadSnapshot>(() => createInitialThread(persistedThread));
  const threadRef = useRef<ThreadSnapshot>(thread);
  threadRef.current = thread;

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

  const commitThread = useCallback(
    (updater: (prev: ThreadSnapshot) => ThreadSnapshot): ThreadSnapshot => {
      const next = updater(threadRef.current);
      threadRef.current = next;
      setThread(next);
      onThreadChange(toPersistedState(next));
      return next;
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
      const attemptEpoch = epochRef.current;

      setSessionPhase('checking');
      setSessionError(null);
      if (options?.resetTerminal) {
        commitThread((prev) => ({ ...prev, terminalReason: null }));
      }

      const result = await openChatSession(locale, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted || attemptEpoch !== epochRef.current) return;

      if (!result.ok) {
        const terminal = classifyChatFailureTerminal(result);
        if (terminal) {
          commitThread((prev) => ({
            ...prev,
            terminalReason: prev.terminalReason ?? terminal,
          }));
          setSessionPhase('unavailable');
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
    [commitThread, locale, t],
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
    if (startingNewRef.current) return;
    startingNewRef.current = true;
    epochRef.current += 1;

    sendAbortRef.current?.abort();
    syncAbortRef.current?.abort();
    submittingRef.current = false;
    refreshingRef.current = false;
    setSubmitting(false);
    setRefreshing(false);
    setStartingNew(true);

    const emptyThread: ThreadSnapshot = {
      conversation: null,
      messages: [],
      authors: [],
      lastSeq: 0,
      receipt: null,
      receivedAtByMessageId: new Map(),
      terminalReason: null,
    };
    threadRef.current = emptyThread;
    setThread(emptyThread);
    onThreadChange(null);

    setEmail('');
    setBodyText('');
    setFieldErrors({});
    setSubmitError(null);
    setRefreshError(null);
    setClientConversationId(randomChatUuid());
    setClientMessageId(randomChatUuid());

    await runSessionCheck({ resetTerminal: true });
    if (mountedRef.current) {
      startingNewRef.current = false;
      setStartingNew(false);
    }
  };

  const applyServerFailure = (failure: ClientApiFailure) => {
    const terminal = classifyChatFailureTerminal(failure);
    if (terminal) {
      commitThread((prev) => ({
        ...prev,
        terminalReason: prev.terminalReason ?? terminal,
      }));
      setSubmitError(null);
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
    const activeThread = threadRef.current;
    if (submittingRef.current || sessionPhase !== 'ready' || activeThread.terminalReason !== null) {
      return;
    }

    const includeEmail = activeThread.conversation === null;
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
    submittingRef.current = true;
    setSubmitting(true);

    sendAbortRef.current?.abort();
    const controller = new AbortController();
    sendAbortRef.current = controller;
    const attemptEpoch = epochRef.current;

    if (activeThread.conversation === null) {
      const attemptConversationId = clientConversationId;
      const attemptMessageId = clientMessageId;
      const analyticsContext = chatStartTracker.bindAttemptContext(attemptConversationId);
      const res = await createChatConversation(
        {
          clientConversationId: attemptConversationId,
          clientMessageId: attemptMessageId,
          locale,
          bodyText: validation.bodyText,
          email: validation.email,
          productSlug,
          sourcePath,
        },
        { signal: controller.signal },
      );

      if (!mountedRef.current || controller.signal.aborted || attemptEpoch !== epochRef.current) {
        return;
      }
      submittingRef.current = false;
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
      const newReceipt: ChatReceiptBanner = {
        conversationId: res.data.conversationId,
        messageId: res.data.message.id,
        seq: res.data.message.seq,
        receivedAt: res.data.receivedAt,
      };

      commitThread((prev) => {
        const nextConversation = mergeConversationSnapshot(prev.conversation, createdConversation);
        const nextMessages = mergeChatMessages(prev.messages, [res.data.message]);
        const nextMap = new Map(prev.receivedAtByMessageId);
        nextMap.set(res.data.message.id, res.data.receivedAt);
        const nextTerminal = isConversationTerminalStatus(nextConversation)
          ? (nextConversation.anonymizedAt !== null ? 'anonymized' : 'closed')
          : prev.terminalReason;
        return {
          conversation: nextConversation,
          messages: nextMessages,
          authors: prev.authors,
          lastSeq: contiguousMessageSeq(nextMessages),
          receipt: pickLatestReceipt(prev.receipt, newReceipt),
          receivedAtByMessageId: nextMap,
          terminalReason: nextTerminal,
        };
      });

      setBodyText('');
      setEmail('');
      setClientMessageId(randomChatUuid());
      return;
    }

    const targetConversationId = activeThread.conversation.id;
    const attemptMessageId = clientMessageId;
    const res = await appendChatMessage(
      {
        conversationId: targetConversationId,
        clientMessageId: attemptMessageId,
        locale,
        bodyText: validation.bodyText,
      },
      { signal: controller.signal },
    );

    if (!mountedRef.current || controller.signal.aborted || attemptEpoch !== epochRef.current) {
      return;
    }
    submittingRef.current = false;
    setSubmitting(false);

    if (!res.ok) {
      applyServerFailure(res);
      return;
    }

    const newReceipt: ChatReceiptBanner = {
      conversationId: targetConversationId,
      messageId: res.data.message.id,
      seq: res.data.message.seq,
      receivedAt: res.data.receivedAt,
    };

    commitThread((prev) => {
      if (!prev.conversation || prev.conversation.id !== targetConversationId) return prev;
      const nextMessages = mergeChatMessages(prev.messages, [res.data.message]);
      const nextMap = new Map(prev.receivedAtByMessageId);
      nextMap.set(res.data.message.id, res.data.receivedAt);
      return {
        ...prev,
        messages: nextMessages,
        lastSeq: contiguousMessageSeq(nextMessages),
        receipt: pickLatestReceipt(prev.receipt, newReceipt),
        receivedAtByMessageId: nextMap,
      };
    });

    setBodyText('');
    setClientMessageId(randomChatUuid());
  };

  const handleRefreshMessages = async () => {
    const activeThread = threadRef.current;
    if (!activeThread.conversation || refreshingRef.current) return;

    const targetConversationId = activeThread.conversation.id;
    const syncCursor = contiguousMessageSeq(activeThread.messages);
    const attemptEpoch = epochRef.current;

    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);

    syncAbortRef.current?.abort();
    const controller = new AbortController();
    syncAbortRef.current = controller;

    const res = await fetchChatConversationUpdates(targetConversationId, syncCursor, locale, {
      signal: controller.signal,
    });
    if (!mountedRef.current || controller.signal.aborted || attemptEpoch !== epochRef.current) {
      return;
    }
    refreshingRef.current = false;
    setRefreshing(false);

    if (!res.ok) {
      const terminal = classifyChatFailureTerminal(res);
      if (terminal) {
        commitThread((prev) => {
          if (!prev.conversation || prev.conversation.id !== targetConversationId) return prev;
          return {
            ...prev,
            terminalReason: prev.terminalReason ?? terminal,
          };
        });
      } else {
        setRefreshError(res.text || t('refreshFailed'));
      }
      return;
    }

    commitThread((prev) => {
      if (!prev.conversation || prev.conversation.id !== targetConversationId) return prev;
      const nextConversation = mergeConversationSnapshot(prev.conversation, res.data.conversation);
      const nextMessages = mergeChatMessages(prev.messages, res.data.messages);
      const nextAuthors = mergeChatAuthors(prev.authors, res.data.authors);
      const nextMap = new Map(prev.receivedAtByMessageId);
      for (const msg of res.data.messages) {
        if (!nextMap.has(msg.id)) {
          nextMap.set(msg.id, msg.createdAt);
        }
      }
      const nextTerminal: ChatTerminalReason | null = isConversationTerminalStatus(nextConversation)
        ? (nextConversation.anonymizedAt !== null ? 'anonymized' : 'closed')
        : prev.terminalReason;
      return {
        conversation: nextConversation,
        messages: nextMessages,
        authors: nextAuthors,
        lastSeq: contiguousMessageSeq(nextMessages),
        receipt: prev.receipt,
        receivedAtByMessageId: nextMap,
        terminalReason: nextTerminal,
      };
    });
  };

  const { conversation, messages, receipt, receivedAtByMessageId, terminalReason, lastSeq } = thread;

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
      data-last-seq={lastSeq}
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
