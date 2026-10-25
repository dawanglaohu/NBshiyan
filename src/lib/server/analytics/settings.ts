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
import { AppError } from '../http/errors';
import { ANALYTICS_SETTINGS_KEY, INITIAL_TIMEZONE_REVISION } from '../jobs/types';
import {
  ANALYTICS_RECOMPUTE_KEY,
  ANALYTICS_TIMEZONE_CHANGE_ACTION,
  createAnalyticsSettingsRepo,
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

type StoredAnalyticsSettings = z.infer<typeof StoredAnalyticsSettingsSchema>;
type RecomputeBacklog = z.infer<typeof AnalyticsRecomputeBacklogSchema>;

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

function storedFrom(value: unknown): StoredAnalyticsSettings | null | 'corrupt' {
  if (value === null || value === undefined) return null;
  const parsed = StoredAnalyticsSettingsSchema.safeParse(asJson(value));
  return parsed.success ? parsed.data : 'corrupt';
}

function backlogFrom(value: unknown): RecomputeBacklog | null {
  if (value === null || value === undefined) return null;
  const parsed = AnalyticsRecomputeBacklogSchema.safeParse(asJson(value));
  return parsed.success ? parsed.data : null;
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

function toDto(stored: Pick<StoredAnalyticsSettings, 'version' | 'timezone' | 'timezoneRevision'>, backlog: RecomputeBacklog | null): AnalyticsSettingsDTO {
  const recomputableFrom = backlog
    && backlog.timezoneRevision === stored.timezoneRevision
    && backlog.timezone === stored.timezone
    ? backlog.recomputableFrom
    : null;
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
    return deps.db.$transaction(async (tx) => {
      await authorize(tx, userId, false);
      const stored = storedFrom(await repo.readValue(tx, ANALYTICS_SETTINGS_KEY));
      if (stored === 'corrupt') throw new AppError('service_unavailable');
      const backlog = backlogFrom(await repo.readValue(tx, ANALYTICS_RECOMPUTE_KEY));
      return toDto(stored ?? { version: 0, timezone: 'UTC', timezoneRevision: INITIAL_TIMEZONE_REVISION }, backlog);
    });
  }

  async function applyUpdate(query: SettingsQuery, userId: string, input: unknown, now: Date): Promise<AnalyticsSettingsUpdateDTO> {
    await authorize(query, userId, true);
    const parsed = AnalyticsSettingsUpdateRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidUpdate(parsed.error);
    const locked = storedFrom(await repo.lockSettingsValue(query));
    if (locked === 'corrupt') throw new AppError('service_unavailable');
    const current = locked ?? initialSettings(now);
    if (parsed.data.expectedVersion !== current.version) throw new AppError('version_conflict', { fieldErrors: { expectedVersion: VERSION_MESSAGE } });

    if (parsed.data.timezone === current.timezone) {
      if (locked === null) await repo.writeValue(query, ANALYTICS_SETTINGS_KEY, current);
      const backlog = backlogFrom(await repo.readValue(query, ANALYTICS_RECOMPUTE_KEY));
      const dto = AnalyticsSettingsUpdateDTOSchema.safeParse({ ...toDto(current, backlog), rebuildScheduled: false });
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
    const dto = AnalyticsSettingsUpdateDTOSchema.safeParse({ ...toDto(next, backlog), rebuildScheduled: true });
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
