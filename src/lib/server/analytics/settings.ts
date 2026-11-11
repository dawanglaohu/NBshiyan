import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { recomputableFrom as earliestRecomputableFrom, DayBoundaryError } from '../../analytics/day-boundaries';
import {
  AnalyticsSettingsDTOSchema,
  AnalyticsSettingsUpdateDTOSchema,
  AnalyticsSettingsUpdateRequestSchema,
  type AnalyticsSettingsDTO,
  type AnalyticsSettingsUpdateDTO,
} from '../../contracts/analytics';
import { IdSchema, NonNegativeIntSchema, PositiveIntSchema, TimezoneSchema, UtcDateTimeSchema } from '../../contracts/common';
import { AppError, classifyThrown } from '../http/errors';
import type { ApiCounter } from '../http/metrics';
import { assertSameOrigin } from '../admin-guard';
import { hitRateLimit, rateLimitSubject } from '../security';
import { readJson, TOO_LARGE } from '../admin/inquiries';
import { ANALYTICS_SETTINGS_KEY, INITIAL_TIMEZONE_REVISION } from '../jobs/types';
import {
  ANALYTICS_RECOMPUTE_KEY,
  ANALYTICS_TIMEZONE_CHANGE_ACTION,
  createAnalyticsSettingsRepo,
  readSettingsAndBacklog,
  type SettingsQuery,
} from './settings-repo';

/**
 * 与计数器的严格形状一致。多出来的字段会让已落地的 API 计数把这一行当成不可读。
 * 重算范围放在 analytics.recompute，不塞进这个对象。
 */
const StoredAnalyticsSettingsSchema = z.object({
  version: NonNegativeIntSchema,
  timezone: TimezoneSchema,
  timezoneRevision: PositiveIntSchema,
  changedAt: UtcDateTimeSchema,
  updatedBy: z.string().min(1).max(128).nullable(),
}).strict();

export const AnalyticsRecomputeBacklogSchema = z.object({
  timezoneRevision: PositiveIntSchema,
  timezone: TimezoneSchema,
  recomputableFrom: UtcDateTimeSchema,
  requestedAt: UtcDateTimeSchema,
  updatedBy: IdSchema,
  status: z.literal('pending'),
}).strict();

const AuditMetaSchema = z.object({
  previousTimezone: TimezoneSchema,
  timezone: TimezoneSchema,
  timezoneRevision: PositiveIntSchema,
  recomputableFrom: UtcDateTimeSchema,
}).strict();

export type StoredAnalyticsSettings = z.infer<typeof StoredAnalyticsSettingsSchema>;
export type RecomputeBacklog = z.infer<typeof AnalyticsRecomputeBacklogSchema>;

/** 作业与 GET 共用的可用 pending 分类；`planned` 才允许消费。 */
export type RecomputeBacklogDisposition =
  | { kind: 'absent' }
  | { kind: 'unusable'; reason: 'corrupt' | 'stale' }
  | { kind: 'future_floor' }
  | { kind: 'planned'; rebuildFrom: string; expectedBacklog: RecomputeBacklog };

const TIMEZONE_MESSAGE = 'Enter an IANA time zone supported by this runtime.';
const VERSION_MESSAGE = 'The settings version is out of date.';

export type AnalyticsSettingsDb = SettingsQuery & {
  $transaction<T>(fn: (tx: SettingsQuery) => Promise<T>, options?: { timeout?: number; maxWait?: number }): Promise<T>;
};

export type AnalyticsSettingsActor = { userId: string };

function asJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

/** strict 解析 settings；缺行 null，坏形状 'corrupt'。 */
export function parseAnalyticsSettingsValue(value: unknown): StoredAnalyticsSettings | null | 'corrupt' {
  if (value === null || value === undefined) return null;
  const parsed = StoredAnalyticsSettingsSchema.safeParse(asJson(value));
  return parsed.success ? parsed.data : 'corrupt';
}

/**
 * strict 解析重算待办：六字段、status=pending、无多余字段；坏形状返回 'corrupt'。
 * 与 GET 的宽松读不同，作业/T1 分类据此拒绝消费。
 */
