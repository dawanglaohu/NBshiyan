import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { siteLocalDate } from '../../analytics/day-boundaries';
import { LocalDateSchema, TimezoneSchema } from '../../contracts/common';
import type { FieldError } from '../../contracts/errors';
import {
  StatsDTOSchema,
  StatsQuerySchema,
  type StatsCoverage,
  type StatsDTO,
  type StatsQueryDTO,
  type StatsSource,
  type StatsSourceDTO,
} from '../../contracts/ops';
import { parseAnalyticsSettingsValue } from '../analytics/settings';
import { ANALYTICS_TIMEZONE_CHANGE_ACTION } from '../analytics/settings-repo';
import { AppError, classifyThrown, type UnknownFailureLog } from '../http/errors';
import type { ApiCounter, ApiRouteId } from '../http/metrics';
import { ANALYTICS_SETTINGS_KEY, INITIAL_TIMEZONE_REVISION } from '../jobs/types';
import { hitRateLimit } from '../security';
import { toStatsSourceDTO } from './source-dto';
import { readCoreStats, selectStatsSources } from './stats-query';

export const STATS_ROUTE_ID: ApiRouteId = 'GET /api/admin/stats';
export const STATS_RATE_LIMIT = 30;
export const STATS_RATE_WINDOW_MS = 60_000;

const ALLOWED_QUERY_KEYS = new Set(['from', 'to', 'productSlug', 'timezoneRevision', 'sources']);
const SCALAR_QUERY_KEYS = ['from', 'to', 'productSlug', 'timezoneRevision'] as const;
const MAPPED_FIELD_ERRORS = new Set<keyof FieldError>(['from', 'to', 'timezoneRevision', 'sources']);
const PRIVATE_NO_STORE = 'private, no-store';

export type StatsDb = Pick<PrismaClient, '$transaction'>;

type CoreStatsResult = Awaited<ReturnType<typeof readCoreStats>>;

export type NonCoreSourceReader = (input: {
  role: Role;
  scope: CoreStatsResult['scope'];
  context: { timezone: string; timezoneRevision: number; queriedAt: string };
  now: Date;
  connected: boolean;
}) => Promise<StatsSourceDTO> | StatsSourceDTO;

export type StatsServiceDeps = {
  db?: StatsDb;
  clock?: () => Date;
  analyticsConfigured?: () => boolean;
  aggregateJobRegistered?: () => boolean;
  resolveLegacyBefore?: (timezoneRevision: number) => Promise<string | null> | string | null;
  nonCoreReaders?: Partial<Record<StatsSource, NonCoreSourceReader>>;
};

export type StatsQueryInput = {
  role: Role;
  query: StatsQueryDTO;
};

export type StatsServiceResult = {
  dto: StatsDTO;
  modelSuccessRate: { value: number | null; coverage: StatsCoverage } | null;
  scope: CoreStatsResult['scope'];
};

export type StatsService = {
  query(input: StatsQueryInput): Promise<StatsServiceResult>;
};

export type StatsAuthGate = {
  user: { id: string; role: Role };
};

export type StatsHttpServices = {
  stats: StatsService;
  apiCounter: Pick<ApiCounter, 'recordFinalResponse'>;
};

type ResolvedRevision = {
  timezone: string;
  timezoneRevision: number;
};

function isAllowedRole(role: string): role is Role {
  return role === 'ADMIN' || role === 'SALES' || role === 'EDITOR';
}

function fieldErrorFor(key: string, message: string): FieldError | undefined {
  if (!MAPPED_FIELD_ERRORS.has(key as keyof FieldError)) return undefined;
  return { [key]: message } as FieldError;
}

function mapQueryValidationIssues(issues: readonly z.ZodIssue[]): FieldError | undefined {
  const fieldErrors: Partial<Record<keyof FieldError, string>> = {};
  for (const issue of issues) {
    const first = issue.path[0];
    if (typeof first !== 'string') continue;
    if (!MAPPED_FIELD_ERRORS.has(first as keyof FieldError)) continue;
    const key = first as keyof FieldError;
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message.slice(0, 200) || 'Invalid query parameter.';
    }
  }
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
}

/**
 * Parse and strictly validate GET /api/admin/stats URL query parameters.
 * Unknown keys, duplicated scalar keys, empty `sources` segments, and invalid values reject with 400 invalid.
 */
