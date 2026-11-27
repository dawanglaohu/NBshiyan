'use client';

import type { ClientApiFailure, ClientApiResult, ClientAudience } from './api';
import { classifyChatFailureTerminal, type ChatTerminalReason } from './chat';

export const CHAT_POLL_INTERVAL_MS = 3_000;
export const CHAT_POLL_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const CHAT_POLL_MAX_BACKOFF_MS = 30_000;

export type ChatPollTarget = {
  conversationId: string;
  afterSeq: number;
};

export type ChatPollerPhase =
  | 'idle'
  | 'scheduled'
  | 'polling'
  | 'backing_off'
  | 'paused_hidden'
  | 'stopped';

export type ChatPollerSnapshot = {
  phase: ChatPollerPhase;
  conversationId: string | null;
  consecutiveFailures: number;
  nextDelayMs: number | null;
  inFlight: boolean;
  lastError: ClientApiFailure | null;
  terminalReason: ChatTerminalReason | null;
};

export type ChatPollerScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  getVisibilityState?: () => 'visible' | 'hidden';
  subscribeVisibility?: (onChange: () => void) => () => void;
};

export type ChatPollerOptions<TUpdates> = {
  audience?: ClientAudience;
  normalIntervalMs?: number;
  backoffDelaysMs?: readonly number[];
  getTarget: () => ChatPollTarget | null;
  fetchUpdates: (target: ChatPollTarget, signal: AbortSignal) => Promise<ClientApiResult<TUpdates>>;
  detectTerminal?: (updates: TUpdates) => ChatTerminalReason | null;
  onUpdates: (
    updates: TUpdates,
    context: { conversationId: string; afterSeq: number; manual: boolean },
  ) => void;
  onTerminal: (
    reason: ChatTerminalReason,
    failure: ClientApiFailure | null,
    context: { conversationId: string },
  ) => void;
  onError?: (failure: ClientApiFailure, snapshot: ChatPollerSnapshot) => void;
  onSnapshot?: (snapshot: ChatPollerSnapshot) => void;
  scheduler?: ChatPollerScheduler;
};

export type ChatPoller = {
  start: () => void;
  stop: () => void;
  reset: () => void;
  syncTarget: () => void;
  refreshNow: () => Promise<void>;
  markTerminal: (reason: ChatTerminalReason) => void;
  getSnapshot: () => ChatPollerSnapshot;
  dispose: () => void;
};

/**
 * 计算连续失败后的有界退避间隔（1s → 2s → 4s → 8s → 16s → 30s），尊重不超过 30s 的 Retry-After。
 */
export function nextChatPollBackoffMs(
  consecutiveFailures: number,
  retryAfterMs?: number,
  delays: readonly number[] = CHAT_POLL_BACKOFF_DELAYS_MS,
): number {
  const index = Math.min(Math.max(0, Math.trunc(consecutiveFailures) - 1), Math.max(0, delays.length - 1));
  const base = delays[index] ?? CHAT_POLL_MAX_BACKOFF_MS;
  const retryFloor =
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(Math.ceil(retryAfterMs), CHAT_POLL_MAX_BACKOFF_MS)
      : 0;
  return Math.min(CHAT_POLL_MAX_BACKOFF_MS, Math.max(base, retryFloor));
}

function createDefaultScheduler(): Required<ChatPollerScheduler> {
  return {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    getVisibilityState: () => {
      if (typeof document === 'undefined') return 'visible';
      return document.visibilityState === 'hidden' ? 'hidden' : 'visible';
    },
    subscribeVisibility: (onChange) => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return () => {};
      }
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
  };
}

/**
 * 聊天增量同步轮询控制器（纯前端运行时，供访客与运营端共用）。
 * - 页面可见时固定 3s 同步，hidden 时零轮询，恢复 visible 立即按已确认游标补齐。
 * - 任一时刻保持严格单在途；失败按 1/2/4/8/16/30s 有界退避；切线程/失权/终止立即停定时器与过期响应。
 */