export function parseRecomputeBacklogStrict(value: unknown): RecomputeBacklog | null | 'corrupt' {
  if (value === null || value === undefined) return null;
  const parsed = AnalyticsRecomputeBacklogSchema.safeParse(asJson(value));
  return parsed.success ? parsed.data : 'corrupt';
}

/**
 * GET 与作业共用同一「可用 pending」语义：
 * absent / corrupt / stale（revision 或 timezone 不匹配）/ future floor 都不可消费；
 * 只有 planned 返回读时起点与待消费的完整值。
 */
export function classifyRecomputeBacklog(input: {
  settings: Pick<StoredAnalyticsSettings, 'timezone' | 'timezoneRevision'>;
  backlog: RecomputeBacklog | null | 'corrupt';
  claimRevision: number;
  now: Date;
}): RecomputeBacklogDisposition {
  const { settings, backlog, claimRevision, now } = input;
  if (backlog === null) return { kind: 'absent' };
  if (backlog === 'corrupt') return { kind: 'unusable', reason: 'corrupt' };
  if (backlog.timezoneRevision !== claimRevision || backlog.timezone !== settings.timezone) {
    return { kind: 'unusable', reason: 'stale' };
  }
  if (Date.parse(backlog.recomputableFrom) > now.getTime()) return { kind: 'future_floor' };
  return { kind: 'planned', rebuildFrom: backlog.recomputableFrom, expectedBacklog: backlog };
}

function initialSettings(now: Date): StoredAnalyticsSettings {
  return {
    version: 0,
    timezone: 'UTC',
    timezoneRevision: INITIAL_TIMEZONE_REVISION,
    changedAt: now.toISOString(),
    updatedBy: null,
  };
}

function invalidUpdate(error: z.ZodError): AppError {
  const fieldErrors: { timezone?: string; expectedVersion?: string } = {};
  for (const issue of error.issues) {
    if (issue.path[0] === 'timezone' || issue.code === 'unrecognized_keys') fieldErrors.timezone = TIMEZONE_MESSAGE;
    if (issue.path[0] === 'expectedVersion') fieldErrors.expectedVersion = VERSION_MESSAGE;
  }
  return new AppError('invalid', Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {});
}

function toDto(
  stored: Pick<StoredAnalyticsSettings, 'version' | 'timezone' | 'timezoneRevision'>,
  backlog: RecomputeBacklog | null | 'corrupt',
  now: Date,
): AnalyticsSettingsDTO {
  // GET 与作业共用同一可用 pending 判定；只有 planned 才给读时 live 起点。
  const disposition = classifyRecomputeBacklog({
    settings: stored,
    backlog,
    claimRevision: stored.timezoneRevision,
    now,
  });
  let recomputableFrom: string | null = null;
  if (disposition.kind === 'planned') {
    try {
      recomputableFrom = earliestRecomputableFrom(now, stored.timezone);
    } catch (error) {
      if (error instanceof DayBoundaryError) throw new AppError('service_unavailable');
      throw error;
    }
  }
  const parsed = AnalyticsSettingsDTOSchema.safeParse({
    version: stored.version,
    timezone: stored.timezone,
    timezoneRevision: stored.timezoneRevision,
    recomputableFrom,
  });
  if (!parsed.success) throw new AppError('service_unavailable');
  return parsed.data;
}

function requireActor(actor: AnalyticsSettingsActor | null | undefined): string {
  const parsed = IdSchema.safeParse(actor?.userId);
  if (!parsed.success) throw new AppError('unauthorized');
  return parsed.data;
}

function requireClock(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new AppError('invalid');
  return now;
}

/**
 * 站点时区的版本比较交换。缺行时的逻辑当前值是 UTC、revision 1、version 0。
 * 角色只认事务里重新读到的 User.role。查看者时区不会写进设置，UTC 事件行也不在这里更新。
 */
