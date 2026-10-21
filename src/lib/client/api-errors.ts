import { UuidSchema } from '../contracts/common';
import {
  AppErrorCodeSchema,
  FieldErrorSchema,
  type AppErrorCode,
  type FieldError,
} from '../contracts/errors';

export type ClientLocale = 'en' | 'ru';
export type ClientAudience = 'admin' | 'recovery' | 'visitor';
export type ClientFailureAction =
  | 'silent'
  | 'unconfirmed'
  | 'login'
  | 'reauthenticate'
  | 'inline'
  | 'stop'
  | 'wait'
  | 'retry';
export type ClientErrorEnvelope = 'app' | 'legacy' | 'auth-unchanged' | 'unavailable';
export type ClientErrorKind =
  | 'http'
  | 'timeout'
  | 'network'
  | 'cancelled'
  | 'auth-protocol'
  | 'rejected'
  | 'oversize';

export type ClientApiFailure = {
  ok: false;
  text: string;
  action: ClientFailureAction;
  envelope: ClientErrorEnvelope;
  code?: string;
  status?: number;
  requestId?: string;
  fieldErrors?: FieldError;
  retryAfterMs?: number;
  retryable: boolean;
  attempts: number;
  transient: boolean;
};

const FIELD_KEYS = Object.keys(FieldErrorSchema.shape);
const LEGACY_CODE = /^[a-z][a-z0-9_]{0,79}$/;

const COPY: Record<AppErrorCode, { en: string; ru: string }> = {
  invalid: { en: 'Check the highlighted fields.', ru: 'Проверьте отмеченные поля.' },
  too_large: { en: 'That submission is too large to send.', ru: 'Данные слишком большие.' },
  unauthorized: { en: 'This session is no longer valid.', ru: 'Сессия больше не действует.' },
  account_disabled: { en: 'This account is disabled.', ru: 'Аккаунт отключён.' },
  forbidden: { en: "You don't have access to this area.", ru: 'Недостаточно прав.' },
  forbidden_origin: { en: 'This page cannot send that request.', ru: 'Эта страница не может отправить запрос.' },
  not_found: { en: 'That item is unavailable.', ru: 'Элемент недоступен.' },
  rate_limited: { en: 'Wait before trying again.', ru: 'Подождите перед повтором.' },
  version_conflict: { en: 'Settings changed. Review the latest values.', ru: 'Данные уже изменились. Проверьте последнюю версию и отправьте снова.' },
  idempotency_conflict: { en: 'This identifier was already used for different content.', ru: 'Этот идентификатор уже использован для другого содержимого.' },
  conversation_closed: { en: 'This conversation is closed.', ru: 'Этот разговор закрыт.' },
  conversation_anonymized: { en: 'This conversation is no longer available.', ru: 'Этот разговор больше недоступен.' },
  analytics_consent_required: { en: 'Analytics stays off.', ru: 'Аналитика выключена.' },
  event_time_out_of_range: { en: 'That event time was not accepted.', ru: 'Время события не принято.' },
  action_grant_invalid: { en: 'Verify your identity again.', ru: 'Подтвердите, что это вы.' },
  bad_credentials: { en: 'The details were not accepted.', ru: 'Данные не приняты.' },
  recovery_expired: { en: 'This recovery session has expired.', ru: 'Срок восстановления истёк.' },
  job_busy: { en: 'That job is already running.', ru: 'Это задание уже выполняется.' },
  source_unavailable: { en: 'A required source is unavailable.', ru: 'Нужный источник недоступен.' },
  service_unavailable: { en: 'The service is temporarily unavailable.', ru: 'Сервис временно недоступен.' },
  internal_error: { en: 'Something went wrong.', ru: 'Произошла ошибка.' },
};

const UNCONFIRMED = {
  en: "The result couldn't be confirmed.",
  ru: 'Результат не удалось подтвердить.',
};
const REJECTED = { en: 'The request was rejected.', ru: 'Запрос отклонен.' };
const AUTH_UNCHANGED = {
  en: 'Sign-in stays on its existing form.',
  ru: 'Вход остаётся в прежней форме.',
};
const ADMIN_UNAUTHORIZED = {
  en: 'Your session has ended. Sign in again to continue.',
  ru: 'Сессия закончилась. Войдите снова.',
};
const INTERNAL = { en: 'Something went wrong.', ru: 'Произошла ошибка.' };

export type AdaptApiErrorInput = {
  kind: ClientErrorKind;
  status?: number;
  body?: unknown;
  locale?: ClientLocale;
  audience?: ClientAudience;
  attempts?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  transient?: boolean;
};

function isAppCode(value: string): value is AppErrorCode {
  return AppErrorCodeSchema.safeParse(value).success;
}

function pick(locale: ClientLocale, row: { en: string; ru: string }): string {
  return locale === 'ru' ? row.ru : row.en;
}