export function createChatPoller<TUpdates>(options: ChatPollerOptions<TUpdates>): ChatPoller {
  const audience = options.audience ?? 'visitor';
  const normalIntervalMs = options.normalIntervalMs ?? CHAT_POLL_INTERVAL_MS;
  const backoffDelaysMs = options.backoffDelaysMs ?? CHAT_POLL_BACKOFF_DELAYS_MS;
  const defaults = createDefaultScheduler();
  const scheduler: Required<ChatPollerScheduler> = {
    setTimeout: options.scheduler?.setTimeout ?? defaults.setTimeout,
    clearTimeout: options.scheduler?.clearTimeout ?? defaults.clearTimeout,
    getVisibilityState: options.scheduler?.getVisibilityState ?? defaults.getVisibilityState,
    subscribeVisibility: options.scheduler?.subscribeVisibility ?? defaults.subscribeVisibility,
  };

  let started = false;
  let disposed = false;
  let generation = 0;
  let activeConversationId: string | null = null;
  let phase: ChatPollerPhase = 'idle';
  let consecutiveFailures = 0;
  let nextDelayMs: number | null = null;
  let lastError: ClientApiFailure | null = null;
  let terminalReason: ChatTerminalReason | null = null;
  let timerHandle: unknown = null;
  let hasTimer = false;
  let inFlightController: AbortController | null = null;
  let inFlightGeneration = -1;
  let pendingCatchUp: 'manual' | 'visibility' | null = null;
  let unsubscribeVisibility: (() => void) | null = null;
  let lastVisibility: 'visible' | 'hidden' = scheduler.getVisibilityState();
  let manualWaiters: Array<() => void> = [];

  function getSnapshot(): ChatPollerSnapshot {
    return {
      phase,
      conversationId: activeConversationId,
      consecutiveFailures,
      nextDelayMs,
      inFlight: inFlightController !== null,
      lastError,
      terminalReason,
    };
  }

  function emitSnapshot() {
    options.onSnapshot?.(getSnapshot());
  }

  function clearScheduledTimer() {
    if (!hasTimer) return;
    hasTimer = false;
    const handle = timerHandle;
    timerHandle = null;
    scheduler.clearTimeout(handle);
  }

  function flushWaiters() {
    if (manualWaiters.length === 0) return;
    const resolvers = manualWaiters;
    manualWaiters = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  function abortInFlight() {
    generation += 1;
    pendingCatchUp = null;
    if (inFlightController) {
      const controller = inFlightController;
      inFlightController = null;
      inFlightGeneration = -1;
      controller.abort();
    }
    flushWaiters();
  }

  function scheduleNext(delayMs: number, nextPhase: 'scheduled' | 'backing_off') {
    clearScheduledTimer();
    if (disposed || !started || terminalReason !== null || activeConversationId === null) {
      return;
    }
    if (scheduler.getVisibilityState() === 'hidden') {
      phase = 'paused_hidden';
      nextDelayMs = null;
      emitSnapshot();
      return;
    }
    const scheduledGeneration = generation;
    phase = nextPhase;
    nextDelayMs = delayMs;
    hasTimer = true;
    emitSnapshot();
    timerHandle = scheduler.setTimeout(() => {
      if (!hasTimer || disposed || scheduledGeneration !== generation) return;
      hasTimer = false;
      timerHandle = null;
      nextDelayMs = null;
      void runPoll('poll');
    }, delayMs);
  }

  function transitionToIdleOrPaused() {
    clearScheduledTimer();
    nextDelayMs = null;
    if (terminalReason !== null) {
      phase = 'stopped';
    } else if (!started || activeConversationId === null) {
      phase = 'idle';
    } else if (scheduler.getVisibilityState() === 'hidden') {
      phase = 'paused_hidden';
    } else {
      phase = 'idle';
    }
    emitSnapshot();
  }

  async function runPoll(mode: 'poll' | 'manual' | 'visibility'): Promise<void> {
    if (disposed || terminalReason !== null) {
      flushWaiters();
      return;
    }
    const target = options.getTarget();
    if (!target) {
      activeConversationId = null;
      abortInFlight();
      transitionToIdleOrPaused();
      return;
    }

    if (target.conversationId !== activeConversationId) {
      activeConversationId = target.conversationId;
      consecutiveFailures = 0;
      lastError = null;
      abortInFlight();
    }

    const visibility = scheduler.getVisibilityState();
    if (mode !== 'manual' && (!started || visibility === 'hidden')) {
      transitionToIdleOrPaused();
      return;
    }

    if (inFlightController !== null) {
      if (mode === 'manual') {
        pendingCatchUp = 'manual';
      } else if (mode === 'visibility' && pendingCatchUp === null) {
        pendingCatchUp = 'visibility';
      }
      if (mode === 'manual') {
        return new Promise<void>((resolve) => {
          manualWaiters.push(resolve);
        });
      }
      return;
    }

    clearScheduledTimer();
    const runGeneration = generation;
    const targetId = target.conversationId;
    const targetAfterSeq = target.afterSeq;
    const controller = new AbortController();
    inFlightController = controller;
    inFlightGeneration = runGeneration;
    phase = 'polling';
    nextDelayMs = null;
    emitSnapshot();

    let result: ClientApiResult<TUpdates>;
    try {
      result = await options.fetchUpdates(target, controller.signal);
    } catch {
      if (disposed || runGeneration !== generation || inFlightGeneration !== runGeneration) {
        return;
      }
      inFlightController = null;
      inFlightGeneration = -1;
      result = {
        ok: false,
        text: '',
        action: controller.signal.aborted ? 'silent' : 'retry',
        envelope: 'unavailable',
        retryable: !controller.signal.aborted,
        attempts: 1,
        transient: true,
      };
    }

    if (disposed || runGeneration !== generation) {
      return;
    }
    inFlightController = null;
    inFlightGeneration = -1;

    if (controller.signal.aborted || (!result.ok && result.action === 'silent' && result.text === '')) {
      flushWaiters();
      syncTarget();
      return;
    }

    const latestTarget = options.getTarget();
    if (!latestTarget || latestTarget.conversationId !== targetId || terminalReason !== null) {
      flushWaiters();
      syncTarget();
      return;
    }

    if (!result.ok) {
      const terminal = classifyChatFailureTerminal(result, { audience });
      if (terminal !== null) {
        terminalReason = terminal;
        lastError = result;
        pendingCatchUp = null;
        clearScheduledTimer();
        phase = 'stopped';
        nextDelayMs = null;
        flushWaiters();
        emitSnapshot();
        options.onTerminal(terminal, result, { conversationId: targetId });
        return;
      }

      consecutiveFailures += 1;
      lastError = result;
      pendingCatchUp = null;
      flushWaiters();
      options.onError?.(result, getSnapshot());

      if (disposed || runGeneration !== generation || terminalReason !== null) {
        return;
      }
      if (!started) {
        transitionToIdleOrPaused();
        return;
      }
      const delayMs = nextChatPollBackoffMs(consecutiveFailures, result.retryAfterMs, backoffDelaysMs);
      scheduleNext(delayMs, 'backing_off');
      return;
    }

    consecutiveFailures = 0;
    lastError = null;
    options.onUpdates(result.data, {
      conversationId: targetId,
      afterSeq: targetAfterSeq,
      manual: mode === 'manual',
    });

    if (disposed || runGeneration !== generation) {
      flushWaiters();
      return;
    }

    const detectedTerminal = options.detectTerminal?.(result.data) ?? null;
    if (detectedTerminal !== null) {
      terminalReason = detectedTerminal;
      pendingCatchUp = null;
      clearScheduledTimer();
      phase = 'stopped';
      nextDelayMs = null;
      flushWaiters();
      emitSnapshot();
      options.onTerminal(detectedTerminal, null, { conversationId: targetId });
      return;
    }

    const afterUpdateTarget = options.getTarget();
    if (!afterUpdateTarget || afterUpdateTarget.conversationId !== targetId) {
      flushWaiters();
      syncTarget();
      return;
    }

    if (pendingCatchUp !== null && (pendingCatchUp === 'manual' || scheduler.getVisibilityState() === 'visible')) {
      const nextMode = pendingCatchUp;
      pendingCatchUp = null;
      await runPoll(nextMode);
      return;
    }
    pendingCatchUp = null;
    flushWaiters();

    if (!started) {
      transitionToIdleOrPaused();
      return;
    }
    scheduleNext(normalIntervalMs, 'scheduled');
  }

  function handleVisibilityChange() {
    if (disposed || !started) return;
    const nextVisibility = scheduler.getVisibilityState();
    const prevVisibility = lastVisibility;
    lastVisibility = nextVisibility;

    if (nextVisibility === 'hidden') {
      pendingCatchUp = null;
      clearScheduledTimer();
      nextDelayMs = null;
      abortInFlight();
      phase = terminalReason !== null ? 'stopped' : activeConversationId ? 'paused_hidden' : 'idle';
      emitSnapshot();
      return;
    }

    if (prevVisibility === 'hidden' && nextVisibility === 'visible') {
      const target = options.getTarget();
      if (!target || terminalReason !== null) {
        syncTarget();
        return;
      }
      void runPoll('visibility');
    }
  }

  function ensureVisibilitySubscribed() {
    if (unsubscribeVisibility !== null) return;
    lastVisibility = scheduler.getVisibilityState();
    unsubscribeVisibility = scheduler.subscribeVisibility(handleVisibilityChange);
  }

  function teardownVisibilitySubscription() {
    if (unsubscribeVisibility === null) return;
    const unsub = unsubscribeVisibility;
    unsubscribeVisibility = null;
    unsub();
  }

  function syncTarget() {
    if (disposed) return;
    const target = options.getTarget();
    const nextId = target?.conversationId ?? null;

    if (nextId !== activeConversationId) {
      abortInFlight();
      clearScheduledTimer();
      activeConversationId = nextId;
      consecutiveFailures = 0;
      lastError = null;
      nextDelayMs = null;
      if (nextId === null) {
        terminalReason = null;
      }
    }

    if (!started || activeConversationId === null || terminalReason !== null) {
      if (terminalReason !== null || activeConversationId === null) {
        clearScheduledTimer();
      }
      transitionToIdleOrPaused();
      return;
    }

    if (scheduler.getVisibilityState() === 'hidden') {
      clearScheduledTimer();
      phase = 'paused_hidden';
      nextDelayMs = null;
      emitSnapshot();
      return;
    }

    if (inFlightController === null && !hasTimer) {
      const delayMs =
        consecutiveFailures > 0
          ? nextChatPollBackoffMs(consecutiveFailures, lastError?.retryAfterMs, backoffDelaysMs)
          : normalIntervalMs;
      scheduleNext(delayMs, consecutiveFailures > 0 ? 'backing_off' : 'scheduled');
    }
  }

  function start() {
    if (disposed) return;
    started = true;
    ensureVisibilitySubscribed();
    syncTarget();
  }

  function stop() {
    if (disposed) return;
    started = false;
    teardownVisibilitySubscription();
    clearScheduledTimer();
    abortInFlight();
    nextDelayMs = null;
    phase = terminalReason !== null ? 'stopped' : 'idle';
    emitSnapshot();
  }

  function reset() {
    if (disposed) return;
    clearScheduledTimer();
    abortInFlight();
    activeConversationId = options.getTarget()?.conversationId ?? null;
    consecutiveFailures = 0;
    lastError = null;
    terminalReason = null;
    nextDelayMs = null;
    if (started && activeConversationId !== null) {
      syncTarget();
    } else {
      phase = 'idle';
      emitSnapshot();
    }
  }

  function markTerminal(reason: ChatTerminalReason) {
    if (disposed) return;
    terminalReason = reason;
    clearScheduledTimer();
    abortInFlight();
    nextDelayMs = null;
    phase = 'stopped';
    emitSnapshot();
  }

  async function refreshNow(): Promise<void> {
    if (disposed || terminalReason !== null) return;
    await runPoll('manual');
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    started = false;
    teardownVisibilitySubscription();
    clearScheduledTimer();
    abortInFlight();
    phase = 'stopped';
    nextDelayMs = null;
    emitSnapshot();
  }

  return {
    start,
    stop,
    reset,
    syncTarget,
    refreshNow,
    markTerminal,
    getSnapshot,
    dispose,
  };
}
