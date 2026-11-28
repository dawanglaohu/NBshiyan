import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { DayBoundaryError, siteLocalDate } from '../../analytics/day-boundaries';
import { LocalDateSchema, TimezoneSchema } from '../../contracts/common';
import type { FieldError } from '../../contracts/errors';
import {
  StatsDTOSchema,
  StatsQuerySchema,
  type StatsApiErrorRateDTO,
  type StatsCoverage,
  type StatsDTO,
  type StatsNotificationBreakdownDTO,
  type StatsNotificationCountsDTO,
  type StatsQueryDTO,
  type StatsSource,
  type StatsSourceDTO,
} from '../../contracts/ops';
import { rawCoveragePlan } from '../analytics/retention-plan';
import {
  classifyRecomputeBacklog,
  parseAnalyticsSettingsValue,
  parseRecomputeBacklogStrict,
} from '../analytics/settings';
import {
  ANALYTICS_TIMEZONE_CHANGE_ACTION,
  readSettingsAndBacklog,
} from '../analytics/settings-repo';
import { AppError, classifyThrown, type UnknownFailureLog } from '../http/errors';
import type { ApiCounter, ApiRouteId } from '../http/metrics';
import { INITIAL_TIMEZONE_REVISION } from '../jobs/types';
import { hitRateLimit } from '../security';
import {
  computeApiErrorRate,
  preserveSourceSnapshotOnFailure,
  sameStatsQueryScope,
} from './reliability-source';
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

export type NonCoreSourceReadInput = {
  role: Role;
  /** 当前请求的后台用户；按人分配的来源（如 SALES 询盘）据此取 scope。 */
  userId?: string;
  scope: CoreStatsResult['scope'];
  context: { timezone: string; timezoneRevision: number; queriedAt: string };
  now: Date;
  connected: boolean;
  /** 可选：调用方显式提供的同查询键上次成功单源快照（无全局状态，用于 E-51 失败回退）。 */
  previousSource?: StatsSourceDTO;
  previousBreakdown?: StatsNotificationBreakdownDTO | null;
};

export type NonCoreSourceReader = (input: NonCoreSourceReadInput) => Promise<StatsSourceDTO> | StatsSourceDTO;

export type DetailedNonCoreSourceReader = (input: NonCoreSourceReadInput) => Promise<{
  dto: StatsSourceDTO;
  notificationBreakdown?: StatsNotificationBreakdownDTO | null;
}> | {
  dto: StatsSourceDTO;
  notificationBreakdown?: StatsNotificationBreakdownDTO | null;
};

export type StatsServiceDeps = {
  db?: StatsDb;
  clock?: () => Date;
  analyticsConfigured?: () => boolean;
  aggregateJobRegistered?: () => boolean;
  resolveLegacyBefore?: (timezoneRevision: number) => Promise<string | null> | string | null;
  nonCoreReaders?: Partial<Record<StatsSource, NonCoreSourceReader>>;
  detailedNonCoreReaders?: Partial<Record<StatsSource, DetailedNonCoreSourceReader>>;
};

export type StatsQueryInput = {
  role: Role;
  userId?: string;
  query: StatsQueryDTO;
  /** 可选：单次请求显式传入的上次同键成功快照（严禁进程级全局缓存，仅同查询范围失败时保留原时间与旧值）。 */
  previousSnapshot?: {
    dto: StatsDTO;
    query?: StatsQueryDTO;
  };
};