/** Keep only keys and messages FieldErrorSchema accepts. Unknown keys and exception text are dropped. */
export function controlledFieldErrors(value: unknown): FieldError | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const picked: Record<string, string> = {};
  for (const key of FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const candidate = source[key];
    if (typeof candidate !== 'string') continue;
    const parsed = FieldErrorSchema.safeParse({ [key]: candidate });
    const message = parsed.success ? parsed.data[key as keyof FieldError] : undefined;
    if (typeof message === 'string') picked[key] = message;
  }
  if (Object.keys(picked).length === 0) return undefined;
  return picked as FieldError;
}

function readErrorBody(body: unknown): { code?: string; requestId?: string; fieldErrors?: FieldError } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const code = typeof record.error === 'string' ? record.error : undefined;
  const requestId = typeof record.requestId === 'string' && UuidSchema.safeParse(record.requestId).success
    ? record.requestId
    : undefined;
  return { code, requestId, fieldErrors: controlledFieldErrors(record.fieldErrors) };
}

function transientFor(kind: ClientErrorKind, status: number | undefined): boolean {
  if (kind === 'timeout' || kind === 'network') return true;
  if (kind !== 'http' || status === undefined) return false;
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function actionFor(
  kind: ClientErrorKind,
  status: number | undefined,
  code: string | undefined,
  audience: ClientAudience,
): ClientFailureAction {
  if (kind === 'cancelled') return 'silent';
  if (kind === 'timeout' || kind === 'network') return 'unconfirmed';
  if (kind === 'auth-protocol' || kind === 'rejected' || kind === 'oversize') return 'stop';
  if (code === 'action_grant_invalid') return 'reauthenticate';
  if (code === 'unauthorized') return audience === 'admin' ? 'login' : 'stop';
  if (code === 'invalid' || code === 'bad_credentials' || code === 'recovery_expired') return 'inline';
  if (code === 'rate_limited' || status === 429) return 'wait';
  if (code === 'source_unavailable' || code === 'service_unavailable') return 'retry';
  if (code === 'internal_error' || status === 408 || (status !== undefined && status >= 500 && status <= 599)) return 'retry';
  return 'stop';
}

function sentence(
  kind: ClientErrorKind,
  status: number | undefined,
  code: string | undefined,
  locale: ClientLocale,
  audience: ClientAudience,
): string {
  if (kind === 'cancelled') return '';
  if (kind === 'timeout' || kind === 'network') return pick(locale, UNCONFIRMED);
  if (kind === 'auth-protocol') return pick(locale, AUTH_UNCHANGED);
  if (code === 'unauthorized' && audience === 'admin') return pick(locale, ADMIN_UNAUTHORIZED);
  if (code && isAppCode(code)) return pick(locale, COPY[code]);
  if (kind === 'http' && (status === undefined || (status >= 200 && status < 300) || status >= 500)) return pick(locale, INTERNAL);
  return pick(locale, REJECTED);
}

/**
 * Normalize a new `{error,requestId,fieldErrors?}` body or a legacy `{error}` body.
 * Extra keys such as message and stack never become user text.
 */
export function adaptApiError(input: AdaptApiErrorInput): ClientApiFailure {
  const locale = input.locale === 'ru' ? 'ru' : 'en';
  const audience = input.audience ?? 'visitor';
  const attempts = input.attempts ?? 0;
  const transient = input.transient ?? transientFor(input.kind, input.status);
  const read = input.kind === 'http' ? readErrorBody(input.body) : {};
  const providedCode = read.code;
  const requestId = read.requestId;
  const app = input.kind === 'http' && providedCode !== undefined && isAppCode(providedCode) && requestId !== undefined;
  const legacy = input.kind === 'http' && !app && providedCode !== undefined && LEGACY_CODE.test(providedCode);
  let envelope: ClientErrorEnvelope;
  let code: string | undefined;
  if (input.kind === 'auth-protocol') {
    envelope = 'auth-unchanged';
  } else if (input.kind === 'oversize') {
    envelope = 'unavailable';
    code = 'too_large';
  } else if (app && providedCode) {
    envelope = 'app';
    code = providedCode;
  } else if (legacy && providedCode) {
    envelope = 'legacy';
    code = providedCode;
  } else {
    envelope = 'unavailable';
  }
  const fieldErrors = envelope === 'app' || envelope === 'legacy' ? read.fieldErrors : undefined;
  let text = sentence(input.kind, input.status, code, locale, audience);
  if (text && envelope === 'app' && requestId) {
    text = `${text} ${locale === 'ru' ? 'Номер' : 'Reference'}: ${requestId}`;
  }
  const failure: ClientApiFailure = {
    ok: false,
    text,
    action: actionFor(input.kind, input.status, code, audience),
    envelope,
    retryable: input.retryable ?? false,
    attempts,
    transient,
  };
  if (code !== undefined) failure.code = code;
  if (input.status !== undefined) failure.status = input.status;
  if (envelope === 'app' && requestId) failure.requestId = requestId;
  if (fieldErrors) failure.fieldErrors = fieldErrors;
  if (input.retryAfterMs !== undefined) failure.retryAfterMs = input.retryAfterMs;
  return failure;
}
