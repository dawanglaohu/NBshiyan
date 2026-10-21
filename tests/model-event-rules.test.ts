import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AnalyticsEventDTOSchema, type AnalyticsEventDTO } from '../src/lib/contracts/index';
import {
  applyModelEventSignal,
  emptyModelEventRules,
  reduceModelEventSignals,
  type ModelEventRulesState,
  type ModelEventSignal,
  type ModelStartInput,
} from '../src/lib/analytics/model-events';

const viewA = '5fcf5ba2-7d35-4d50-8798-e6f65b1268ef';
const viewB = '7aac1bb7-f310-40e2-bf11-1252744ab7e5';
const viewC = '9b6c1d20-4a55-4c31-9a70-2d4e6f8091ab';
const navA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const navB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const startA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const startB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const startC = 'abababab-abab-4bab-8bab-abababababab';
const termA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const termA2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const termB = '11111111-1111-4111-8111-111111111111';
const termC = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-21T08:00:00.000Z';
const later = '2026-10-21T09:15:00.000Z';
const pastDurationMax = 600_001;

function start(overrides: Partial<ModelStartInput> & { viewId: string; eventId: string; monotonicMs: number }): ModelStartInput {
  return {
    navigationId: navA,
    productSlug: 'blue-box',
    locale: 'en',
    path: '/en/products/blue-box',
    occurredAt: at,
    ...overrides,
  };
}

function kinds(events: readonly AnalyticsEventDTO[]): string[] {
  return events.map((event) => event.kind);
}

function terminalsOf(events: readonly AnalyticsEventDTO[], viewId: string): AnalyticsEventDTO[] {
  return events.filter((event) => (
    (event.kind === 'model_load_success' || event.kind === 'model_load_failure') && event.viewId === viewId
  ));
}

function freeze(state: ModelEventRulesState): ModelEventRulesState {
  for (const view of Object.values(state.views)) Object.freeze(view);
  Object.freeze(state.views);
  Object.freeze(state.pending);
  Object.freeze(state.usedEventIds);
  return Object.freeze(state);
}

test('recorded sequences allow one terminal per view, count timeout as failure, and ignore poster and FoldBox', () => {
  const events = reduceModelEventSignals([
    { type: 'visit' },
    { type: 'display', surface: 'poster', outcome: 'success', viewId: viewA },
    { type: 'success', surface: 'poster', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 40 },
    { type: 'display', surface: 'fold-box', outcome: 'success', viewId: viewA },
    { type: 'success', surface: 'fold-box', viewId: viewA, eventId: termA2, occurredAt: at, monotonicMs: 50 },
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 100 }) },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: later, monotonicMs: 350 },
    { type: 'failure', failureReason: 'LOAD_ERROR', viewId: viewA, eventId: termA2, occurredAt: later, monotonicMs: 900 },
    { type: 'timeout', viewId: viewA, eventId: termC, occurredAt: later, monotonicMs: 1_000 },
    { type: 'start', ...start({ viewId: viewB, eventId: startB, monotonicMs: 1_000, navigationId: navB, productSlug: 'red-mailer', path: '/en/products/red-mailer' }) },
    { type: 'timeout', viewId: viewB, eventId: termB, occurredAt: later, monotonicMs: 1_400 },
    { type: 'success', viewId: viewB, eventId: termC, occurredAt: later, monotonicMs: 1_500 },
  ]).events;

  assert.deepEqual(kinds(events), ['model_view_start', 'model_load_success', 'model_view_start', 'model_load_failure']);
  assert.equal(terminalsOf(events, viewA).length, 1);
  assert.equal(terminalsOf(events, viewA)[0]?.kind, 'model_load_success');
  assert.equal(terminalsOf(events, viewB).length, 1);
  assert.equal(terminalsOf(events, viewB)[0]?.kind, 'model_load_failure');
  if (terminalsOf(events, viewB)[0]?.kind === 'model_load_failure') {
    assert.equal(terminalsOf(events, viewB)[0].failureReason, 'TIMEOUT');
  }
  assert.equal(events.some((event) => event.kind === 'model_load_success' && event.viewId === viewB), false);
});