export type StatsServiceResult = {
  dto: StatsDTO;
  modelSuccessRate: { value: number | null; coverage: StatsCoverage } | null;
  apiErrorRate: StatsApiErrorRateDTO | null;
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
  recomputableFrom: string | null;
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
 * Resolve the target site timezone, revision, and applicable recompute boundary inside one RepeatableRead snapshot.
 * Current revision reuses settings/pending classification and 30d raw retention bounds; historical revisions return null recomputableFrom.
 */
export async function resolveStatsRevision(
  db: StatsDb,
  requestedRevision?: number,
  now: Date = new Date(),
): Promise<ResolvedRevision> {
  return db.$transaction(async (tx) => {
    const raw = await readSettingsAndBacklog(tx);
    let current = { timezone: 'UTC', timezoneRevision: INITIAL_TIMEZONE_REVISION };
    if (raw.settings !== null) {
      const parsed = parseAnalyticsSettingsValue(raw.settings);
      if (parsed === 'corrupt') throw new AppError('service_unavailable');
      if (parsed !== null) {
        current = { timezone: parsed.timezone, timezoneRevision: parsed.timezoneRevision };
      }
    }

    const backlog = parseRecomputeBacklogStrict(raw.backlog);
    const pendingBoundaryFor = (
      target: { timezone: string; timezoneRevision: number },
      isCurrentRevision: boolean,
    ): string | null => {
      if (!isCurrentRevision) return null;
      const disposition = classifyRecomputeBacklog({
        settings: target,
        backlog,
        claimRevision: target.timezoneRevision,
        now,
      });
      if (disposition.kind !== 'planned') return null;
      try {
        return rawCoveragePlan(now, target.timezone).completeRawCoverageStartUtc;
      } catch (error) {
        if (error instanceof DayBoundaryError) throw new AppError('service_unavailable');
        throw error;
      }
    };

    if (requestedRevision === undefined || requestedRevision === current.timezoneRevision) {
      return { ...current, recomputableFrom: pendingBoundaryFor(current, true) };
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
      const resolved = { timezone: parsed.data, timezoneRevision: requestedRevision };
      return { ...resolved, recomputableFrom: pendingBoundaryFor(resolved, false) };
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
      const resolved = { timezone: auditTimezone, timezoneRevision: requestedRevision };
      return { ...resolved, recomputableFrom: pendingBoundaryFor(resolved, false) };
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
  const detailedNonCoreReaders = deps.detailedNonCoreReaders ?? {};

  return {
    async query({ role, userId, query, previousSnapshot }) {
      if (!deps.db) throw new Error('StatsService requires db');
      if (!isAllowedRole(role)) throw new AppError('forbidden');

      // Trim sources by RBAC before checking revisions or querying any table.
      const allowedSources = selectStatsSources(role, query.sources);
      const now = clock();
      const targetRevision = await resolveStatsRevision(deps.db, query.timezoneRevision, now);
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

      const canUsePrevious = Boolean(
        previousSnapshot && sameStatsQueryScope(query, previousSnapshot.query),
      );
      const prevSources = canUsePrevious
        ? new Map(previousSnapshot!.dto.sources.map((item) => [item.source, item]))
        : new Map<StatsSource, StatsSourceDTO>();
      const prevNotificationCounts = canUsePrevious ? previousSnapshot!.dto.notificationCounts : null;

      const sources: StatsSourceDTO[] = [];
      const notificationBreakdowns: Partial<Record<'chat_notifications' | 'mail', StatsNotificationBreakdownDTO | null>> = {};

      for (const source of allowedSources) {
        const coreItem = bySource.get(source);
        if (coreItem) {
          sources.push(preserveSourceSnapshotOnFailure(coreItem, prevSources.get(source)));
          continue;
        }
        const previousSource = prevSources.get(source);
        const previousBreakdown = source === 'chat_notifications' || source === 'mail'
          ? (prevNotificationCounts?.[source] ?? null)
          : undefined;
        const readInput: NonCoreSourceReadInput = {
          role,
          userId,
          scope: coreResult.scope,
          context,
          now,
          connected,
          ...(previousSource ? { previousSource } : {}),
          ...(previousBreakdown !== undefined ? { previousBreakdown } : {}),
        };

        const detailedReader = detailedNonCoreReaders[source];
        if (detailedReader) {
          const outcome = await detailedReader(readInput);
          const merged = preserveSourceSnapshotOnFailure(outcome.dto, previousSource);
          sources.push(merged);
          if (source === 'chat_notifications' || source === 'mail') {
            notificationBreakdowns[source] = outcome.notificationBreakdown
              ?? (merged.state === 'query_failed' && merged.value !== null ? (previousBreakdown ?? null) : null);
          }
          continue;
        }

        const reader = nonCoreReaders[source];
        if (reader) {
          const item = await reader(readInput);
          const merged = preserveSourceSnapshotOnFailure(item, previousSource);
          sources.push(merged);
          if (source === 'chat_notifications' || source === 'mail') {
            notificationBreakdowns[source] = merged.state === 'query_failed' && merged.value !== null
              ? (previousBreakdown ?? null)
              : null;
          }
        } else {
          sources.push(toStatsSourceDTO(context, source, { unavailableState: 'not_connected' }));
          if (source === 'chat_notifications' || source === 'mail') {
            notificationBreakdowns[source] = null;
          }
        }
      }

      const apiErrorRate = computeApiErrorRate(sources);
      const hasNotificationSources = allowedSources.includes('chat_notifications') || allowedSources.includes('mail');
      const notificationCounts: StatsNotificationCountsDTO | null = hasNotificationSources
        ? {
          ...(allowedSources.includes('chat_notifications')
            ? { chat_notifications: notificationBreakdowns.chat_notifications ?? null }
            : {}),
          ...(allowedSources.includes('mail')
            ? { mail: notificationBreakdowns.mail ?? null }
            : {}),
        }
        : null;

      const dto = StatsDTOSchema.parse({
        sources,
        modelSuccessRate: coreResult.modelSuccessRate,
        apiErrorRate,
        notificationCounts,
        recomputableFrom: targetRevision.recomputableFrom,
      });
      return {
        dto,
        modelSuccessRate: coreResult.modelSuccessRate,
        apiErrorRate,
        scope: coreResult.scope,
      };
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
    const result = await services.stats.query({ role: gate.user.role, userId: gate.user.id, query });
    return finishStatsResponse(services.apiCounter, 200, result.dto);
  } catch (error) {
    return statsFailureResponse(error, requestId, services.apiCounter, opts.log);
  }
}
