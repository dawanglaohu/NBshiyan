import {
  AnalyticsEventDTOSchema,
  ModelFailureReasonSchema,
  UuidSchema,
  UtcDateTimeSchema,
  type AnalyticsEventDTO,
  type ModelFailureReason,
} from '../contracts';

/**
 * Pure model-view lifecycle for one page session.
 * Callers pass every id, the wall time, and an integer clock reading.
 * M2-T7 is the browser producer and the only place that may touch consent or the network.
 */

/** Inclusive upper bound copied from the shared model terminal schema. */
export const MODEL_LOAD_DURATION_MAX_MS = 600_000;

export type ModelDisplaySurface = 'poster' | 'fold-box';
export type ModelGlbSurface = 'glb';
export type ModelLocale = 'en' | 'ru';
export type ModelTerminalKind = 'model_load_success' | 'model_load_failure';

type ClockDelta = number | 'unreadable' | 'unpublishable';

export type ModelStartInput = {
  viewId: string;
  navigationId: string;
  productSlug: string;
  locale: ModelLocale;
  path?: string;
  eventId: string;
  occurredAt: string;
  /** Injected integer clock. The rules never read a process or browser clock. */
  monotonicMs: number;
  surface?: ModelGlbSurface | ModelDisplaySurface;
};

export type ModelTerminalInput = {
  viewId: string;
  eventId: string;
  occurredAt: string;
  monotonicMs: number;
  surface?: ModelGlbSurface | ModelDisplaySurface;
};

export type ModelEventSignal =
  | { type: 'visit' }
  | { type: 'display'; surface: ModelDisplaySurface; outcome?: 'success' | 'failure' | 'timeout'; viewId?: string }
  | ({ type: 'start' } & ModelStartInput)
  | ({ type: 'success' } & ModelTerminalInput)
  | ({ type: 'timeout' } & ModelTerminalInput)
  | ({ type: 'failure'; failureReason: ModelFailureReason } & ModelTerminalInput)
  | { type: 'cancel'; viewId: string }
  | ({ type: 'retry'; previousViewId: string } & ModelStartInput);

type PendingTerminal = {
  kind: ModelTerminalKind;
  failureReason?: ModelFailureReason;
  eventId: string;
  occurredAt: string;
  monotonicMs: number;
};

type OpenModelView = {
  status: 'open';
  viewId: string;
  navigationId: string;
  productSlug: string;
  locale: ModelLocale;
  path?: string;
  startEventId: string;
  startOccurredAt: string;
  startedAtMs: number;
};

export type DecidedModelView = OpenModelView & {
  status: 'decided';
  terminalKind: ModelTerminalKind;
  failureReason?: ModelFailureReason;
  terminalEventId: string;
  terminalOccurredAt: string;
  endedAtMs: number;
  /** False when the kind is fixed but durationMs cannot pass the shared schema. */
  terminalEmitted: boolean;
};

type CancelledModelView = {
  status: 'cancelled';
  viewId: string;
  navigationId?: string;
  productSlug?: string;
  locale?: ModelLocale;
  path?: string;
  startEventId?: string;
  startOccurredAt?: string;
  startedAtMs?: number;
};

export type ModelViewRecord = OpenModelView | DecidedModelView | CancelledModelView;

export type ModelEventRulesState = {
  views: Readonly<Record<string, ModelViewRecord>>;
  /** First terminal observed before its GLB start. A later terminal does not replace it. */
  pending: Readonly<Record<string, PendingTerminal>>;
  usedEventIds: Readonly<Record<string, true>>;
};

export type ModelEventTransition = {
  state: ModelEventRulesState;
  events: AnalyticsEventDTO[];
};

export function emptyModelEventRules(): ModelEventRulesState {
  return { views: {}, pending: {}, usedEventIds: {} };
}

export function reduceModelEventSignals(
  signals: readonly ModelEventSignal[] | null | undefined,
  state: ModelEventRulesState = emptyModelEventRules(),
): ModelEventTransition {
  if (!Array.isArray(signals) || signals.length === 0) return { state, events: [] };
  let current = state;
  const events: AnalyticsEventDTO[] = [];
  for (const signal of signals) {
    if (!signal || typeof signal !== 'object') continue;
    const step = applyModelEventSignal(current, signal);
    current = step.state;
    events.push(...step.events);
  }
  return { state: current, events };
}

