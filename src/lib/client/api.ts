'use client';

import type { ZodType } from 'zod';
import {
  adaptApiError,
  type ClientApiFailure,
  type ClientAudience,
  type ClientErrorKind,
  type ClientLocale,
} from './api-errors';

export {
  adaptApiError,
  type AdaptApiErrorInput,
  type ClientApiFailure,
  type ClientAudience,
  type ClientErrorEnvelope,
  type ClientErrorKind,
  type ClientFailureAction,
  type ClientLocale,
} from './api-errors';

/** Per attempt. Backoff between attempts is separate and does not extend this deadline. */
export const CLIENT_DEADLINE_MS = 15_000;
export const MESSAGE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const RESPONSE_JSON_MAX_BYTES = 4 * 1024 * 1024;
const MAX_AUTOMATIC_WAIT_MS = 30_000;
const ACCOUNT_BYTES = 8 * 1024;
const CHAT_BYTES = 16 * 1024;
const ANALYTICS_BYTES = 32 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export type ClientTransport = (path: string, init: RequestInit) => Promise<Response>;

export type RetryPlan = {
  delaysMs: readonly number[];
  explicitReread: boolean;
};

export type ClientApiSuccess<T> = {
  ok: true;
  data: T;
  attempts: number;
};

export type ClientApiResult<T> = ClientApiSuccess<T> | ClientApiFailure;

export type RequestApiOptions<T> = {
  path: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  schema: ZodType<T>;
  signal?: AbortSignal;
  locale?: ClientLocale;
  audience?: ClientAudience;
  /** One extra replay for consent and recovery enroll only. Ignored on every other path. */
  boundedRetry?: boolean;
  transport?: ClientTransport;
};

type Attempt = {
  signal: AbortSignal;
  cause: () => 'user' | 'deadline';
  finish: () => void;
};

/**
 * Next routes one `decodeURIComponent` pass. Auth.js, cron, body caps, and the retry
 * whitelist all see that pathname, and the outgoing request uses it too.
 */