export function parseStatsSearchParams(url: string | URL): StatsQueryDTO {
  let searchParams: URLSearchParams;
  try {
    searchParams = (url instanceof URL ? url : new URL(url)).searchParams;
  } catch {
    throw new AppError('invalid');
  }

  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new AppError('invalid');
  }

  const candidate: Record<string, unknown> = {};
  for (const key of SCALAR_QUERY_KEYS) {
    const values = searchParams.getAll(key);
    if (values.length > 1) {
      const fieldErrors = fieldErrorFor(key, 'Duplicate query parameter.');
      throw new AppError('invalid', fieldErrors ? { fieldErrors } : undefined);
    }
    if (values.length === 1) candidate[key] = values[0];
  }

  if (searchParams.has('sources')) {
    const items = searchParams.getAll('sources').flatMap((entry) => entry.split(','));
    if (items.length === 0 || items.some((item) => item.length === 0 || item.trim() !== item)) {
      throw new AppError('invalid', { fieldErrors: { sources: 'Invalid sources filter.' } });
    }
    candidate.sources = items;
  }

  const parsed = StatsQuerySchema.safeParse(candidate);
  if (!parsed.success) {
    const fieldErrors = mapQueryValidationIssues(parsed.error.issues);
    throw new AppError('invalid', fieldErrors ? { fieldErrors } : undefined);
  }
  return parsed.data;
}

function asMetaObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractAuditRevisionTimezone(rows: readonly { meta: unknown }[], requestedRevision: number): string | null {
  for (const row of rows) {
    const meta = asMetaObject(row.meta);
    if (!meta) continue;
    if (meta.timezoneRevision === requestedRevision) {
      const parsed = TimezoneSchema.safeParse(meta.timezone);
      if (parsed.success) return parsed.data;
    }
    if (meta.timezoneRevision === requestedRevision + 1) {
      const parsed = TimezoneSchema.safeParse(meta.previousTimezone);
      if (parsed.success) return parsed.data;
    }
  }
  return null;
}

/**
 * Resolve the target site timezone and revision inside a consistent RepeatableRead snapshot.
 * Historical revisions read persisted daily/state row timezones first, then timezone-change audit logs.
 */
