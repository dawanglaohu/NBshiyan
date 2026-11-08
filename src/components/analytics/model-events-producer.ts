'use client';

import {
  applyModelEventSignal,
  emptyModelEventRules,
  type ModelEventRulesState,
  type ModelEventSignal,
} from '@/lib/analytics/model-events';
import {
  AnalyticsEventDTOSchema,
  type AnalyticsEventDTO,
  type ModelFailureReason,
} from '@/lib/contracts/analytics';
import { onConsent } from '@/lib/consent';
import { canCollectAnalytics, currentNavigation, enqueueAnalyticsEvents } from '@/lib/client/analytics';

/**
 * M2-T7 browser producer: the only bridge between the real GLB lifecycle and the shared
 * analytics queue. M2-T4 owns the pure transitions; this module owns the page session,
 * the injected monotonic clock, and the consent gate (E-42, E-46, E-103).
 *
 * Every identifier below is created after `canCollectAnalytics()` and a navigation
 * context exist, so a visitor who has not allowed analytics never gets a viewId.
 */

/** A GLB attempt that has not settled by then is a TIMEOUT failure (E-63). */
export const MODEL_LOAD_TIMEOUT_MS = 30_000;

type OpenAttempt = { viewId: string; attempt: number };

let state: ModelEventRulesState = emptyModelEventRules();
const open = new Map<string, OpenAttempt>();
const lastViewId = new Map<string, string>();
/** product_view is one row per navigation+product, even if the card retries. */
const productViews = new Set<string>();
let watchingConsent = false;

const uuid = () => crypto.randomUUID();
const clock = () => Math.round(performance.now());
const stamp = () => new Date().toISOString();

function resetSession(): void {
  state = emptyModelEventRules();
  open.clear();
  lastViewId.clear();
  productViews.clear();
}

function watchConsent(): void {
  if (watchingConsent || typeof window === 'undefined') return;
  watchingConsent = true;
  onConsent((consent) => {
    if (!consent || consent.analytics !== true) resetSession();
  });
}

function send(signal: ModelEventSignal): void {
  const step = applyModelEventSignal(state, signal);
  state = step.state;
  if (step.events.length > 0) enqueueAnalyticsEvents(step.events);
}

function emitProductView(
  navigationId: string,
  path: string,
  locale: 'en' | 'ru',
  slug: string,
  occurredAt: string,
): void {
  const key = `${navigationId}|${slug}`;
  if (productViews.has(key)) return;
  productViews.add(key);
  if (productViews.size > 500) productViews.clear();
  const parsed = AnalyticsEventDTOSchema.safeParse({
    kind: 'product_view',
    eventId: uuid(),
    occurredAt,
    locale,
    navigationId,
    productSlug: slug,
    path,
  });
  if (parsed.success) enqueueAnalyticsEvents([parsed.data as AnalyticsEventDTO]);
}

/**
 * Record a real GLB attempt. Returns true only when an event was actually queued,
 * so the caller knows whether to arm its own UI timeout.
 */
export function noteModelStart(slug: string, attempt: number): boolean {
  if (typeof window === 'undefined' || !canCollectAnalytics()) return false;
  const nav = currentNavigation();
  if (!nav) return false;
  watchConsent();
  const current = open.get(slug);
  if (current?.attempt === attempt) return false;
  if (current) {
    send({ type: 'cancel', viewId: current.viewId });
    open.delete(slug);
  }
  const viewId = uuid();
  const occurredAt = stamp();
  const base = {
    viewId,
    navigationId: nav.navigationId,
    productSlug: slug,
    locale: nav.locale,
    path: nav.path,
    eventId: uuid(),
    occurredAt,
    monotonicMs: clock(),
    surface: 'glb' as const,
  };
  emitProductView(nav.navigationId, nav.path, nav.locale, slug, occurredAt);
  const previous = lastViewId.get(slug);
  send(previous ? { type: 'retry', previousViewId: previous, ...base } : { type: 'start', ...base });
  lastViewId.set(slug, viewId);
  open.set(slug, { viewId, attempt });
  return true;
}

/** A real GLB finished loading (the model component mounted), not a poster or FoldBox. */
export function noteModelSuccess(slug: string): void {
  const attempt = open.get(slug);
  if (!attempt) return;
  open.delete(slug);
  if (!canCollectAnalytics()) return;
  send({ type: 'success', viewId: attempt.viewId, eventId: uuid(), occurredAt: stamp(), monotonicMs: clock(), surface: 'glb' });
}

/** A real GLB attempt failed (download/parse/WebGL/context). */
export function noteModelFailure(slug: string, reason: ModelFailureReason): void {
  const attempt = open.get(slug);
  if (!attempt) return;
  open.delete(slug);
  if (!canCollectAnalytics()) return;
  send({ type: 'failure', failureReason: reason, viewId: attempt.viewId, eventId: uuid(), occurredAt: stamp(), monotonicMs: clock(), surface: 'glb' });
}

/** No terminal by MODEL_LOAD_TIMEOUT_MS. E-63 records this as a TIMEOUT failure. */
export function noteModelTimeout(slug: string): void {
  const attempt = open.get(slug);
  if (!attempt) return;
  open.delete(slug);
  if (!canCollectAnalytics()) return;
  send({ type: 'timeout', viewId: attempt.viewId, eventId: uuid(), occurredAt: stamp(), monotonicMs: clock(), surface: 'glb' });
}

/** Abandon an unresolved attempt without writing a terminal (card switch, route change). */
export function noteModelCancel(slug: string): void {
  const attempt = open.get(slug);
  if (!attempt) return;
  open.delete(slug);
  send({ type: 'cancel', viewId: attempt.viewId });
}

export function cancelAllModelAttempts(): void {
  for (const slug of [...open.keys()]) noteModelCancel(slug);
}