export function applyModelEventSignal(state: ModelEventRulesState, signal: ModelEventSignal): ModelEventTransition {
  switch (signal.type) {
    case 'visit':
    case 'display':
      return idle(state);
    case 'start':
      return isGlbSurface(signal.surface) ? applyStart(state, signal) : idle(state);
    case 'success':
      return isGlbSurface(signal.surface) ? applyTerminal(state, 'model_load_success', undefined, signal) : idle(state);
    case 'timeout':
      return isGlbSurface(signal.surface) ? applyTerminal(state, 'model_load_failure', 'TIMEOUT', signal) : idle(state);
    case 'failure':
      return isGlbSurface(signal.surface) ? applyTerminal(state, 'model_load_failure', signal.failureReason, signal) : idle(state);
    case 'cancel':
      return applyCancel(state, signal.viewId);
    case 'retry':
      return applyRetry(state, signal);
    default:
      return idle(state);
  }
}

function idle(state: ModelEventRulesState): ModelEventTransition {
  return { state, events: [] };
}

function isGlbSurface(surface: ModelStartInput['surface']): boolean {
  return surface === undefined || surface === 'glb';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UuidSchema.safeParse(value).success;
}

function isUtc(value: unknown): value is string {
  return typeof value === 'string' && UtcDateTimeSchema.safeParse(value).success;
}

function isFailureReason(value: unknown): value is ModelFailureReason {
  return ModelFailureReasonSchema.safeParse(value).success;
}

function clockDelta(startedAtMs: number, endedAtMs: number): ClockDelta {
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(endedAtMs)) return 'unreadable';
  const duration = endedAtMs - startedAtMs;
  if (!Number.isSafeInteger(duration) || duration < 0 || duration > MODEL_LOAD_DURATION_MAX_MS) return 'unpublishable';
  return duration;
}

function remember(used: ModelEventRulesState['usedEventIds'], eventId: string): ModelEventRulesState['usedEventIds'] {
  if (used[eventId]) return used;
  return { ...used, [eventId]: true };
}

function dropPending(pending: ModelEventRulesState['pending'], viewId: string): ModelEventRulesState['pending'] {
  if (!(viewId in pending)) return pending;
  const next = { ...pending };
  delete next[viewId];
  return next;
}

function parseStart(input: ModelStartInput): Extract<AnalyticsEventDTO, { kind: 'model_view_start' }> | undefined {
  const body: Record<string, unknown> = {
    kind: 'model_view_start',
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    locale: input.locale,
    navigationId: input.navigationId,
    viewId: input.viewId,
    productSlug: input.productSlug,
  };
  if (input.path !== undefined) body.path = input.path;
  const parsed = AnalyticsEventDTOSchema.safeParse(body);
  return parsed.success && parsed.data.kind === 'model_view_start' ? parsed.data : undefined;
}

function openFrom(event: Extract<AnalyticsEventDTO, { kind: 'model_view_start' }>, monotonicMs: number): OpenModelView {
  return {
    status: 'open',
    viewId: event.viewId,
    navigationId: event.navigationId,
    productSlug: event.productSlug,
    locale: event.locale,
    ...(event.path !== undefined ? { path: event.path } : {}),
    startEventId: event.eventId,
    startOccurredAt: event.occurredAt,
    startedAtMs: monotonicMs,
  };
}

function parseTerminal(
  view: OpenModelView,
  kind: ModelTerminalKind,
  failureReason: ModelFailureReason | undefined,
  eventId: string,
  occurredAt: string,
  durationMs: number,
): AnalyticsEventDTO | undefined {
  const body: Record<string, unknown> = {
    kind,
    eventId,
    occurredAt,
    locale: view.locale,
    navigationId: view.navigationId,
    viewId: view.viewId,
    productSlug: view.productSlug,
    durationMs,
  };
  if (view.path !== undefined) body.path = view.path;
  if (kind === 'model_load_failure') body.failureReason = failureReason;
  const parsed = AnalyticsEventDTOSchema.safeParse(body);
  if (!parsed.success || parsed.data.kind !== kind) return undefined;
  return parsed.data;
}

function canStart(state: ModelEventRulesState, input: ModelStartInput): Extract<AnalyticsEventDTO, { kind: 'model_view_start' }> | undefined {
  if (!isGlbSurface(input.surface)) return undefined;
  if (state.views[input.viewId]) return undefined;
  if (!Number.isSafeInteger(input.monotonicMs)) return undefined;
  if (input.eventId in state.usedEventIds) return undefined;
  return parseStart(input);
}

