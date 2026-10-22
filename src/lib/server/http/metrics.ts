import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { LocalDateSchema, NonNegativeIntSchema, PositiveIntSchema, TimezoneSchema, UtcDateTimeSchema } from '../../contracts/common';

/** 第 10 节本轮新 API。Auth.js 协议和既有 mail-queue 不在这张白名单里。 */
export const API_ROUTE_IDS = [
  'POST /api/auth-admin/enroll',
  'POST /api/auth-admin/enroll/confirm',
  'POST /api/admin/account/password',
  'POST /api/admin/account/2fa/reset',
  'POST /api/admin/users/[id]/reset-2fa',
  'GET /api/admin/account',
  'POST /api/admin/account/session/activity',
  'POST /api/admin/account/reauth',
  'PATCH /api/admin/account/login-mode',
  'GET /api/admin/account/devices',
  'POST /api/admin/account/devices/[id]/revoke',
  'POST /api/admin/account/logout-all',
  'POST /api/admin/account/recovery-authorizations',
  'POST /api/auth-admin/recovery/start',
  'POST /api/auth-admin/recovery/enroll',
  'POST /api/auth-admin/recovery/confirm',
  'POST /api/chat/session',
  'POST /api/chat/conversations',
  'GET /api/chat/conversations/[id]',
  'POST /api/chat/conversations/[id]/messages',
  'POST /api/chat/conversations/[id]/read',
  'GET /api/admin/chat/conversations',
  'GET /api/admin/chat/conversations/[id]',
  'POST /api/admin/chat/conversations/[id]/messages',
  'POST /api/admin/chat/conversations/[id]/read',
  'PATCH /api/admin/chat/conversations/[id]',
  'POST /api/analytics/consent',
  'POST /api/analytics/events',
  'GET /api/admin/settings/analytics',
  'PATCH /api/admin/settings/analytics',
  'GET /api/admin/stats',
  'POST /api/admin/cron/operations',
  'POST /api/internal/ops-report',
] as const;

export type ApiRouteId = (typeof API_ROUTE_IDS)[number];

export const ApiRouteIdSchema = z.enum(API_ROUTE_IDS);

export const ANALYTICS_SETTINGS_KEY = 'analytics.settings';

const StoredAnalyticsSettingsSchema = z.object({
  version: NonNegativeIntSchema,
  timezone: TimezoneSchema,
  timezoneRevision: PositiveIntSchema,
  changedAt: UtcDateTimeSchema,
  updatedBy: z.string().min(1).max(128).nullable(),
}).strict();

export type CounterLog = {
  timestamp: string;
  level: 'WARN';
  module: 'http';
  operation: 'api_counter';
  outcomeCode: 'counter_rejected' | 'counter_settings_unreadable' | 'counter_write_failed';
  routeId?: ApiRouteId;
  status?: number;
  errorCategory?: string;
};

export type FinalResponse<T> = {
  routeId: string;
  status: number;
  /** 原样返回给调用方。不写入计数行，也不进入日志。 */
  body: T;
};

export type RecordedResponse<T> = {
  status: number;
  body: T;
  recorded: boolean;
};

export type ApiCounterDb = Pick<PrismaClient, 'siteSetting' | '$executeRaw'>;

export type ApiCounter = {
  recordFinalResponse<T>(response: FinalResponse<T>): Promise<RecordedResponse<T>>;
};

function siteLocalDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  const label = `${year}-${month}-${day}`;
  const parsed = LocalDateSchema.safeParse(label);
  if (!parsed.success) throw new Error('site date');
  return parsed.data;
}

function isHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

function errorCategory(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(error.name)) return error.name;
  return 'Error';
}

export function createApiCounter(deps: {
  db: ApiCounterDb;
  clock?: () => Date;
  log?: (event: CounterLog) => void;
}): ApiCounter {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.log ?? ((event: CounterLog) => console.warn(JSON.stringify(event)));
  const warn = (event: Omit<CounterLog, 'timestamp' | 'level' | 'module' | 'operation'>) => {
    try {
      log({
        timestamp: new Date().toISOString(),
        level: 'WARN',
        module: 'http',
        operation: 'api_counter',
        ...event,
      });
    } catch {
      // 观测回调失败不能替换调用方的 status、body 或 recorded。
    }
  };

  return {
    async recordFinalResponse<T>(response: FinalResponse<T>): Promise<RecordedResponse<T>> {
      const kept = { status: response.status, body: response.body, recorded: false };
      const route = ApiRouteIdSchema.safeParse(response.routeId);
      if (!route.success || !isHttpStatus(response.status)) {
        warn({ outcomeCode: 'counter_rejected' });
        return kept;
      }
      try {
        const now = clock();
        const row = await deps.db.siteSetting.findUnique({ where: { key: ANALYTICS_SETTINGS_KEY } });
        const stored = row ? StoredAnalyticsSettingsSchema.safeParse(row.value) : null;
        if (row && !stored?.success) {
          warn({ outcomeCode: 'counter_settings_unreadable', routeId: route.data, status: response.status });
          return kept;
        }
        const timeZone = stored?.success ? stored.data.timezone : 'UTC';
        const timezoneRevision = stored?.success ? stored.data.timezoneRevision : 1;
        const localDate = siteLocalDate(now, timeZone);
        const errorIncrement = response.status >= 500 ? 1 : 0;
        const observedAt = now;
        await deps.db.$executeRaw(Prisma.sql`
          INSERT INTO "ApiDailyCounter" (
            "localDate", "timezoneRevision", "routeId", "requestCount", "errorCount", "lastObservedAt"
          ) VALUES (
            ${localDate}, ${timezoneRevision}, ${route.data}, 1, ${errorIncrement}, ${observedAt}::timestamptz AT TIME ZONE 'UTC'
          )
          ON CONFLICT ("localDate", "timezoneRevision", "routeId")
          DO UPDATE SET
            "requestCount" = "ApiDailyCounter"."requestCount" + 1,
            "errorCount" = "ApiDailyCounter"."errorCount" + ${errorIncrement},
            "lastObservedAt" = GREATEST("ApiDailyCounter"."lastObservedAt", ${observedAt}::timestamptz AT TIME ZONE 'UTC')
        `);
        return { status: response.status, body: response.body, recorded: true };
      } catch (error) {
        warn({
          outcomeCode: 'counter_write_failed',
          routeId: route.data,
          status: response.status,
          errorCategory: errorCategory(error),
        });
        return kept;
      }
    },
  };
}
