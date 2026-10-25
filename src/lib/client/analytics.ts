import { categoryMeta } from '@/lib/seo/categoryMeta';
import { products } from '@/data/products';
import { requestApi } from '@/lib/client/api';
import {
  AnalyticsEventDTOSchema,
  AnalyticsReceiptDTOSchema,
  ConsentDTOSchema,
  type AnalyticsEventDTO,
} from '@/lib/contracts/analytics';
import { SitePathSchema } from '@/lib/contracts/common';
import { CONSENT_VERSION, getConsent } from '@/lib/consent';

const PRODUCT_KEYS = new Set(products.map((product) => product.slug));
const MAX_BATCH = 20;

type Locale = 'en' | 'ru';

let locale: Locale = 'en';
let collecting = false;
let grantConfirmed = false;
let generation = 0;
let queue: AnalyticsEventDTO[] = [];
let flushAbort: AbortController | null = null;
let flushing = false;
let flushAgain = false;
let flightWant: boolean | null = null;
let nextIntent: boolean | null = null;
let opened = false;
let listening = false;

function syncMarks(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.analyticsQueue = String(queue.length);
  root.dataset.analyticsCollecting = collecting ? 'true' : 'false';
}

function ensureOnlineListener(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('online', () => {
    if (collecting && queue.length > 0) void flush();
  });
}

/** Stop collection, drop the memory queue, and abort an in-flight event batch. */
export function stopCollection(): void {
  generation += 1;
  queue = [];
  collecting = false;
  grantConfirmed = false;
  flushAbort?.abort();
  flushAbort = null;
  syncMarks();
}

function remember(events: AnalyticsEventDTO[]): void {
  for (const event of events) {
    if (queue.some((item) => item.eventId === event.eventId)) continue;
    queue.push(event);
  }
  if (queue.length > MAX_BATCH) queue.splice(0, queue.length - MAX_BATCH);
  syncMarks();
}

async function flushOnce(): Promise<void> {
  if (!collecting || queue.length === 0) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const batch = queue.slice(0, MAX_BATCH);
  const gen = generation;
  const before = queue.length;
  const controller = new AbortController();
  flushAbort = controller;
  const result = await requestApi({
    path: '/api/analytics/events',
    method: 'POST',
    body: { events: batch },
    schema: AnalyticsReceiptDTOSchema,
    signal: controller.signal,
    locale,
    audience: 'visitor',
  });
  if (flushAbort === controller) flushAbort = null;
  if (gen !== generation || !collecting) return;
  if (!result.ok) {
    if (result.status === 403 || result.code === 'analytics_consent_required') stopCollection();
    return;
  }
  const done = new Set([...result.data.acceptedIds, ...result.data.duplicateIds]);
  queue = queue.filter((item) => !done.has(item.eventId));
  syncMarks();
  if (queue.length > 0 && queue.length < before) flushAgain = true;
}

async function flush(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      await flushOnce();
    } while (flushAgain && collecting && queue.length > 0);
  } finally {
    flushing = false;
  }
}

function scheduleFlush(): void {
  queueMicrotask(() => { void flush(); });
}

export function sitePath(value: Locale, pathname: string): string {
  if (!pathname || pathname === '/') return `/${value}`;
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `/${value}${path}`;
}

/** Map a locale-stripped pathname to the internal product key, never a URL slug. */
export function internalProductSlug(value: Locale, pathname: string): string | null {
  const match = /^\/products\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let segment = match[1];
  try { segment = decodeURIComponent(segment); } catch { return null; }
  if (PRODUCT_KEYS.has(segment)) return segment;
  const row = categoryMeta.find((item) => item[value].slug === segment);
  if (!row || !PRODUCT_KEYS.has(row.key)) return null;
  return row.key;
}

function emit(pathname: string, value: Locale): void {
  if (!collecting) return;
  const path = SitePathSchema.safeParse(sitePath(value, pathname));
  if (!path.success) return;
  const navigationId = crypto.randomUUID();
  const occurredAt = new Date().toISOString();
  const page = AnalyticsEventDTOSchema.safeParse({
    kind: 'page_view',
    eventId: crypto.randomUUID(),
    occurredAt,
    locale: value,
    navigationId,
    path: path.data,
  });
  const events: AnalyticsEventDTO[] = [];
  if (page.success) events.push(page.data);
  const productSlug = internalProductSlug(value, pathname);
  if (productSlug) {
    const product = AnalyticsEventDTOSchema.safeParse({
      kind: 'product_view',
      eventId: crypto.randomUUID(),
      occurredAt,
      locale: value,
      navigationId,
      productSlug,
      path: path.data,
    });
    if (product.success) events.push(product.data);
  }
  if (events.length === 0) return;
  remember(events);
  scheduleFlush();
}

/**
 * First call in a document is the load. A stored analytics allow resumes
 * collection and emits that page view; a 403 from the event batch stops it.
 * Later pathname changes emit only while collection is on.
 */
export function noteNavigation(pathname: string, value: Locale): void {
  locale = value;
  ensureOnlineListener();
  const first = !opened;
  opened = true;
  if (first) {
    if (getConsent()?.analytics === true) {
      collecting = true;
      syncMarks();
      emit(pathname, value);
    }
    return;
  }
  if (!collecting) return;
  emit(pathname, value);
}

async function postConsent(want: boolean, boundedRetry: boolean): Promise<void> {
  const gen = generation;
  const result = await requestApi({
    path: '/api/analytics/consent',
    method: 'POST',
    body: { analytics: want, consentVersion: CONSENT_VERSION },
    schema: ConsentDTOSchema,
    locale,
    audience: 'visitor',
    boundedRetry,
  });
  if (gen !== generation || nextIntent !== null) return;
  if (!want) return;
  if (result.ok && result.data.analytics === true) {
    grantConfirmed = true;
    collecting = true;
    syncMarks();
    return;
  }
  grantConfirmed = false;
  collecting = false;
  queue = [];
  syncMarks();
}

function pump(): void {
  if (flightWant !== null || nextIntent === null) return;
  const want = nextIntent;
  nextIntent = null;
  const boundedRetry = want && grantConfirmed;
  flightWant = want;
  void postConsent(want, boundedRetry).finally(() => {
    flightWant = null;
    pump();
  });
}

/** Serialize consent writes. A false choice stops collection before its request is sent. */
export function publishConsentChoice(analytics: boolean): void {
  ensureOnlineListener();
  if (!analytics) {
    stopCollection();
    // A false write is already in flight. Drop a queued allow so its response cannot start collection.
    if (flightWant === false) {
      nextIntent = null;
      return;
    }
    if (nextIntent === false) return;
    nextIntent = false;
  } else {
    nextIntent = true;
  }
  pump();
}

syncMarks();