function applyStart(state: ModelEventRulesState, input: ModelStartInput): ModelEventTransition {
  const startEvent = canStart(state, input);
  if (!startEvent) return idle(state);
  const open = openFrom(startEvent, input.monotonicMs);
  const used = remember(state.usedEventIds, startEvent.eventId);
  const pending = state.pending[open.viewId];
  if (!pending) {
    return {
      state: { views: { ...state.views, [open.viewId]: open }, pending: state.pending, usedEventIds: used },
      events: [startEvent],
    };
  }
  const events: AnalyticsEventDTO[] = [startEvent];
  const duration = clockDelta(open.startedAtMs, pending.monotonicMs);
  let terminalEmitted = false;
  if (typeof duration === 'number' && pending.eventId !== startEvent.eventId) {
    const terminal = parseTerminal(open, pending.kind, pending.failureReason, pending.eventId, pending.occurredAt, duration);
    if (terminal) {
      terminalEmitted = true;
      events.push(terminal);
    }
  }
  const decided = decide(open, pending.kind, pending.failureReason, pending.eventId, pending.occurredAt, pending.monotonicMs, terminalEmitted);
  return {
    state: {
      views: { ...state.views, [open.viewId]: decided },
      pending: dropPending(state.pending, open.viewId),
      usedEventIds: used,
    },
    events,
  };
}

function decide(
  open: OpenModelView,
  kind: ModelTerminalKind,
  failureReason: ModelFailureReason | undefined,
  eventId: string,
  occurredAt: string,
  endedAtMs: number,
  terminalEmitted: boolean,
): DecidedModelView {
  return {
    ...open,
    status: 'decided',
    terminalKind: kind,
    ...(kind === 'model_load_failure' && failureReason ? { failureReason } : {}),
    terminalEventId: eventId,
    terminalOccurredAt: occurredAt,
    endedAtMs,
    terminalEmitted,
  };
}

function applyTerminal(
  state: ModelEventRulesState,
  kind: ModelTerminalKind,
  failureReason: ModelFailureReason | undefined,
  input: ModelTerminalInput,
): ModelEventTransition {
  if (kind === 'model_load_failure' && !isFailureReason(failureReason)) return idle(state);
  const view = state.views[input.viewId];
  if (view?.status === 'decided' || view?.status === 'cancelled') return idle(state);
  if (!isUuid(input.eventId) || !isUtc(input.occurredAt) || input.eventId in state.usedEventIds) return idle(state);

  if (view?.status === 'open') {
    const duration = clockDelta(view.startedAtMs, input.monotonicMs);
    if (duration === 'unreadable') return idle(state);
    const emitted = typeof duration === 'number'
      ? parseTerminal(view, kind, failureReason, input.eventId, input.occurredAt, duration)
      : undefined;
    const decided = decide(view, kind, failureReason, input.eventId, input.occurredAt, input.monotonicMs, emitted !== undefined);
    return {
      state: {
        views: { ...state.views, [view.viewId]: decided },
        pending: state.pending,
        usedEventIds: remember(state.usedEventIds, input.eventId),
      },
      events: emitted ? [emitted] : [],
    };
  }

  if (!isUuid(input.viewId) || !Number.isSafeInteger(input.monotonicMs) || state.pending[input.viewId]) return idle(state);
  const pending: PendingTerminal = {
    kind,
    ...(kind === 'model_load_failure' && failureReason ? { failureReason } : {}),
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    monotonicMs: input.monotonicMs,
  };
  return {
    state: {
      views: state.views,
      pending: { ...state.pending, [input.viewId]: pending },
      usedEventIds: remember(state.usedEventIds, input.eventId),
    },
    events: [],
  };
}

function applyCancel(state: ModelEventRulesState, viewId: string): ModelEventTransition {
  if (!isUuid(viewId)) return idle(state);
  const view = state.views[viewId];
  if (view?.status === 'decided' || view?.status === 'cancelled') return idle(state);
  if (!view && !state.pending[viewId]) return idle(state);
  const cancelled: CancelledModelView = view?.status === 'open'
    ? { ...view, status: 'cancelled' }
    : { status: 'cancelled', viewId };
  return {
    state: {
      views: { ...state.views, [viewId]: cancelled },
      pending: dropPending(state.pending, viewId),
      usedEventIds: state.usedEventIds,
    },
    events: [],
  };
}

function applyRetry(state: ModelEventRulesState, input: ModelStartInput & { previousViewId: string }): ModelEventTransition {
  if (input.previousViewId === input.viewId) return idle(state);
  if (!canStart(state, input)) return idle(state);
  const cancelled = applyCancel(state, input.previousViewId);
  return applyStart(cancelled.state, input);
}
