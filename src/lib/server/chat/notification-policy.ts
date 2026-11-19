export const CHAT_NOTIFICATION_MAX_ATTEMPTS = 4;
export const CHAT_NOTIFICATION_BACKOFF_MS = [60_000, 300_000, 1_800_000] as const;
export const CHAT_NOTIFICATION_LEASE_MS = 40_000;
export const CHAT_SMTP_DEADLINE_MS = 20_000;
export const CHAT_SMTP_SOCKET_IDLE_MS = 21_000;
export const CHAT_ROW_CLAIM_MAX_MS = 3_000;
export const CHAT_ROW_START_MAX_MS = 3_000;
export const CHAT_ROW_FINISH_MAX_MS = 5_000;
export const CHAT_JOB_FINISH_RESERVE_MS = 3_000;
const CHAT_DISPATCH_MARGIN_MS = 1_000;
export const CHAT_NOTIFICATION_STOP_RESERVE_MS = CHAT_ROW_CLAIM_MAX_MS + CHAT_ROW_START_MAX_MS
  + CHAT_SMTP_DEADLINE_MS + CHAT_ROW_FINISH_MAX_MS + CHAT_JOB_FINISH_RESERVE_MS + CHAT_DISPATCH_MARGIN_MS;
export const CHAT_NOTIFICATION_MAINTENANCE_LIMIT = 25;
export const CHAT_NOTIFICATION_DEFAULT_LIMIT = 25;
export const CHAT_NOTIFICATION_JOB_KEY = 'chat-notifications' as const;

export const CHAT_NOTIFICATION_HOOK_KEYS = [
  'CHAT_NOTIFICATION_TEST_PAUSE_AFTER_ACCEPT',
  'CHAT_NOTIFICATION_TEST_BACKOFF_SCALE',
] as const;
export type NotificationEnv = Record<string, string | undefined>;
export type NotificationHooks = { pauseAfterAccept: boolean; backoffScale: number };

/** Build-time gate is a direct access so production bundles can remove the active branch. */
export function notificationTestHooks(env: NotificationEnv = process.env): NotificationHooks {
  if (process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD !== '1') return { pauseAfterAccept: false, backoffScale: 1 };
  if (env.APP_ENV !== 'test') return { pauseAfterAccept: false, backoffScale: 1 };
  const pause = env[CHAT_NOTIFICATION_HOOK_KEYS[0]];
  const scale = env[CHAT_NOTIFICATION_HOOK_KEYS[1]];
  if (pause !== undefined && pause !== '1') return { pauseAfterAccept: false, backoffScale: 1 };
  if (scale !== undefined && (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(scale) || !(Number(scale) > 0 && Number(scale) <= 1))) {
    return { pauseAfterAccept: false, backoffScale: 1 };
  }
  return { pauseAfterAccept: pause === '1', backoffScale: scale === undefined ? 1 : Number(scale) };
}

/** Private evidence pause: no HTTP endpoint and no production branch. */
export async function pauseAfterNotificationAcceptance(signal: AbortSignal): Promise<void> {
  if (process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD !== '1') return;
  console.info('CHAT_NOTIFICATION_TEST_HOOK_ACTIVE');
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export function notificationBackoffMs(attempts: number, env: NotificationEnv = process.env): number {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= CHAT_NOTIFICATION_MAX_ATTEMPTS) throw new Error('chat_notification_backoff_invalid');
  const backoff = CHAT_NOTIFICATION_BACKOFF_MS[attempts - 1];
  if (process.env.CHAT_NOTIFICATION_TEST_HOOK_BUILD !== '1') return backoff;
  const { backoffScale } = notificationTestHooks(env);
  if (backoffScale === 1) return backoff;
  console.info('CHAT_NOTIFICATION_TEST_BACKOFF_ACTIVE');
  return backoff * backoffScale;
}

export const CHAT_NOTIFICATION_SAFE_CODES = [
  'CHAT_PRE_SEND_FAULT', 'CHAT_PRE_SEND_BUDGET', 'CHAT_LOCAL_INVALID',
  'CHAT_SMTP_TEMPORARY', 'CHAT_SMTP_UNAVAILABLE', 'CHAT_SMTP_AUTH',
  'CHAT_SMTP_TLS', 'CHAT_SMTP_RECIPIENT', 'CHAT_SMTP_REJECTED',
  'CHAT_SMTP_DEADLINE', 'CHAT_SMTP_ABORTED', 'CHAT_SMTP_UNKNOWN', 'CHAT_WORKER_UNKNOWN',
] as const;
export type NotificationErrorCode = typeof CHAT_NOTIFICATION_SAFE_CODES[number];
export type NotificationOutcome =
  | { kind: 'sent' }
  | { kind: 'retry'; code: NotificationErrorCode }
  | { kind: 'failed'; code: NotificationErrorCode }
  | { kind: 'unknown'; code: NotificationErrorCode };

export function notificationErrorCode(value: unknown): NotificationErrorCode {
  return typeof value === 'string' && (CHAT_NOTIFICATION_SAFE_CODES as readonly string[]).includes(value)
    ? value as NotificationErrorCode : 'CHAT_WORKER_UNKNOWN';
}

export class NotificationBudgetExceeded extends Error {
  constructor() { super('chat_notification_budget_exhausted'); this.name = 'NotificationBudgetExceeded'; }
}