export async function resolveStatsRevision(db: StatsDb, requestedRevision?: number): Promise<ResolvedRevision> {
  return db.$transaction(async (tx) => {
    const settingRows = await tx.$queryRaw<{ value: unknown }[]>`
      SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY}
    `;
    let current = { timezone: 'UTC', timezoneRevision: INITIAL_TIMEZONE_REVISION };
    if (settingRows.length > 0) {
      const parsed = parseAnalyticsSettingsValue(settingRows[0].value);
      if (parsed === 'corrupt') throw new AppError('service_unavailable');
      if (parsed !== null) {
        current = { timezone: parsed.timezone, timezoneRevision: parsed.timezoneRevision };
      }
    }

    if (requestedRevision === undefined || requestedRevision === current.timezoneRevision) {
      return current;
    }
    if (requestedRevision > current.timezoneRevision) {
      throw new AppError('invalid', { fieldErrors: { timezoneRevision: 'Unknown timezone revision.' } });
    }

    const rowTimezones = await tx.$queryRaw<{ timezone: string }[]>`
      SELECT DISTINCT "timezone" FROM (
        SELECT "timezone" FROM "AnalyticsAggregateDayState" WHERE "timezoneRevision" = ${requestedRevision}
        UNION
        SELECT "timezone" FROM "AnalyticsDaily" WHERE "timezoneRevision" = ${requestedRevision}
      ) t
    `;
    if (rowTimezones.length > 1) throw new AppError('service_unavailable');
    if (rowTimezones.length === 1) {
      const parsed = TimezoneSchema.safeParse(rowTimezones[0].timezone);
      if (!parsed.success) throw new AppError('service_unavailable');
      return { timezone: parsed.data, timezoneRevision: requestedRevision };
    }

    const reqText = String(requestedRevision);
    const nextText = String(requestedRevision + 1);
    const auditRows = await tx.$queryRaw<{ meta: unknown }[]>`
      SELECT "meta" FROM "AuditLog"
      WHERE "action" = ${ANALYTICS_TIMEZONE_CHANGE_ACTION}
        AND ("meta"->>'timezoneRevision' = ${reqText} OR "meta"->>'timezoneRevision' = ${nextText})
      ORDER BY "createdAt" DESC
    `;
    const auditTimezone = extractAuditRevisionTimezone(auditRows, requestedRevision);
    if (auditTimezone) {
      return { timezone: auditTimezone, timezoneRevision: requestedRevision };
    }

    throw new AppError('invalid', { fieldErrors: { timezoneRevision: 'Unknown timezone revision.' } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function resolveTrustedLegacyBefore(
  resolveLegacyBefore: StatsServiceDeps['resolveLegacyBefore'],
  revision: number,
): Promise<string | null> {
  if (!resolveLegacyBefore) return null;
  const legacyBefore = await resolveLegacyBefore(revision);
  if (legacyBefore === null) return null;
  if (!LocalDateSchema.safeParse(legacyBefore).success) throw new AppError('service_unavailable');
  return legacyBefore;
}

/** Build the role-restricted statistics query service backed by M6-T1 core aggregation reads. */
export function createStatsService(deps: StatsServiceDeps = {}): StatsService {
  const clock = deps.clock ?? (() => new Date());
  const nonCoreReaders = deps.nonCoreReaders ?? {};

  return {
    async query({ role, query }) {
      if (!deps.db) throw new Error('StatsService requires db');
      if (!isAllowedRole(role)) throw new AppError('forbidden');

      // Trim sources by RBAC before checking revisions or querying any table.
      const allowedSources = selectStatsSources(role, query.sources);
      const now = clock();
      const targetRevision = await resolveStatsRevision(deps.db, query.timezoneRevision);
      // Validate IANA timezone bounds at the active query timestamp.
      siteLocalDate(now, targetRevision.timezone);
      const legacyBefore = await resolveTrustedLegacyBefore(deps.resolveLegacyBefore, targetRevision.timezoneRevision);
      const connected = Boolean(
        (deps.analyticsConfigured?.() ?? false) && (deps.aggregateJobRegistered?.() ?? false),
      );

      const coreResult = await readCoreStats(deps.db, {
        query: { ...query, sources: allowedSources },
        role,
        revision: {
          timezone: targetRevision.timezone,
          timezoneRevision: targetRevision.timezoneRevision,
          legacyBefore,
        },
        connected,
        now,
      });

      const bySource = new Map<StatsSource, StatsSourceDTO>(
        coreResult.sources.map((item) => [item.source, item]),
      );
      const context = {
        timezone: coreResult.scope.timezone,
        timezoneRevision: coreResult.scope.timezoneRevision,
        queriedAt: now.toISOString(),
      };

      const sources: StatsSourceDTO[] = [];
      for (const source of allowedSources) {
        const coreItem = bySource.get(source);
        if (coreItem) {
          sources.push(coreItem);
          continue;
        }
        const reader = nonCoreReaders[source];
        if (reader) {
          sources.push(await reader({ role, scope: coreResult.scope, context, now, connected }));
        } else {
          sources.push(toStatsSourceDTO(context, source, { unavailableState: 'not_connected' }));
        }
      }

      const dto = StatsDTOSchema.parse({ sources });
      return { dto, modelSuccessRate: coreResult.modelSuccessRate, scope: coreResult.scope };
    },
  };
}

async function finishStatsResponse(
  counter: Pick<ApiCounter, 'recordFinalResponse'>,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const recorded = await counter.recordFinalResponse({ routeId: STATS_ROUTE_ID, status, body });
  return NextResponse.json(recorded.body, {
    status: recorded.status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  });
}

function statsFailureResponse(
  error: unknown,
  requestId: string,
  counter: Pick<ApiCounter, 'recordFinalResponse'>,
  log?: (event: UnknownFailureLog) => void,
): Promise<Response> {
  const mapped = classifyThrown(error, requestId, log);
  if (mapped.kind === 'legacy-response') return Promise.resolve(mapped.response);
  if (mapped.kind === 'legacy-body') return finishStatsResponse(counter, 500, mapped.body);
  return finishStatsResponse(counter, mapped.status, mapped.body, mapped.headers);
}

/** Handle GET /api/admin/stats after requireAdmin authentication/role verification. */
export async function handleGetStats(
  request: Request,
  gate: StatsAuthGate,
  services: StatsHttpServices,
  opts: { log?: (event: UnknownFailureLog) => void } = {},
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const allowed = await hitRateLimit(
      `admin:stats:user:${gate.user.id}`,
      STATS_RATE_LIMIT,
      STATS_RATE_WINDOW_MS,
      { onStoreError: 'closed' },
    );
    if (!allowed) throw new AppError('rate_limited', { retryAfterSeconds: 60 });

    const query = parseStatsSearchParams(request.url);
    const result = await services.stats.query({ role: gate.user.role, query });
    return finishStatsResponse(services.apiCounter, 200, result.dto);
  } catch (error) {
    return statsFailureResponse(error, requestId, services.apiCounter, opts.log);
  }
}
