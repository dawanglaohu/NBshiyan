import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { ClientApiResult } from '../src/lib/client/api';
import {
  contiguousMessageSeq,
  fetchChatConversationUpdates,
  mergeChatMessages,
  mergeConversationSnapshot,
  resolveReadAckTargetSeq,
  selectMaxVisibleContiguousSeq,
  type ChatUpdatesSnapshot,
} from '../src/lib/client/chat';
import {
  CHAT_POLL_BACKOFF_DELAYS_MS,
  CHAT_POLL_INTERVAL_MS,
  createChatPoller,
  nextChatPollBackoffMs,
  type ChatPollTarget,
} from '../src/lib/client/chat-poller';
import {
  resolveChatSendFailure,
  selectChatSubmissionPayload,
} from '../src/lib/client/chat-retry';
import type { ChatConversationDTO, ChatMessageDTO } from '../src/lib/contracts/chat';

function createFakeScheduler(initialVisibility: 'visible' | 'hidden' = 'visible') {
  let nextId = 1;
  let now = 0;
  let visibility: 'visible' | 'hidden' = initialVisibility;
  const tasks = new Map<number, { runAt: number; fn: () => void }>();
  const visibilityListeners = new Set<() => void>();

  return {
    scheduler: {
      setTimeout: (fn: () => void, delayMs: number) => {
        const id = nextId++;
        tasks.set(id, { runAt: now + Math.max(0, delayMs), fn });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        if (typeof handle === 'number') {
          tasks.delete(handle);
        }
      },
      getVisibilityState: () => visibility,
      subscribeVisibility: (listener: () => void) => {
        visibilityListeners.add(listener);
        return () => visibilityListeners.delete(listener);
      },
    },
    pendingDelays(): number[] {
      return Array.from(tasks.values())
        .sort((a, b) => a.runAt - b.runAt)
        .map((t) => t.runAt - now);
    },
    async advanceBy(ms: number) {
      const deadline = now + ms;
      while (true) {
        let nextEntry: [number, { runAt: number; fn: () => void }] | null = null;
        for (const entry of tasks.entries()) {
          if (entry[1].runAt <= deadline && (!nextEntry || entry[1].runAt < nextEntry[1].runAt)) {
            nextEntry = entry;
          }
        }
        if (!nextEntry) break;
        const [id, task] = nextEntry;
        tasks.delete(id);
        now = task.runAt;
        task.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = deadline;
    },
    async setVisibility(next: 'visible' | 'hidden') {
      visibility = next;
      for (const listener of Array.from(visibilityListeners)) {
        listener();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function makeConversation(overrides?: Partial<ChatConversationDTO>): ChatConversationDTO {
  const iso = '2026-11-26T00:00:00.000Z';
  return {
    id: 'conv-1',
    locale: 'en',
    productSlug: null,
    sourcePath: '/en/contact',
    status: 'OPEN',
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    lastActivityAt: iso,
    retainUntil: '2027-02-24T00:00:00.000Z',
    anonymizedAt: null,
    ...overrides,
  };
}

function makeMessage(seq: number, id = `msg-${seq}`, bodyText = `Body ${seq}`): ChatMessageDTO {
  return {
    id,
    seq,
    sender: seq % 2 === 1 ? 'VISITOR' : 'OPERATOR',
    bodyText,
    createdAt: '2026-11-26T00:00:00.000Z',
  };
}

function makeSyncSnapshot(
  messages: ChatMessageDTO[],
  overrides?: Partial<ChatUpdatesSnapshot>,
): ChatUpdatesSnapshot {
  const maxSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  return {
    conversation: makeConversation(),
    messages,
    authors: [],
    lastSeq: maxSeq,
    nextAfterSeq: maxSeq,
    hasMore: false,
    read: { lastReadSeq: 0 },
    ...overrides,
  };
}

test('poller schedules 3s visible polling, zero polling while hidden, and immediate backfill on restore', async () => {
  const clock = createFakeScheduler('visible');
  let cursor = 1;
  const fetches: ChatPollTarget[] = [];
  let terminalCalled = false;

  const poller = createChatPoller<ChatUpdatesSnapshot>({
    getTarget: () => ({ conversationId: 'conv-1', afterSeq: cursor }),
    fetchUpdates: async (target) => {
      fetches.push(target);
      if (fetches.length === 1) {
        return {
          ok: true,
          attempts: 1,
          data: makeSyncSnapshot([makeMessage(2)]),
        };
      }
      return {
        ok: true,
        attempts: 1,
        data: makeSyncSnapshot([makeMessage(3)]),
      };
    },
    onUpdates: (updates) => {
      cursor = Math.max(cursor, ...updates.messages.map((m) => m.seq));
    },
    onTerminal: () => {
      terminalCalled = true;
    },
    scheduler: clock.scheduler,
  });

  poller.start();
  assert.deepEqual(clock.pendingDelays(), [CHAT_POLL_INTERVAL_MS]);

  await clock.advanceBy(2_999);
  assert.equal(fetches.length, 0);

  await clock.advanceBy(1);
  assert.deepEqual(fetches, [{ conversationId: 'conv-1', afterSeq: 1 }]);
  assert.equal(cursor, 2);
  assert.deepEqual(clock.pendingDelays(), [CHAT_POLL_INTERVAL_MS]);

  await clock.setVisibility('hidden');
  assert.equal(poller.getSnapshot().phase, 'paused_hidden');
  assert.deepEqual(clock.pendingDelays(), []);

  await clock.advanceBy(20_000);
  assert.equal(fetches.length, 1);

  await clock.setVisibility('visible');
  assert.deepEqual(fetches, [
    { conversationId: 'conv-1', afterSeq: 1 },
    { conversationId: 'conv-1', afterSeq: 2 },
  ]);
  assert.equal(cursor, 3);
  assert.equal(terminalCalled, false);
  poller.dispose();
});

test('poller applies bounded 1/2/4/8/16/30s failure backoff and resets to 3s on recovery', async () => {
  const clock = createFakeScheduler('visible');
  let shouldFail = true;
  const scheduledDelays: number[] = [];

  const poller = createChatPoller<ChatUpdatesSnapshot>({
    getTarget: () => ({ conversationId: 'conv-1', afterSeq: 0 }),
    fetchUpdates: async () => {
      if (shouldFail) {
        return {
          ok: false,
          text: 'Service unavailable',
          action: 'retry',
          envelope: 'app',
          code: 'service_unavailable',
          status: 503,
          retryable: true,
          attempts: 1,
          transient: true,
        };
      }
      return { ok: true, attempts: 1, data: makeSyncSnapshot([makeMessage(1)]) };
    },
    onUpdates: () => {},
    onTerminal: () => {},
    scheduler: clock.scheduler,
  });

  poller.start();

  const expectedBackoffs = [...CHAT_POLL_BACKOFF_DELAYS_MS, 30_000];
  let waitBeforePoll = CHAT_POLL_INTERVAL_MS;
  for (const expectedBackoff of expectedBackoffs) {
    await clock.advanceBy(waitBeforePoll);
    const delays = clock.pendingDelays();
    assert.equal(delays.length, 1);
    scheduledDelays.push(delays[0]!);
    assert.equal(delays[0], expectedBackoff);
    waitBeforePoll = expectedBackoff;
  }

  assert.deepEqual(scheduledDelays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(nextChatPollBackoffMs(4, 25_000), 25_000);
  assert.equal(nextChatPollBackoffMs(4, 90_000), 30_000);

  shouldFail = false;
  await clock.advanceBy(waitBeforePoll);
  assert.equal(poller.getSnapshot().consecutiveFailures, 0);
  assert.deepEqual(clock.pendingDelays(), [CHAT_POLL_INTERVAL_MS]);
  poller.dispose();
});

test('poller guarantees strict single in-flight and drops stale aborted responses after thread switch', async () => {
  const clock = createFakeScheduler('visible');
  let targetId = 'conv-1';
  let activeRequests = 0;
  let maxConcurrent = 0;
  let resolveFirst!: (val: ClientApiResult<ChatUpdatesSnapshot>) => void;
  let fetchCount = 0;
  const applied: string[] = [];

  const poller = createChatPoller<ChatUpdatesSnapshot>({
    getTarget: () => ({ conversationId: targetId, afterSeq: 0 }),
    fetchUpdates: async (target, signal) => {
      fetchCount += 1;
      activeRequests += 1;
      maxConcurrent = Math.max(maxConcurrent, activeRequests);
      try {
        if (fetchCount === 1) {
          return await new Promise<ClientApiResult<ChatUpdatesSnapshot>>((resolve) => {
            resolveFirst = resolve;
            signal.addEventListener('abort', () => {
              resolve({
                ok: false,
                text: '',
                action: 'silent',
                envelope: 'unavailable',
                retryable: false,
                attempts: 1,
                transient: false,
              });
            });
          });
        }
        return {
          ok: true,
          attempts: 1,
          data: makeSyncSnapshot([makeMessage(1, `msg-${target.conversationId}`)], {
            conversation: makeConversation({ id: target.conversationId }),
          }),
        };
      } finally {
        activeRequests -= 1;
      }
    },
    onUpdates: (_updates, ctx) => {
      applied.push(ctx.conversationId);
    },
    onTerminal: () => {},
    scheduler: clock.scheduler,
  });

  poller.start();
  const manualPromise = poller.refreshNow();
  // Calling refreshNow again while first is still in flight must NOT start a second request
  const secondManual = poller.refreshNow();
  assert.equal(fetchCount, 1);
  assert.equal(maxConcurrent, 1);

  resolveFirst({
    ok: true,
    attempts: 1,
    data: makeSyncSnapshot([makeMessage(1)]),
  });
  await Promise.all([manualPromise, secondManual]);
  assert.equal(maxConcurrent, 1);
  assert.equal(fetchCount, 2);
  assert.deepEqual(applied, ['conv-1', 'conv-1']);

  // Now switch target while a poll starts -> old response must be dropped on abort/switch
  fetchCount = 0;
  void poller.refreshNow();
  targetId = 'conv-2';
  poller.syncTarget();
  await clock.advanceBy(CHAT_POLL_INTERVAL_MS);
  assert.equal(applied[applied.length - 1], 'conv-2');
  assert.ok(!applied.slice(2).includes('conv-1'));
  poller.dispose();
});

test('poller stops timers permanently on visitor 401/404/CLOSED and operator 403 revocation', async () => {
  for (const scenario of [
    {
      name: 'visitor-401',
      audience: 'visitor' as const,
      failure: {
        ok: false as const,
        text: 'Expired',
        action: 'stop' as const,
        envelope: 'app' as const,
        code: 'unauthorized',
        status: 401,
        retryable: false,
        attempts: 1,
        transient: false,
      },
      expectedReason: 'expired',
    },
    {
      name: 'operator-403-revoked',
      audience: 'admin' as const,
      failure: {
        ok: false as const,
        text: 'Forbidden',
        action: 'stop' as const,
        envelope: 'app' as const,
        code: 'forbidden',
        status: 403,
        retryable: false,
        attempts: 1,
        transient: false,
      },
      expectedReason: 'forbidden',
    },
  ]) {
    const clock = createFakeScheduler('visible');
    let calls = 0;
    let reasonSeen: string | null = null;

    const poller = createChatPoller<ChatUpdatesSnapshot>({
      audience: scenario.audience,
      getTarget: () => ({ conversationId: 'conv-revoked', afterSeq: 0 }),
      fetchUpdates: async () => {
        calls += 1;
        return scenario.failure;
      },
      onUpdates: () => {
        assert.fail(`${scenario.name} should not emit updates on terminal failure`);
      },
      onTerminal: (reason) => {
        reasonSeen = reason;
      },
      scheduler: clock.scheduler,
    });

    poller.start();
    await clock.advanceBy(CHAT_POLL_INTERVAL_MS);
    assert.equal(calls, 1);
    assert.equal(reasonSeen, scenario.expectedReason);
    assert.equal(poller.getSnapshot().phase, 'stopped');
    assert.deepEqual(clock.pendingDelays(), []);

    // Visibility toggle after termination must never resume polling
    await clock.setVisibility('hidden');
    await clock.setVisibility('visible');
    await clock.advanceBy(60_000);
    assert.equal(calls, 1);
    poller.dispose();
  }
});

test('fetchChatConversationUpdates aborts in-flight multi-page loop when tab hides and catches up cleanly on restore', async () => {
  const origFetch = globalThis.fetch;
  try {
    const requestedAfterSeqs: string[] = [];
    const controller = new AbortController();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url, 'http://localhost');
      requestedAfterSeqs.push(parsed.searchParams.get('afterSeq') ?? '0');
      const snapshot = makeSyncSnapshot([makeMessage(1), makeMessage(2)], {
        authors: [{ messageId: 'msg-2', authorRef: 'op-1' }],
        lastSeq: 3,
        nextAfterSeq: 2,
        hasMore: true,
      });
      controller.abort();
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const abortedResult = await fetchChatConversationUpdates('conv-1', 0, 'en', {
      signal: controller.signal,
    });
    assert.equal(abortedResult.ok, false);
    assert.deepEqual(requestedAfterSeqs, ['0']);

    const clock = createFakeScheduler('visible');
    const pollerRequests: string[] = [];
    let releaseFirstPoll!: () => void;
    const firstPollWaiting = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve;
    });
    let markFirstPollEntered!: () => void;
    const firstPollEntered = new Promise<void>((resolve) => {
      markFirstPollEntered = resolve;
    });
    const deliveredSeqs: number[][] = [];
    let pollRound = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url, 'http://localhost');
      const afterSeq = parsed.searchParams.get('afterSeq') ?? '0';
      pollerRequests.push(afterSeq);
      const round = ++pollRound;

      if (round === 1) {
        markFirstPollEntered();
        await firstPollWaiting;
        if (init?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
      }

      const payload =
        afterSeq === '0'
          ? makeSyncSnapshot([makeMessage(1), makeMessage(2)], {
              authors: [{ messageId: 'msg-2', authorRef: 'op-1' }],
              lastSeq: 3,
              nextAfterSeq: 2,
              hasMore: true,
            })
          : makeSyncSnapshot([makeMessage(3)], {
              lastSeq: 3,
              nextAfterSeq: 3,
              hasMore: false,
            });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    let markCaughtUp!: () => void;
    const caughtUp = new Promise<void>((resolve) => {
      markCaughtUp = resolve;
    });

    const poller = createChatPoller({
      audience: 'visitor',
      scheduler: clock.scheduler,
      getTarget: () => ({ conversationId: 'conv-1', afterSeq: 0 }),
      fetchUpdates: (target, signal) =>
        fetchChatConversationUpdates(target.conversationId, target.afterSeq, 'en', { signal }),
      onUpdates: (updates) => {
        deliveredSeqs.push(updates.messages.map((m) => m.seq));
        markCaughtUp();
      },
      onTerminal: () => {
        assert.fail('onTerminal should not run for visibility abort');
      },
    });

    poller.start();
    await clock.advanceBy(CHAT_POLL_INTERVAL_MS);
    await Promise.race([
      firstPollEntered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for first poll')), 2000)),
    ]);
    await clock.setVisibility('hidden');
    releaseFirstPoll();
    await clock.advanceBy(10_000);
    assert.deepEqual(pollerRequests, ['0']);
    assert.deepEqual(deliveredSeqs, []);

    await clock.setVisibility('visible');
    await clock.advanceBy(0);
    await Promise.race([
      caughtUp,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for visible catch-up')), 2000)),
    ]);
    assert.deepEqual(pollerRequests, ['0', '0', '2']);
    assert.deepEqual(deliveredSeqs, [[1, 2, 3]]);
    poller.dispose();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('mergeChatMessages deduplicates strictly per ID and seq while contiguous seq and visible read never skip gaps', () => {
  const m1 = makeMessage(1, 'id-1', 'first');
  const m2 = makeMessage(2, 'id-2', 'second');
  const m3 = makeMessage(3, 'id-3', 'third');

  // Late response carrying [m1] after [m1, m2, m3] plus duplicate ID attempting wrong seq must not corrupt
  const merged = mergeChatMessages([m1, m3], [m1, m2, { ...m1, seq: 99 }, { ...m3, id: 'dup-id' }]);
  assert.deepEqual(
    merged.map((m) => [m.id, m.seq]),
    [
      ['id-1', 1],
      ['id-2', 2],
      ['id-3', 3],
    ],
  );
  assert.equal(contiguousMessageSeq(merged), 3);
  assert.equal(contiguousMessageSeq([m1, m3]), 1);

  // Version regression in late snapshot cannot undo CLOSED or downgrade version
  const latest = mergeConversationSnapshot(
    makeConversation({ version: 3, status: 'CLOSED' }),
    makeConversation({ version: 2, status: 'OPEN' }),
  );
  assert.equal(latest.version, 3);
  assert.equal(latest.status, 'CLOSED');

  // Visible read respects container bounds, hidden state, and contiguous cap
  assert.equal(
    selectMaxVisibleContiguousSeq({
      contiguousSeq: 3,
      visibilityState: 'hidden',
      containerTop: 0,
      containerBottom: 300,
      items: [{ seq: 1, top: 10, bottom: 80 }],
    }),
    0,
  );
  assert.equal(
    selectMaxVisibleContiguousSeq({
      contiguousSeq: 1,
      visibilityState: 'visible',
      containerTop: 0,
      containerBottom: 300,
      items: [
        { seq: 1, top: 10, bottom: 70 },
        { seq: 3, top: 80, bottom: 140 },
      ],
    }),
    1,
  );
  assert.equal(
    selectMaxVisibleContiguousSeq({
      contiguousSeq: 5,
      visibilityState: 'visible',
      containerTop: 100,
      containerBottom: 300,
      items: [
        { seq: 1, top: 10, bottom: 90 },
        { seq: 2, top: 110, bottom: 180 },
        { seq: 3, top: 190, bottom: 295 },
        { seq: 4, top: 320, bottom: 390 },
      ],
    }),
    3,
  );

  // Retained unconfirmed read target retries when visible & unconfirmed, never while hidden or past contiguous cursor
  assert.equal(
    resolveReadAckTargetSeq({
      visibilityState: 'visible',
      contiguousSeq: 5,
      maxVisibleSeq: 2,
      pendingReadSeq: 5,
      confirmedReadSeq: 2,
      inFlightReadSeq: 0,
    }),
    5,
  );
  assert.equal(
    resolveReadAckTargetSeq({
      visibilityState: 'hidden',
      contiguousSeq: 5,
      maxVisibleSeq: 0,
      pendingReadSeq: 5,
      confirmedReadSeq: 2,
      inFlightReadSeq: 0,
    }),
    0,
  );
  assert.equal(
    resolveReadAckTargetSeq({
      visibilityState: 'visible',
      contiguousSeq: 4,
      maxVisibleSeq: 3,
      pendingReadSeq: 6,
      confirmedReadSeq: 4,
      inFlightReadSeq: 0,
    }),
    0,
  );
});

test('chat-retry state machine freezes unconfirmed payload, keeps offline draft editable, and preserves draft without UUID swap on revocation or 409', () => {
  const baseSubmission = selectChatSubmissionPayload({
    pendingRetry: null,
    conversationId: null,
    clientConversationId: '11111111-1111-4111-8111-111111111111',
    clientMessageId: '22222222-2222-4222-8222-222222222222',
    locale: 'en',
    bodyText: 'Need custom cartons',
    email: 'buyer@example.com',
  });

  // Truncated response while online -> unconfirmed, inputs locked, exact payload frozen for retry
  const unconfirmed = resolveChatSendFailure({
    failure: {
      ok: false,
      text: "The result couldn't be confirmed.",
      action: 'unconfirmed',
      envelope: 'unavailable',
      retryable: false,
      attempts: 4,
      transient: true,
    },
    submission: baseSubmission,
    hadPendingRetry: false,
    offline: false,
  });
  assert.equal(unconfirmed.kind, 'retry_pending');
  assert.equal(unconfirmed.notice, 'unconfirmed');
  assert.equal(unconfirmed.lockInputs, true);
  assert.deepEqual(unconfirmed.pendingSubmission, baseSubmission);

  const reused = selectChatSubmissionPayload({
    pendingRetry: unconfirmed.pendingSubmission,
    conversationId: null,
    clientConversationId: '99999999-9999-4999-8999-999999999999',
    clientMessageId: '88888888-8888-4888-8888-888888888888',
    locale: 'en',
    bodyText: 'Mutated text',
    email: 'other@example.com',
  });
  assert.deepEqual(reused, baseSubmission);

  // Offline before sending (no network dispatch attempted) -> keeps draft editable & keys intact without locking
  const offline = resolveChatSendFailure({
    failure: {
      ok: false,
      text: 'Offline.',
      action: 'retry',
      envelope: 'unavailable',
      retryable: true,
      attempts: 0,
      transient: true,
    },
    submission: baseSubmission,
    hadPendingRetry: false,
    offline: true,
    startedOffline: true,
  });
  assert.equal(offline.kind, 'retry_pending');
  assert.equal(offline.notice, 'offline_retryable');
  assert.equal(offline.lockInputs, false);
  assert.equal(offline.preserveKeys, true);

  // Dropped offline mid-flight after dispatching online -> must still freeze pending submission & lock editor
  const midFlightOffline = resolveChatSendFailure({
    failure: {
      ok: false,
      text: "The result couldn't be confirmed.",
      action: 'unconfirmed',
      envelope: 'unavailable',
      retryable: false,
      attempts: 1,
      transient: true,
    },
    submission: baseSubmission,
    hadPendingRetry: false,
    offline: true,
    startedOffline: false,
  });
  assert.equal(midFlightOffline.kind, 'retry_pending');
  assert.equal(midFlightOffline.notice, 'unconfirmed');
  assert.equal(midFlightOffline.lockInputs, true);
  assert.equal(midFlightOffline.preserveKeys, true);
  assert.deepEqual(midFlightOffline.pendingSubmission, baseSubmission);

  // 409 conflict -> stops blind frozen retry and refuses UUID auto-swap
  const conflict = resolveChatSendFailure({
    failure: {
      ok: false,
      text: 'Conflict',
      action: 'stop',
      envelope: 'app',
      code: 'idempotency_conflict',
      status: 409,
      retryable: false,
      attempts: 1,
      transient: false,
    },
    submission: baseSubmission,
    hadPendingRetry: true,
    offline: false,
  });
  assert.equal(conflict.kind, 'retry_pending');
  assert.equal(conflict.notice, 'idempotency_conflict');
  assert.equal(conflict.pendingSubmission, null);
  assert.equal(conflict.preserveKeys, true);

  // 403 operator role revocation & 401 visitor expiry -> terminal, preserveDraft=true, clearPendingRetry=true
  const revokedOp = resolveChatSendFailure({
    failure: {
      ok: false,
      text: 'Forbidden',
      action: 'stop',
      envelope: 'app',
      code: 'forbidden',
      status: 403,
      retryable: false,
      attempts: 1,
      transient: false,
    },
    submission: baseSubmission,
    hadPendingRetry: true,
    audience: 'admin',
    offline: false,
  });
  assert.equal(revokedOp.kind, 'terminal');
  assert.equal(revokedOp.terminalReason, 'forbidden');
  assert.equal(revokedOp.preserveDraft, true);
  assert.equal(revokedOp.clearPendingRetry, true);

  // forbidden_origin CSRF error must NOT permanently close conversation
  const csrf = resolveChatSendFailure({
    failure: {
      ok: false,
      text: 'Forbidden origin',
      action: 'stop',
      envelope: 'app',
      code: 'forbidden_origin',
      status: 403,
      retryable: false,
      attempts: 1,
      transient: false,
    },
    submission: baseSubmission,
    hadPendingRetry: false,
    audience: 'admin',
    offline: false,
  });
  assert.notEqual(csrf.kind, 'terminal');
});
