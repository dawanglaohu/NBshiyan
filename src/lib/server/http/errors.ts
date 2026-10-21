import { randomUUID } from 'crypto';
import {
  AppErrorCodeSchema,
  FieldErrorSchema,
  LegacyGuardErrorSchema,
  type AppErrorCode,
  type FieldError,
} from '../../contracts/errors';
import { UuidSchema } from '../../contracts/common';

const HTTP_STATUS = {
  invalid: 400,
  too_large: 413,
  unauthorized: 401,
  account_disabled: 403,
  forbidden: 403,
  forbidden_origin: 403,
  not_found: 404,
  rate_limited: 429,
  version_conflict: 409,
  idempotency_conflict: 409,
  conversation_closed: 409,
  conversation_anonymized: 409,
  analytics_consent_required: 403,
  event_time_out_of_range: 400,
  action_grant_invalid: 401,
  bad_credentials: 401,
  recovery_expired: 401,
  job_busy: 409,
  source_unavailable: 503,
  service_unavailable: 503,
  internal_error: 500,
} as const satisfies Record<AppErrorCode, number>;

export type HttpErrorBody = {
  error: AppErrorCode;
  requestId: string;
  fieldErrors?: FieldError;
};

export type MappedHttpError = {
  status: number;
  headers: Record<string, string>;
  body: HttpErrorBody;
};

export type ThrownHttp =
  | { kind: 'legacy-response'; response: Response }
  | { kind: 'legacy-body'; body: { error: string } }
  | ({ kind: 'mapped' } & MappedHttpError);

const PRIVATE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store',
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: FieldError;
  readonly retryAfterSeconds?: number;

  constructor(code: AppErrorCode, options: { fieldErrors?: FieldError; retryAfterSeconds?: number } = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    const fields = FieldErrorSchema.safeParse(options.fieldErrors ?? {});
    if (options.fieldErrors && fields.success && Object.keys(fields.data).length > 0) this.fieldErrors = fields.data;
    if (Number.isInteger(options.retryAfterSeconds) && (options.retryAfterSeconds as number) > 0) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError && AppErrorCodeSchema.safeParse(error.code).success;
}

function requestIdOf(value: string | undefined): string {
  return value && UuidSchema.safeParse(value).success ? value : randomUUID();
}

function headersFor(error: AppError): Record<string, string> {
  const headers: Record<string, string> = { ...PRIVATE_HEADERS };
  if (error.code === 'rate_limited' && error.retryAfterSeconds) headers['retry-after'] = String(error.retryAfterSeconds);
  return headers;
}

export function mapAppError(error: AppError, requestId?: string): MappedHttpError {
  const body: HttpErrorBody = { error: error.code, requestId: requestIdOf(requestId) };
  if (error.fieldErrors) body.fieldErrors = error.fieldErrors;
  return { status: HTTP_STATUS[error.code], headers: headersFor(error), body };
}

export type UnknownFailureLog = {
  timestamp: string;
  level: 'WARN';
  module: 'http';
  operation: 'map_unknown_failure';
  outcomeCode: 'internal_error';
  errorCategory: string;
};

function errorCategory(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.name)) return error.name;
  return 'Error';
}

/** 未知异常只变成 internal_error。日志只有类别，没有 message、stack 或连接串。 */
export function mapUnknownFailure(error: unknown, requestId?: string, log?: (event: UnknownFailureLog) => void): MappedHttpError {
  log?.({
    timestamp: new Date().toISOString(),
    level: 'WARN',
    module: 'http',
    operation: 'map_unknown_failure',
    outcomeCode: 'internal_error',
    errorCategory: errorCategory(error),
  });
  return {
    status: HTTP_STATUS.internal_error,
    headers: { ...PRIVATE_HEADERS },
    body: { error: 'internal_error', requestId: requestIdOf(requestId) },
  };
}

function isLegacyBody(error: unknown): error is { error: string } {
  return LegacyGuardErrorSchema.safeParse(error).success;
}

/**
 * 新 AppError 走 {error,requestId,fieldErrors?}。
 * 已经发出的 Response，以及只有 {error} 的旧守卫体，原样返回。
 */
export function classifyThrown(error: unknown, requestId?: string, log?: (event: UnknownFailureLog) => void): ThrownHttp {
  if (error instanceof Response) return { kind: 'legacy-response', response: error };
  if (isLegacyBody(error)) return { kind: 'legacy-body', body: error };
  if (isAppError(error)) return { kind: 'mapped', ...mapAppError(error, requestId) };
  return { kind: 'mapped', ...mapUnknownFailure(error, requestId, log) };
}