export function createAnalyticsSettingsService(deps: {
  db: AnalyticsSettingsDb;
  clock?: () => Date;
  repo?: ReturnType<typeof createAnalyticsSettingsRepo>;
}) {
  const clock = deps.clock ?? (() => new Date());
  const repo = deps.repo ?? createAnalyticsSettingsRepo();

  async function authorize(query: SettingsQuery, userId: string, lock: boolean): Promise<void> {
    const role = lock ? await repo.lockRole(query, userId) : await repo.readRole(query, userId);
    if (role === null) throw new AppError('unauthorized');
    if (role !== 'ADMIN') throw new AppError('forbidden');
  }

  async function read(actor: AnalyticsSettingsActor): Promise<AnalyticsSettingsDTO> {
    const userId = requireActor(actor);
    const now = requireClock(clock);
    return deps.db.$transaction(async (tx) => {
      await authorize(tx, userId, false);
      // settings 与待办必须同一条 SQL 读，不能两次 SELECT 各自取快照。
      const raw = await readSettingsAndBacklog(tx);
      const stored = parseAnalyticsSettingsValue(raw.settings);
      if (stored === 'corrupt') throw new AppError('service_unavailable');
      const backlog = parseRecomputeBacklogStrict(raw.backlog);
      return toDto(
        stored ?? { version: 0, timezone: 'UTC', timezoneRevision: INITIAL_TIMEZONE_REVISION },
        backlog,
        now,
      );
    });
  }

  async function applyUpdate(query: SettingsQuery, userId: string, input: unknown, now: Date): Promise<AnalyticsSettingsUpdateDTO> {
    await authorize(query, userId, true);
    const parsed = AnalyticsSettingsUpdateRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidUpdate(parsed.error);
    const locked = parseAnalyticsSettingsValue(await repo.lockSettingsValue(query));
    if (locked === 'corrupt') throw new AppError('service_unavailable');
    const current = locked ?? initialSettings(now);
    if (parsed.data.expectedVersion !== current.version) throw new AppError('version_conflict', { fieldErrors: { expectedVersion: VERSION_MESSAGE } });

    if (parsed.data.timezone === current.timezone) {
      if (locked === null) await repo.writeValue(query, ANALYTICS_SETTINGS_KEY, current);
      const backlog = parseRecomputeBacklogStrict(await repo.readValue(query, ANALYTICS_RECOMPUTE_KEY));
      const dto = AnalyticsSettingsUpdateDTOSchema.safeParse({ ...toDto(current, backlog, now), rebuildScheduled: false });
      if (!dto.success) throw new AppError('service_unavailable');
      return dto.data;
    }

    const nextVersion = current.version + 1;
    const nextRevision = current.timezoneRevision + 1;
    if (!NonNegativeIntSchema.safeParse(nextVersion).success || !PositiveIntSchema.safeParse(nextRevision).success) {
      throw new AppError('invalid');
    }
    let from: string;
    try {
      from = earliestRecomputableFrom(now, parsed.data.timezone);
    } catch (error) {
      if (error instanceof DayBoundaryError) throw new AppError('invalid', { fieldErrors: { timezone: TIMEZONE_MESSAGE } });
      throw error;
    }
    const next: StoredAnalyticsSettings = {
      version: nextVersion,
      timezone: parsed.data.timezone,
      timezoneRevision: nextRevision,
      changedAt: now.toISOString(),
      updatedBy: userId,
    };
    const backlog: RecomputeBacklog = {
      timezoneRevision: nextRevision,
      timezone: next.timezone,
      recomputableFrom: from,
      requestedAt: now.toISOString(),
      updatedBy: userId,
      status: 'pending',
    };
    const meta = AuditMetaSchema.parse({
      previousTimezone: current.timezone,
      timezone: next.timezone,
      timezoneRevision: nextRevision,
      recomputableFrom: from,
    });
    await repo.writeValue(query, ANALYTICS_SETTINGS_KEY, next);
    await repo.writeValue(query, ANALYTICS_RECOMPUTE_KEY, backlog);
    await repo.insertAudit(query, {
      id: randomUUID(),
      actorId: userId,
      action: ANALYTICS_TIMEZONE_CHANGE_ACTION,
      target: ANALYTICS_SETTINGS_KEY,
      meta,
      at: now,
    });
    const dto = AnalyticsSettingsUpdateDTOSchema.safeParse({ ...toDto(next, backlog, now), rebuildScheduled: true });
    if (!dto.success) throw new AppError('service_unavailable');
    return dto.data;
  }

  return {
    read,
    async update(actor: AnalyticsSettingsActor, input: unknown, tx?: SettingsQuery): Promise<AnalyticsSettingsUpdateDTO> {
      const userId = requireActor(actor);
      const now = requireClock(clock);
      if (tx) return applyUpdate(tx, userId, input, now);
      return deps.db.$transaction((query) => applyUpdate(query, userId, input, now), { timeout: 15_000, maxWait: 5_000 });
    },
  };
}