export function normalizeApiPath(input: string): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) return undefined;
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('#')) return undefined;
  if (/[\s\\\p{Cc}\p{Cf}]/u.test(input)) return undefined;
  const queryAt = input.indexOf('?');
  const pathname = queryAt === -1 ? input : input.slice(0, queryAt);
  const search = queryAt === -1 ? '' : input.slice(queryAt);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return undefined;
  if (/[\\%?#\s\p{Cc}\p{Cf}]/u.test(decoded) || decoded.includes('//')) return undefined;
  if (decoded.split('/').some((part) => part === '.' || part === '..')) return undefined;
  return decoded + search;
}

function pathnameOf(path: string): string {
  return path.split(/[?#]/, 1)[0];
}

/** Auth.js keeps CSRF, sign-in, and sign-out. `/api/auth-admin` is not this family. */
export function isAuthJsPath(path: string): boolean {
  const normalized = normalizeApiPath(path);
  if (!normalized) return false;
  const pathname = pathnameOf(normalized);
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

function isCronPath(pathname: string): boolean {
  return pathname === '/api/admin/cron' || pathname.startsWith('/api/admin/cron/');
}

function isChatMessagePost(pathname: string): boolean {
  return pathname === '/api/chat/conversations'
    || /^\/api\/(?:admin\/)?chat\/conversations\/[^/]+\/messages$/.test(pathname);
}

function isChatReadPost(pathname: string): boolean {
  return /^\/api\/(?:admin\/)?chat\/conversations\/[^/]+\/read$/.test(pathname);
}

function requestCap(pathname: string): number {
  if (pathname === '/api/analytics' || pathname.startsWith('/api/analytics/')) return ANALYTICS_BYTES;
  if (
    pathname === '/api/chat' || pathname.startsWith('/api/chat/')
    || pathname === '/api/admin/chat' || pathname.startsWith('/api/admin/chat/')
  ) return CHAT_BYTES;
  return ACCOUNT_BYTES;
}

/**
 * Path policy wins over the caller flag.
 * Chat messages, chat reads, and analytics events replay the same bytes at 1s/2s/4s, at most 3 times.
 * Safe GET and HEAD are marked for an explicit re-read and are not looped here.
 * Cron is not retryable. Consent and recovery enroll replay once only when boundedRetry is true.
 * Ops reports replay once. Every other write, including reauth and recovery start/confirm, does not replay.
 */
export function retryPlanFor(method: string, path: string, boundedRetry = false): RetryPlan {
  const normalized = normalizeApiPath(path);
  if (!normalized || isAuthJsPath(normalized)) return { delaysMs: [], explicitReread: false };
  const verb = method.toUpperCase();
  const pathname = pathnameOf(normalized);
  if (verb === 'GET' || verb === 'HEAD') {
    if (isCronPath(pathname)) return { delaysMs: [], explicitReread: false };
    return { delaysMs: [], explicitReread: true };
  }
  if (verb === 'POST' && (isChatMessagePost(pathname) || isChatReadPost(pathname) || pathname === '/api/analytics/events')) {
    return { delaysMs: MESSAGE_RETRY_DELAYS_MS, explicitReread: true };
  }
  if (boundedRetry && verb === 'POST' && (pathname === '/api/analytics/consent' || pathname === '/api/auth-admin/recovery/enroll')) {
    return { delaysMs: [0], explicitReread: false };
  }
  if (verb === 'POST' && pathname === '/api/internal/ops-report') {
    return { delaysMs: [0], explicitReread: false };
  }
  return { delaysMs: [], explicitReread: false };
}

function encodeBody(body: unknown): { ok: true; raw: string } | { ok: false } {
  if (body === null || typeof body !== 'object') return { ok: false };
  try {
    const raw = JSON.stringify(body);
    if (typeof raw !== 'string') return { ok: false };
    return { ok: true, raw };
  } catch {
    return { ok: false };
  }
}

function openAttempt(caller: AbortSignal | undefined): Attempt {
  const controller = new AbortController();
  let cause: 'user' | 'deadline' = 'deadline';
  const markUser = () => {
    cause = 'user';
    if (!controller.signal.aborted) controller.abort();
  };
  if (caller?.aborted) markUser();
  else caller?.addEventListener('abort', markUser, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, CLIENT_DEADLINE_MS);
  return {
    signal: controller.signal,
    cause: () => (caller?.aborted || cause === 'user' ? 'user' : 'deadline'),
    finish: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', markUser);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function thrownKind(error: unknown, attempt: Attempt, caller: AbortSignal | undefined): 'cancelled' | 'timeout' | 'network' {
  const aborted = isAbortError(error) || attempt.signal.aborted;
  if (aborted && (caller?.aborted || attempt.cause() === 'user')) return 'cancelled';
  if (aborted) return 'timeout';
  return 'network';
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readCapped(response: Response): Promise<{ kind: 'json'; json: unknown } | { kind: 'oversize' }> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > RESPONSE_JSON_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'oversize' };
  }
  if (!response.body) return { kind: 'json', json: undefined };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > RESPONSE_JSON_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'oversize' };
      }
      chunks.push(step.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (total === 0) return { kind: 'json', json: undefined };
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(concatBytes(chunks, total));
    return { kind: 'json', json: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'json', json: undefined };
  }
}

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

/** 401/403/404/409 and every other finished non-replay status stay closed if the body then drops. */
function headerForbidsReplay(status: number): boolean {
  if (status === 408 || status === 429) return false;
  if (status >= 500 && status <= 599) return false;
  return status >= 400 && status <= 499;
}

function applyPlan(failure: ClientApiFailure, plan: RetryPlan, transient: boolean): ClientApiFailure {
  const retryable = transient && plan.explicitReread;
  const action = failure.action === 'retry' && !plan.explicitReread ? 'stop' : failure.action;
  return { ...failure, retryable, action, transient };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(signal?.aborted !== true);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const sameOriginFetch: ClientTransport = (path, init) => fetch(path, init);

export async function requestApi<T>(options: RequestApiOptions<T>): Promise<ClientApiResult<T>> {
  const locale: ClientLocale = options.locale === 'ru' ? 'ru' : 'en';
  const audience = options.audience ?? 'visitor';
  const method = (options.method ?? 'GET').toUpperCase();
  const transport = options.transport ?? sameOriginFetch;
  const boundedRetry = options.boundedRetry === true;
  const path = normalizeApiPath(options.path);
  const base = { locale, audience, attempts: 0 };
  if (!path || !METHODS.has(method)) return adaptApiError({ ...base, kind: 'rejected' });
  if (isAuthJsPath(path)) return adaptApiError({ ...base, kind: 'auth-protocol' });

  let raw: string | undefined;
  if (options.body !== undefined) {
    if (method === 'GET' || method === 'HEAD') return adaptApiError({ ...base, kind: 'rejected' });
    const encoded = encodeBody(options.body);
    if (!encoded.ok) return adaptApiError({ ...base, kind: 'rejected' });
    if (new TextEncoder().encode(encoded.raw).byteLength > requestCap(pathnameOf(path))) {
      return adaptApiError({ ...base, kind: 'oversize' });
    }
    raw = encoded.raw;
  }

  const plan = retryPlanFor(method, path, boundedRetry);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (raw !== undefined) headers['Content-Type'] = 'application/json';
  let sends = 0;

  while (true) {
    if (options.signal?.aborted) return adaptApiError({ kind: 'cancelled', locale, audience, attempts: sends });
    const attempt = openAttempt(options.signal);
    let response: Response;
    try {
      response = await transport(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers,
        body: raw,
        signal: attempt.signal,
      });
    } catch (error) {
      attempt.finish();
      sends += 1;
      const kind = thrownKind(error, attempt, options.signal);
      const stopped = await settle(kind, undefined, undefined, sends);
      if (stopped) return stopped;
      continue;
    }

    let read: { kind: 'json'; json: unknown } | { kind: 'oversize' };
    try {
      read = await readCapped(response);
    } catch (error) {
      attempt.finish();
      sends += 1;
      const kind = thrownKind(error, attempt, options.signal);
      if (kind === 'cancelled') return adaptApiError({ kind: 'cancelled', locale, audience, attempts: sends });
      const status = response.status;
      const retryAfter = retryAfterMs(response.headers.get('retry-after'), Date.now());
      if (headerForbidsReplay(status)) {
        return applyPlan(adaptApiError({
          kind: 'http',
          status,
          locale,
          audience,
          attempts: sends,
          retryAfterMs: retryAfter,
        }), plan, false);
      }
      if (status === 429) {
        const failure = adaptApiError({
          kind: 'http',
          status,
          locale,
          audience,
          attempts: sends,
          retryAfterMs: retryAfter,
        });
        const stopped = await settle('http', status, failure, sends);
        if (stopped) return stopped;
        continue;
      }
      const stopped = await settle(kind, status, undefined, sends);
      if (stopped) return stopped;
      continue;
    }
    attempt.finish();
    sends += 1;

    if (read.kind === 'oversize') {
      return applyPlan(adaptApiError({
        kind: 'oversize',
        status: response.status,
        locale,
        audience,
        attempts: sends,
      }), plan, false);
    }

    const retryAfter = retryAfterMs(response.headers.get('retry-after'), Date.now());
    if (response.status >= 200 && response.status < 300) {
      const parsed = options.schema.safeParse(read.json);
      if (parsed.success) return { ok: true, data: parsed.data, attempts: sends };
    }
    const failure = adaptApiError({
      kind: 'http',
      status: response.status,
      body: read.json,
      locale,
      audience,
      attempts: sends,
      retryAfterMs: retryAfter,
    });
    const stopped = await settle('http', response.status, failure, sends);
    if (stopped) return stopped;
  }

  async function settle(
    kind: ClientErrorKind | 'http',
    status: number | undefined,
    ready: ClientApiFailure | undefined,
    attempts: number,
  ): Promise<ClientApiResult<T> | undefined> {
    const failure = ready ?? adaptApiError({
      kind: kind === 'http' ? 'network' : kind,
      status,
      locale,
      audience,
      attempts,
    });
    const transient = failure.transient && failure.action !== 'silent';
    const retriesLeft = transient && attempts <= plan.delaysMs.length && plan.delaysMs.length > 0;
    if (!retriesLeft || options.signal?.aborted) {
      if (options.signal?.aborted && failure.action !== 'silent') {
        return adaptApiError({ kind: 'cancelled', locale, audience, attempts });
      }
      return applyPlan(failure, plan, failure.transient);
    }
    const delay = plan.delaysMs[attempts - 1] ?? 0;
    const wait = Math.max(delay, failure.retryAfterMs ?? 0);
    if (wait > MAX_AUTOMATIC_WAIT_MS) return applyPlan(failure, plan, failure.transient);
    const continued = await sleep(wait, options.signal);
    if (!continued) return adaptApiError({ kind: 'cancelled', locale, audience, attempts });
    return undefined;
  }
}