test('a retry is a new GLB attempt and keeps the previous terminal', () => {
  const first = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 10 }) },
    { type: 'failure', failureReason: 'WEBGL_UNAVAILABLE', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 25 },
    { type: 'retry', previousViewId: viewA, ...start({ viewId: viewA, eventId: startB, monotonicMs: 30 }) },
  ]);
  assert.deepEqual(kinds(first.events), ['model_view_start', 'model_load_failure']);
  assert.equal(first.state.views[viewA]?.status, 'decided');

  const retried = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 10 }) },
    { type: 'failure', failureReason: 'LOAD_ERROR', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 25 },
    { type: 'retry', previousViewId: viewA, ...start({ viewId: viewB, eventId: startB, monotonicMs: 40, productSlug: 'red-mailer', navigationId: navB }) },
    { type: 'success', viewId: viewA, eventId: termA2, occurredAt: later, monotonicMs: 80 },
    { type: 'success', viewId: viewB, eventId: termB, occurredAt: later, monotonicMs: 70 },
  ]).events;

  assert.deepEqual(kinds(retried), ['model_view_start', 'model_load_failure', 'model_view_start', 'model_load_success']);
  assert.equal(terminalsOf(retried, viewA).length, 1);
  assert.equal(terminalsOf(retried, viewA)[0]?.kind, 'model_load_failure');
  assert.equal(terminalsOf(retried, viewB).length, 1);
  assert.notEqual(viewA, viewB);
  const success = terminalsOf(retried, viewB)[0];
  assert.equal(success && 'productSlug' in success ? success.productSlug : undefined, 'red-mailer');
  assert.equal(success && 'navigationId' in success ? success.navigationId : undefined, navB);
});

test('duration is the injected clock difference and product navigation stay unchanged', () => {
  const result = reduceModelEventSignals([
    { type: 'failure', failureReason: 'TIMEOUT', viewId: viewA, eventId: termA, occurredAt: later, monotonicMs: 5_250 },
    { type: 'success', viewId: viewA, eventId: termA2, occurredAt: later, monotonicMs: 9_000 },
    {
      type: 'start',
      ...start({
        viewId: viewA,
        eventId: startA,
        monotonicMs: 5_000,
        occurredAt: at,
        locale: 'ru',
        navigationId: navA,
        productSlug: 'blue-box',
        path: '/ru/products/blue-box?utm=1',
      }),
    },
  ]);

  assert.deepEqual(kinds(result.events), ['model_view_start', 'model_load_failure']);
  const [started, failed] = result.events;
  assert.equal(started?.kind, 'model_view_start');
  assert.equal(failed?.kind, 'model_load_failure');
  if (started?.kind !== 'model_view_start' || failed?.kind !== 'model_load_failure') return;
  assert.equal(failed.durationMs, 250);
  assert.equal(failed.failureReason, 'TIMEOUT');
  assert.equal(failed.occurredAt, later);
  assert.equal(started.occurredAt, at);
  assert.equal(failed.navigationId, navA);
  assert.equal(failed.productSlug, 'blue-box');
  assert.equal(started.navigationId, navA);
  assert.equal(started.productSlug, 'blue-box');
  assert.equal(started.locale, 'ru');
  assert.equal(failed.locale, 'ru');
  assert.equal(started.path, '/ru/products/blue-box');
  assert.equal(failed.path, '/ru/products/blue-box');
  assert.equal(failed.viewId, viewA);
  for (const event of result.events) assert.deepEqual(AnalyticsEventDTOSchema.parse(event), event);
  assert.equal(JSON.stringify(result.events).includes('utm'), false);
});

test('a later or duplicate terminal does not replace the decided one', () => {
  const ordered = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 0 }) },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 20 },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 20 },
    { type: 'failure', failureReason: 'LOAD_ERROR', viewId: viewA, eventId: termA2, occurredAt: later, monotonicMs: 30 },
    { type: 'timeout', viewId: viewA, eventId: termC, occurredAt: later, monotonicMs: 40 },
  ]);
  assert.deepEqual(kinds(ordered.events), ['model_view_start', 'model_load_success']);
  assert.equal(ordered.state.views[viewA]?.status, 'decided');
  if (ordered.state.views[viewA]?.status === 'decided') {
    assert.equal(ordered.state.views[viewA].terminalKind, 'model_load_success');
    assert.equal(ordered.state.views[viewA].terminalEventId, termA);
  }

  const reversed = reduceModelEventSignals([
    { type: 'timeout', viewId: viewC, eventId: termC, occurredAt: at, monotonicMs: 80 },
    { type: 'success', viewId: viewC, eventId: termB, occurredAt: later, monotonicMs: 90 },
    { type: 'start', ...start({ viewId: viewC, eventId: startC, monotonicMs: 10, navigationId: navB, productSlug: 'red-mailer' }) },
  ]);
  assert.deepEqual(kinds(reversed.events), ['model_view_start', 'model_load_failure']);
  const terminal = reversed.events[1];
  assert.equal(terminal?.kind, 'model_load_failure');
  if (terminal?.kind === 'model_load_failure') {
    assert.equal(terminal.durationMs, 70);
    assert.equal(terminal.failureReason, 'TIMEOUT');
    assert.equal(terminal.navigationId, navB);
    assert.equal(terminal.productSlug, 'red-mailer');
  }
});