export type AnalyticsSettingsService = ReturnType<typeof createAnalyticsSettingsService>;

// ---------------------------------------------------------------------------
// HTTP 层：GET/PATCH /api/admin/settings/analytics
// 鉴权、同源与限流在这里；DB 角色在服务事务内用锁后/读后的 User.role 复核。
// ---------------------------------------------------------------------------

export const ANALYTICS_SETTINGS_GET_ROUTE_ID = 'GET /api/admin/settings/analytics';
export const ANALYTICS_SETTINGS_PATCH_ROUTE_ID = 'PATCH /api/admin/settings/analytics';
const SETTINGS_BODY_LIMIT = 2_000;
const SETTINGS_RATE_LIMIT = 120;

export type AnalyticsSettingsGate = { user: { id: string }; ip?: string | null };

export type AnalyticsSettingsHttpServices = {
  analyticsSettings: AnalyticsSettingsService;
  apiCounter: ApiCounter;
};

async function finish<T>(
  counter: ApiCounter,
  routeId: string,
  status: number,
  body: T,
  headers: Record<string, string> = {},
): Promise<Response> {
  const recorded = await counter.recordFinalResponse({ routeId, status, body });
  return Response.json(recorded.body, {
    status: recorded.status,
    headers: { 'cache-control': 'private, no-store', ...headers },
  });
}

async function fromError(
  error: unknown,
  requestId: string,
  counter: ApiCounter,
  routeId: string,
): Promise<Response> {
  const mapped = classifyThrown(error, requestId);
  if (mapped.kind === 'legacy-response') return mapped.response;
  if (mapped.kind === 'legacy-body') return finish(counter, routeId, 500, mapped.body);
  return finish(counter, routeId, mapped.status, mapped.body, mapped.headers);
}

async function settingsRateOk(gate: AnalyticsSettingsGate): Promise<void> {
  const allowed = await hitRateLimit(
    `admin:settings-analytics:${rateLimitSubject(gate.ip ?? null)}`,
    SETTINGS_RATE_LIMIT,
    60_000,
    { onStoreError: 'closed' },
  );
  if (!allowed) throw new AppError('rate_limited', { retryAfterSeconds: 60 });
}

/** 读：无查询参数；pending 可用时返回读时 live 起点，否则 null（不证明完成）。 */
export async function handleGetAnalyticsSettings(
  request: Request,
  gate: AnalyticsSettingsGate,
  services: AnalyticsSettingsHttpServices,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    if ([...new URL(request.url).searchParams.keys()].length > 0) throw new AppError('invalid');
    await settingsRateOk(gate);
    const dto = await services.analyticsSettings.read({ userId: gate.user.id });
    return finish(services.apiCounter, ANALYTICS_SETTINGS_GET_ROUTE_ID, 200, dto);
  } catch (error) {
    return fromError(error, requestId, services.apiCounter, ANALYTICS_SETTINGS_GET_ROUTE_ID);
  }
}

/** 改：同源 → 限流 → 2KB 限体 → strict {timezone, expectedVersion} → 版本 CAS。 */
export async function handlePatchAnalyticsSettings(
  request: Request,
  gate: AnalyticsSettingsGate,
  services: AnalyticsSettingsHttpServices,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const originBlocked = assertSameOrigin(request);
    if (originBlocked) return originBlocked;
    await settingsRateOk(gate);
    const json = await readJson(request, SETTINGS_BODY_LIMIT);
    if (json === TOO_LARGE) throw new AppError('too_large');
    const parsed = AnalyticsSettingsUpdateRequestSchema.safeParse(json);
    if (!parsed.success) throw invalidUpdate(parsed.error);
    const dto = await services.analyticsSettings.update({ userId: gate.user.id }, parsed.data);
    return finish(services.apiCounter, ANALYTICS_SETTINGS_PATCH_ROUTE_ID, 200, dto);
  } catch (error) {
    return fromError(error, requestId, services.apiCounter, ANALYTICS_SETTINGS_PATCH_ROUTE_ID);
  }
}
