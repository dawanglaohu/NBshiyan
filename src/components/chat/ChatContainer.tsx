'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type RefObject,
} from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Status } from '@/components/ui/Status';
import type { ClientLocale } from '@/lib/client/api-errors';
import {
  appendChatMessage,
  chatStartTracker,
  classifyChatFailureTerminal,
  contiguousMessageSeq,
  createChatConversation,
  fetchChatConversationUpdates,
  isConversationTerminalStatus,
  markChatRead,
  mergeChatAuthors,
  mergeChatMessages,
  mergeConversationSnapshot,
  openChatSession,
  randomChatUuid,
  selectMaxVisibleContiguousSeq,
  validateVisitorComposer,
  type ChatFieldErrorCode,
  type ChatTerminalReason,
  type ChatUpdatesSnapshot,
} from '@/lib/client/chat';
import { createChatPoller, type ChatPoller } from '@/lib/client/chat-poller';
import {
  isNavigatorOffline,
  resolveChatSendFailure,
  selectChatSubmissionPayload,
  type ChatRetryNoticeKind,
  type MessageSubmission,
} from '@/lib/client/chat-retry';
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
  lastReadSeq?: number;
  receipt: ChatReceiptBanner | null;
  receivedAtEntries: Array<[string, string]>;
  terminalReason: ChatTerminalReason | null;
};

type ThreadSnapshot = {
  conversation: ChatConversationDTO | null;
  messages: ChatMessageDTO[];
  authors: ChatAuthorReferenceDTO[];
  lastSeq: number;
  lastReadSeq: number;
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
      lastReadSeq: 0,
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
    lastReadSeq: persisted.lastReadSeq ?? 0,
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
    lastReadSeq: snapshot.lastReadSeq,
    receipt: snapshot.receipt,
    receivedAtEntries: Array.from(snapshot.receivedAtByMessageId.entries()),
    terminalReason: snapshot.terminalReason,
  };
}