test('cancel closes an open attempt and an invalid retry does not cancel it', () => {
  const cancelled = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 5, navigationId: navA, productSlug: 'blue-box' }) },
    { type: 'cancel', viewId: viewA },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 45 },
    { type: 'timeout', viewId: viewA, eventId: termA2, occurredAt: at, monotonicMs: 60 },
  ]);
  assert.deepEqual(kinds(cancelled.events), ['model_view_start']);
  assert.equal(cancelled.state.views[viewA]?.status, 'cancelled');
  assert.equal(cancelled.state.views[viewA]?.productSlug, 'blue-box');
  assert.equal(cancelled.state.views[viewA]?.navigationId, navA);
  assert.equal(cancelled.events[0] && 'durationMs' in cancelled.events[0] ? cancelled.events[0].durationMs : undefined, undefined);

  const kept = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 5 }) },
    { type: 'retry', previousViewId: viewA, ...start({ viewId: viewB, eventId: startB, monotonicMs: 8, productSlug: 'Not A Slug', surface: 'poster' }) },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 15 },
  ]);
  assert.deepEqual(kinds(kept.events), ['model_view_start', 'model_load_success']);
  assert.equal(kept.events[1] && 'durationMs' in kept.events[1] ? kept.events[1].durationMs : undefined, 10);

  const switched = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 1, productSlug: 'blue-box', navigationId: navA }) },
    { type: 'retry', previousViewId: viewA, ...start({ viewId: viewB, eventId: startB, monotonicMs: 4, productSlug: 'red-mailer', navigationId: navB, path: '/ru/products/red-mailer', locale: 'ru' }) },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 9 },
    { type: 'success', viewId: viewB, eventId: termB, occurredAt: later, monotonicMs: 12 },
  ]).events;
  assert.deepEqual(kinds(switched), ['model_view_start', 'model_view_start', 'model_load_success']);
  const moved = switched[2];
  assert.equal(moved?.kind, 'model_load_success');
  if (moved?.kind === 'model_load_success') {
    assert.equal(moved.viewId, viewB);
    assert.equal(moved.productSlug, 'red-mailer');
    assert.equal(moved.navigationId, navB);
    assert.equal(moved.durationMs, 8);
    assert.equal(moved.locale, 'ru');
  }
});

test('empty, unreadable, repeated, and out-of-range inputs do not invent a second terminal', () => {
  assert.deepEqual(reduceModelEventSignals([]).events, []);
  assert.deepEqual(reduceModelEventSignals(undefined).events, []);
  assert.deepEqual(reduceModelEventSignals(null).events, []);
  const ignored = reduceModelEventSignals([
    { type: 'cancel', viewId: 'missing' },
    { type: 'start', ...start({ viewId: viewA, eventId: 'not-a-uuid', monotonicMs: 0 }) },
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 1.5 }) },
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 0, productSlug: '' }) },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: 'tomorrow', monotonicMs: 5 },
  ]);
  assert.deepEqual(ignored.events, []);

  const open = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 0, productSlug: 'blue-box' }) },
    { type: 'start', ...start({ viewId: viewA, eventId: startB, monotonicMs: 3, productSlug: 'red-mailer', navigationId: navB }) },
  ]);
  assert.deepEqual(kinds(open.events), ['model_view_start']);
  assert.equal(open.events[0] && 'productSlug' in open.events[0] ? open.events[0].productSlug : undefined, 'blue-box');
  assert.equal(open.state.views[viewA]?.navigationId, navA);

  const withheld = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 0 }) },
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 10.5 },
    { type: 'success', viewId: viewA, eventId: termA2, occurredAt: at, monotonicMs: pastDurationMax },
    { type: 'failure', failureReason: 'LOAD_ERROR', viewId: viewA, eventId: termB, occurredAt: later, monotonicMs: 12 },
  ]);
  assert.deepEqual(kinds(withheld.events), ['model_view_start']);
  assert.equal(withheld.state.views[viewA]?.status, 'decided');
  if (withheld.state.views[viewA]?.status === 'decided') assert.equal(withheld.state.views[viewA].terminalEmitted, false);

  const bounded = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewB, eventId: startB, monotonicMs: 0 }) },
    { type: 'timeout', viewId: viewB, eventId: termB, occurredAt: at, monotonicMs: 0 },
    { type: 'start', ...start({ viewId: viewC, eventId: startC, monotonicMs: 0 }) },
    { type: 'failure', failureReason: 'LOAD_ERROR', viewId: viewC, eventId: termC, occurredAt: at, monotonicMs: 600_000 },
  ]);
  assert.equal(bounded.events[1] && 'durationMs' in bounded.events[1] ? bounded.events[1].durationMs : undefined, 0);
  assert.equal(bounded.events[3] && 'durationMs' in bounded.events[3] ? bounded.events[3].durationMs : undefined, 600_000);
  for (const event of bounded.events) assert.deepEqual(AnalyticsEventDTOSchema.parse(event), event);

  const unknown = applyModelEventSignal(
    reduceModelEventSignals([{ type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 0 }) }]).state,
    { type: 'failure', failureReason: 'CONTEXT_LOST' as 'LOAD_ERROR', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 8 },
  );
  assert.deepEqual(unknown.events, []);
  assert.equal(unknown.state.views[viewA]?.status, 'open');
});