function isContainerNearBottom(container: HTMLElement): boolean {
  if (container.scrollHeight <= container.clientHeight + 8) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= 32;
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
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const bodyInputRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const readSyncAbortRef = useRef<AbortController | null>(null);
  const readSyncRafRef = useRef<number | null>(null);
  const pollerRef = useRef<ChatPoller | null>(null);
  const submittingRef = useRef(false);
  const refreshingRef = useRef(false);
  const startingNewRef = useRef(false);
  const confirmedReadSeqRef = useRef(persistedThread?.lastReadSeq ?? 0);
  const readSyncInFlightRef = useRef(0);
  const scrolledUpRef = useRef(false);
  const scrollToBottomPendingRef = useRef(false);

  const [thread, setThread] = useState<ThreadSnapshot>(() => createInitialThread(persistedThread));
  const threadRef = useRef<ThreadSnapshot>(thread);
  threadRef.current = thread;

  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('checking');
  const sessionPhaseRef = useRef<SessionPhase>(sessionPhase);
  sessionPhaseRef.current = sessionPhase;
  const localeRef = useRef<ClientLocale>(locale);
  localeRef.current = locale;

  const [sessionError, setSessionError] = useState<string | null>(null);
  const [vvVars, setVvVars] = useState<{ height?: string; offsetBottom?: string }>({});

  const [email, setEmail] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ bodyText?: string; email?: string }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingRetry, setPendingRetry] = useState<MessageSubmission | null>(null);
  const [retryNotice, setRetryNotice] = useState<ChatRetryNoticeKind | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [syncFailures, setSyncFailures] = useState(0);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [startingNew, setStartingNew] = useState(false);

  const [clientConversationId, setClientConversationId] = useState(() => randomChatUuid());
  const [clientMessageId, setClientMessageId] = useState(() => randomChatUuid());

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

  const handleTerminalStop = useCallback(
    (reason: ChatTerminalReason) => {
      pollerRef.current?.markTerminal(reason);
      sendAbortRef.current?.abort();
      readSyncAbortRef.current?.abort();
      submittingRef.current = false;
      refreshingRef.current = false;
      readSyncInFlightRef.current = 0;
      setSubmitting(false);
      setRefreshing(false);
      setPendingRetry(null);
      setRetryNotice(null);
      setSubmitError(null);
      setRefreshError(null);
      setSyncNotice(null);
      setSyncFailures(0);
      setHasNewMessages(false);
      commitThread((prev) => ({
        ...prev,
        terminalReason: prev.terminalReason ?? reason,
      }));
    },
    [commitThread],
  );

  const handleTerminalStopRef = useRef(handleTerminalStop);
  handleTerminalStopRef.current = handleTerminalStop;

  const syncVisibleReadNow = useCallback(async () => {
    if (!mountedRef.current) return;
    const snap = threadRef.current;
    const container = bodyScrollRef.current;
    if (
      !snap.conversation ||
      snap.terminalReason !== null ||
      sessionPhaseRef.current !== 'ready' ||
      !container
    ) {
      return;
    }

    const targetConversationId = snap.conversation.id;
    const attemptEpoch = epochRef.current;
    const contiguousSeq = contiguousMessageSeq(snap.messages);
    if (contiguousSeq <= 0) return;

    const containerRect = container.getBoundingClientRect();
    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="chat-message-item"][data-seq]'),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return { seq: Number(el.dataset.seq), top: rect.top, bottom: rect.bottom };
    });

    const visibilityState: 'visible' | 'hidden' =
      typeof document !== 'undefined' && document.visibilityState === 'hidden' ? 'hidden' : 'visible';

    const maxVisibleSeq = selectMaxVisibleContiguousSeq({
      contiguousSeq,
      visibilityState,
      containerTop: containerRect.top,
      containerBottom: containerRect.bottom,
      items,
    });

    const highWater = Math.max(confirmedReadSeqRef.current, readSyncInFlightRef.current);
    if (maxVisibleSeq <= highWater) return;

    readSyncInFlightRef.current = maxVisibleSeq;
    readSyncAbortRef.current?.abort();
    const controller = new AbortController();
    readSyncAbortRef.current = controller;

    const res = await markChatRead(targetConversationId, maxVisibleSeq, localeRef.current, {
      signal: controller.signal,
    });

    if (!mountedRef.current || controller.signal.aborted || attemptEpoch !== epochRef.current) {
      if (readSyncInFlightRef.current === maxVisibleSeq) {
        readSyncInFlightRef.current = 0;
      }
      return;
    }

    if (readSyncInFlightRef.current === maxVisibleSeq) {
      readSyncInFlightRef.current = 0;
    }

    const latestSnap = threadRef.current;
    if (!latestSnap.conversation || latestSnap.conversation.id !== targetConversationId) return;

    if (!res.ok) {
      const terminal = classifyChatFailureTerminal(res, { audience: 'visitor' });
      if (terminal) {
        handleTerminalStopRef.current(terminal);
      }
      return;
    }

    const nextConfirmed = Math.max(confirmedReadSeqRef.current, res.data.lastReadSeq);
    confirmedReadSeqRef.current = nextConfirmed;
    if (nextConfirmed > latestSnap.lastReadSeq) {
      commitThread((prev) => {
        if (!prev.conversation || prev.conversation.id !== targetConversationId) return prev;
        return {
          ...prev,
          lastReadSeq: Math.max(prev.lastReadSeq, nextConfirmed),
        };
      });
    }
  }, [commitThread]);

  const scheduleVisibleReadSync = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      void syncVisibleReadNow();
      return;
    }
    if (readSyncRafRef.current !== null) {
      window.cancelAnimationFrame(readSyncRafRef.current);
    }
    readSyncRafRef.current = window.requestAnimationFrame(() => {
      readSyncRafRef.current = null;
      void syncVisibleReadNow();
    });
  }, [syncVisibleReadNow]);

  const applyUpdatesSnapshot = useCallback(
    (targetConversationId: string, snapshot: ChatUpdatesSnapshot) => {
      const prevMaxSeq = threadRef.current.messages.reduce((max, item) => Math.max(max, item.seq), 0);
      const container = bodyScrollRef.current;
      const wasScrolledUp = container ? !isContainerNearBottom(container) : scrolledUpRef.current;
      scrolledUpRef.current = wasScrolledUp;

      const nextConfirmedRead = Math.max(confirmedReadSeqRef.current, snapshot.read.lastReadSeq);
      confirmedReadSeqRef.current = nextConfirmedRead;

      const nextSnapshot = commitThread((prev) => {
        if (!prev.conversation || prev.conversation.id !== targetConversationId) return prev;
        const nextConversation = mergeConversationSnapshot(prev.conversation, snapshot.conversation);
        const nextMessages = mergeChatMessages(prev.messages, snapshot.messages);
        const nextAuthors = mergeChatAuthors(prev.authors, snapshot.authors);
        const nextMap = new Map(prev.receivedAtByMessageId);
        for (const msg of snapshot.messages) {
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
          lastReadSeq: Math.max(prev.lastReadSeq, nextConfirmedRead),
          receipt: prev.receipt,
          receivedAtByMessageId: nextMap,
          terminalReason: nextTerminal,
        };
      });

      const nextMaxSeq = nextSnapshot.messages.reduce((max, item) => Math.max(max, item.seq), 0);
      if (nextMaxSeq > prevMaxSeq) {
        if (wasScrolledUp) {
          setHasNewMessages(true);
        } else {
          scrollToBottomPendingRef.current = true;
          setHasNewMessages(false);
        }
      }
    },
    [commitThread],
  );

  const applyUpdatesRef = useRef(applyUpdatesSnapshot);
  applyUpdatesRef.current = applyUpdatesSnapshot;

  const translateRef = useRef(t);
  translateRef.current = t;

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
        const terminal = classifyChatFailureTerminal(result, { audience: 'visitor' });
        if (terminal) {
          handleTerminalStopRef.current(terminal);
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

    const poller = createChatPoller({
      audience: 'visitor',
      getTarget: () => {
        if (!mountedRef.current) return null;
        if (sessionPhaseRef.current !== 'ready') return null;
        const snap = threadRef.current;
        if (!snap.conversation || snap.terminalReason !== null) return null;
        return {
          conversationId: snap.conversation.id,
          afterSeq: contiguousMessageSeq(snap.messages),
        };
      },
      fetchUpdates: (target, signal) =>
        fetchChatConversationUpdates(target.conversationId, target.afterSeq, localeRef.current, {
          signal,
        }),
      detectTerminal: (updates) =>
        isConversationTerminalStatus(updates.conversation)
          ? (updates.conversation.anonymizedAt !== null ? 'anonymized' : 'closed')
          : null,
      onUpdates: (updates, ctx) => {
        if (!mountedRef.current) return;
        setRefreshError(null);
        setSyncNotice(null);
        setSyncFailures(0);
        applyUpdatesRef.current(ctx.conversationId, updates);
      },
      onTerminal: (reason) => {
        if (!mountedRef.current) return;
        handleTerminalStopRef.current(reason);
      },
      onError: (failure, snapshot) => {
        if (!mountedRef.current) return;
        setSyncNotice(translateRef.current('syncRetryingNotice'));
        setSyncFailures(snapshot.consecutiveFailures);
        if (refreshingRef.current) {
          setRefreshError(failure.text || translateRef.current('refreshFailed'));
        }
      },
    });
    pollerRef.current = poller;
    poller.start();

    return () => {
      mountedRef.current = false;
      if (readSyncRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(readSyncRafRef.current);
        readSyncRafRef.current = null;
      }
      sessionAbortRef.current?.abort();
      sendAbortRef.current?.abort();
      readSyncAbortRef.current?.abort();
      if (pollerRef.current === poller) {
        pollerRef.current = null;
      }
      poller.dispose();
    };
  }, [runSessionCheck]);

  useEffect(() => {
    pollerRef.current?.syncTarget();
  }, [locale, sessionPhase, thread.conversation?.id, thread.terminalReason]);

  useEffect(() => {
    const container = bodyScrollRef.current;
    if (container && scrollToBottomPendingRef.current) {
      scrollToBottomPendingRef.current = false;
      container.scrollTop = container.scrollHeight;
      scrolledUpRef.current = false;
      setHasNewMessages(false);
    }
    scheduleVisibleReadSync();
  }, [
    thread.conversation?.id,
    thread.lastSeq,
    thread.messages.length,
    sessionPhase,
    thread.terminalReason,
    scheduleVisibleReadSync,
  ]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        scheduleVisibleReadSync();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [scheduleVisibleReadSync]);

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

  const handleBodyScroll = () => {
    const container = bodyScrollRef.current;
    if (!container) return;
    const nearBottom = isContainerNearBottom(container);
    scrolledUpRef.current = !nearBottom;
    if (nearBottom) {
      setHasNewMessages(false);
    }
    scheduleVisibleReadSync();
  };

  const handleJumpToNewMessages = () => {
    const container = bodyScrollRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
    scrolledUpRef.current = false;
    setHasNewMessages(false);
    scheduleVisibleReadSync();
  };

  const handleStartNewConversation = async () => {
    if (startingNewRef.current) return;
    startingNewRef.current = true;
    epochRef.current += 1;

    sendAbortRef.current?.abort();
    readSyncAbortRef.current?.abort();
    submittingRef.current = false;
    refreshingRef.current = false;
    readSyncInFlightRef.current = 0;
    confirmedReadSeqRef.current = 0;
    scrolledUpRef.current = false;
    scrollToBottomPendingRef.current = false;
    setSubmitting(false);
    setRefreshing(false);
    setStartingNew(true);

    const emptyThread: ThreadSnapshot = {
      conversation: null,
      messages: [],
      authors: [],
      lastSeq: 0,
      lastReadSeq: 0,
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
    setSyncNotice(null);
    setSyncFailures(0);
    setHasNewMessages(false);
    setClientConversationId(randomChatUuid());
    setClientMessageId(randomChatUuid());
    setPendingRetry(null);
    setRetryNotice(null);
    pollerRef.current?.reset();

    await runSessionCheck({ resetTerminal: true });
    if (mountedRef.current) {
      startingNewRef.current = false;
      setStartingNew(false);
    }
  };

  const translateFailureNotice = (notice: ChatRetryNoticeKind): string => {
    switch (notice) {
      case 'unconfirmed':
        return t('sendUnconfirmed');
      case 'offline_retryable':
        return t('offlineFailedNotice');
      case 'idempotency_conflict':
        return t('idempotencyConflictNotice');
      case 'retryable':
        return t('sendFailedNotice');
    }
  };

  const executeSubmission = async () => {
    const activeThread = threadRef.current;
    if (submittingRef.current || sessionPhaseRef.current !== 'ready' || activeThread.terminalReason !== null) {
      return;
    }

    let submission: MessageSubmission;
    if (pendingRetry !== null) {
      submission = pendingRetry;
    } else {
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
        setRetryNotice(null);
        if (nextErrors.email) {
          emailInputRef.current?.focus();
        } else if (nextErrors.bodyText) {
          bodyInputRef.current?.focus();
        }
        return;
      }

      submission = selectChatSubmissionPayload({
        pendingRetry: null,
        conversationId: activeThread.conversation?.id ?? null,
        clientConversationId,
        clientMessageId,
        locale,
        bodyText: validation.bodyText,
        email: validation.email,
        productSlug,
        sourcePath,
      });
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

    const handleFailure = (
      failure: Parameters<typeof resolveChatSendFailure>[0]['failure'],
      startedOfflineOnAttempt: boolean,
    ) => {
      const resolution = resolveChatSendFailure({
        failure,
        submission,
        hadPendingRetry: pendingRetry !== null,
        audience: 'visitor',
        startedOffline: startedOfflineOnAttempt,
      });
      if (resolution.kind === 'terminal') {
        handleTerminalStop(resolution.terminalReason);
        return;
      }
      if (resolution.kind === 'field_errors') {
        setPendingRetry(null);
        setRetryNotice(null);
        setFieldErrors(resolution.fieldErrors);
        setSubmitError(null);
        if (resolution.fieldErrors.email) emailInputRef.current?.focus();
        else if (resolution.fieldErrors.bodyText) bodyInputRef.current?.focus();
        return;
      }
      setPendingRetry(resolution.pendingSubmission);
      setRetryNotice(resolution.notice);
      setSubmitError(translateFailureNotice(resolution.notice));
    };

    const startedOffline = isNavigatorOffline();
    if (pendingRetry === null && startedOffline) {
      submittingRef.current = false;
      setSubmitting(false);
      handleFailure(
        {
          ok: false,
          text: '',
          action: 'retry',
          envelope: 'unavailable',
          retryable: true,
          attempts: 0,
          transient: true,
        },
        true,
      );
      return;
    }

    if ('clientConversationId' in submission) {
      const attemptConversationId = submission.clientConversationId;
      const analyticsContext = chatStartTracker.bindAttemptContext(attemptConversationId);
      const res = await createChatConversation(submission, { signal: controller.signal });

      if (!mountedRef.current || controller.signal.aborted || attemptEpoch !== epochRef.current) {
        return;
      }
      submittingRef.current = false;
      setSubmitting(false);

      if (!res.ok) {
        handleFailure(res, startedOffline);
        return;
      }

      setPendingRetry(null);
      setRetryNotice(null);
      chatStartTracker.emitOnCreateSuccess({
        context: analyticsContext,
        clientConversationId: attemptConversationId,
        productSlug: submission.productSlug,
      });

      const nowIso = res.data.receivedAt;
      const createdConversation: ChatConversationDTO = {
        id: res.data.conversationId,
        locale: submission.locale,
        productSlug: submission.productSlug ?? null,
        sourcePath: submission.sourcePath ?? null,
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

      confirmedReadSeqRef.current = 0;
      scrollToBottomPendingRef.current = true;
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
          lastReadSeq: prev.lastReadSeq,
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

    const targetConversationId = submission.conversationId;
    const res = await appendChatMessage(submission, { signal: controller.signal });

    if (!mountedRef.current || controller.signal.aborted || attemptEpoch !== epochRef.current) {
      return;
    }
    submittingRef.current = false;
    setSubmitting(false);

    if (!res.ok) {
      handleFailure(res, startedOffline);
      return;
    }

    setPendingRetry(null);
    setRetryNotice(null);
    const newReceipt: ChatReceiptBanner = {
      conversationId: targetConversationId,
      messageId: res.data.message.id,
      seq: res.data.message.seq,
      receivedAt: res.data.receivedAt,
    };

    scrollToBottomPendingRef.current = true;
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await executeSubmission();
  };

  const handleRefreshMessages = async () => {
    const activeThread = threadRef.current;
    if (!activeThread.conversation || activeThread.terminalReason !== null || refreshingRef.current) {
      return;
    }
    const poller = pollerRef.current;
    if (!poller) return;

    const attemptEpoch = epochRef.current;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);

    await poller.refreshNow();

    if (!mountedRef.current || attemptEpoch !== epochRef.current) {
      return;
    }
    refreshingRef.current = false;
    setRefreshing(false);
    const snap = poller.getSnapshot();
    if (snap.lastError && threadRef.current.terminalReason === null) {
      setRefreshError(snap.lastError.text || t('refreshFailed'));
    }
  };

  const { conversation, messages, receipt, receivedAtByMessageId, terminalReason, lastSeq } = thread;

  const terminalMessage =
    terminalReason === 'closed' || terminalReason === 'anonymized'
      ? t('endedClosedNotice')
      : terminalReason === 'forbidden'
        ? t('endedForbiddenNotice')
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
          {conversation && terminalReason === null && (
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

      <div ref={bodyScrollRef} className="pj-chat-body" onScroll={handleBodyScroll}>
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

        {syncNotice && terminalReason === null && (
          <Status
            tone="warning"
            prefix={t('statusPrefix')}
            data-testid="chat-sync-status"
            data-failures={syncFailures}
          >
            {syncNotice}
          </Status>
        )}

        {refreshError && terminalReason === null && (
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
              {retryNotice !== 'idempotency_conflict' && (
                <Button
                  type="button"
                  variant="primary"
                  context="public"
                  id="chat-retry"
                  data-testid="chat-retry"
                  aria-label={t('retryActionAria')}
                  busy={submitting}
                  busyLabel={t('sending')}
                  disabled={composerDisabled || submitting}
                  disabledReason={composerDisabled ? composerDisabledReason : undefined}
                  onClick={() => void executeSubmission()}
                >
                  {t('retryAction')}
                </Button>
              )}
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

      {hasNewMessages && terminalReason === null && (
        <div
          className="pj-chat-recovery-actions"
          style={{
            padding: '6px 12px',
            borderTop: 'var(--pj-border-width, 2px) solid var(--pj-border, #000000)',
            background: 'var(--pj-bg, #ffffff)',
          }}
        >
          <Button
            type="button"
            variant="primary"
            context="public"
            id="chat-new-messages"
            data-testid="chat-new-messages"
            aria-label={t('newMessagesAria')}
            onClick={handleJumpToNewMessages}
          >
            {t('newMessagesAction')}
          </Button>
        </div>
      )}

      <Composer
        showEmailField={conversation === null}
        email={email}
        bodyText={bodyText}
        emailError={fieldErrors.email}
        bodyError={fieldErrors.bodyText}
        submitting={submitting}
        awaitingReceipt={pendingRetry !== null}
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