test('callers can continue from the returned state without mutating the previous one', () => {
  const started = reduceModelEventSignals([{ type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 2 }) }]);
  const frozen = freeze(started.state);
  const finished = applyModelEventSignal(frozen, { type: 'timeout', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 11 });
  assert.equal(frozen.views[viewA]?.status, 'open');
  assert.deepEqual(kinds(finished.events), ['model_load_failure']);
  assert.notEqual(finished.state, frozen);
  assert.equal(finished.events[0] && 'durationMs' in finished.events[0] ? finished.events[0].durationMs : undefined, 9);
});

test('the rules module does not read the DOM, environment, cookies, or the network', () => {
  const source = readFileSync(new URL('../src/lib/analytics/model-events.ts', import.meta.url), 'utf8');
  for (const token of ['fetch(', 'process.env', 'document', 'window', 'localStorage', 'sessionStorage', 'cookie', 'XMLHttpRequest', 'performance', 'Date.now', 'new Date', 'node:fs', "from 'fs'", 'navigator', 'globalThis']) {
    assert.equal(source.includes(token), false, token);
  }
  const calls: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((...args: unknown[]) => {
    calls.push(args);
    throw new Error('network');
  }) as typeof fetch;
  const previous = process.env.ANALYTICS_TEST_SENTINEL;
  process.env.ANALYTICS_TEST_SENTINEL = '1';
  try {
    const result = reduceModelEventSignals([
      { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 1 }) },
      { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 4 },
    ]);
    assert.deepEqual(kinds(result.events), ['model_view_start', 'model_load_success']);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.ANALYTICS_TEST_SENTINEL;
    else process.env.ANALYTICS_TEST_SENTINEL = previous;
  }
});

test('an orphan terminal and a second view do not cross associations', () => {
  const orphan = reduceModelEventSignals([
    { type: 'success', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 10 },
  ]);
  assert.deepEqual(orphan.events, []);
  assert.equal(orphan.state.views[viewA], undefined);

  const separate = reduceModelEventSignals([
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 0, productSlug: 'blue-box', navigationId: navA }) },
    { type: 'start', ...start({ viewId: viewB, eventId: startB, monotonicMs: 2, productSlug: 'red-mailer', navigationId: navB, path: '/en/products/red-mailer' }) },
    { type: 'failure', failureReason: 'LOAD_ERROR', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 6 },
    { type: 'success', viewId: viewB, eventId: termB, occurredAt: later, monotonicMs: 5 },
  ]).events;
  const failure = separate.find((event) => event.kind === 'model_load_failure');
  const success = separate.find((event) => event.kind === 'model_load_success');
  assert.equal(failure && 'productSlug' in failure ? failure.productSlug : undefined, 'blue-box');
  assert.equal(failure && 'navigationId' in failure ? failure.navigationId : undefined, navA);
  assert.equal(success && 'productSlug' in success ? success.productSlug : undefined, 'red-mailer');
  assert.equal(success && 'navigationId' in success ? success.navigationId : undefined, navB);
  assert.equal(failure && 'durationMs' in failure ? failure.durationMs : undefined, 6);
  assert.equal(success && 'durationMs' in success ? success.durationMs : undefined, 3);
});

test('the same signals reduce twice to the same events', () => {
  const signals: ModelEventSignal[] = [
    { type: 'start', ...start({ viewId: viewA, eventId: startA, monotonicMs: 3 }) },
    { type: 'timeout', viewId: viewA, eventId: termA, occurredAt: at, monotonicMs: 13 },
  ];
  const origin = emptyModelEventRules();
  assert.deepEqual(reduceModelEventSignals(signals, origin), reduceModelEventSignals(signals, origin));
  assert.deepEqual(origin, emptyModelEventRules());
});
