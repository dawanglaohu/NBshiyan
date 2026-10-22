import { Prisma, type PrismaClient } from '@prisma/client';
import {
  ANALYTICS_SETTINGS_KEY,
  CompleteInput,
  CompleteResult,
  ClaimInput,
  ClaimResult,
  INITIAL_TIMEZONE_REVISION,
  JOB_LEASE_MS,
  JobKeySchema,
  JobLeaseOwnerSchema,
  JobLeaseView,
  JobResultStatusSchema,
  JobRunStatusSchema,
  JobSummarySchema,
  ReadResult,
  RenewInput,
  RenewResult,
  StoredTimezoneRevisionSchema,
  neverView,
} from './types';
import { AppErrorCodeSchema } from '../../contracts/errors';
import { PositiveIntSchema } from '../../contracts/common';

export type JobLeaseDb = Pick<PrismaClient, '$queryRaw' | '$transaction'>;

type RevisionRead = { ok: true; revision: number } | { ok: false; reason: 'revision_unreadable' };

type StoredRow = {
  generation: number;
  lastStatus: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSucceededAt: string | null;
  lockedUntil: string | null;
  lastErrorCode: string | null;
  summary: unknown;
};

// DateTime 列是不含时区的 UTC 时刻。在 SQL 里格式化，避免驱动按会话时区解释。
const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function isoColumn(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`to_char(${column}, ${ISO_FORMAT})`;
}

const returningView = Prisma.sql`
  "generation",
  "lastStatus"::text AS "lastStatus",
  ${isoColumn(Prisma.sql`"lastStartedAt"`)} AS "lastStartedAt",
  ${isoColumn(Prisma.sql`"lastFinishedAt"`)} AS "lastFinishedAt",
  ${isoColumn(Prisma.sql`"lastSucceededAt"`)} AS "lastSucceededAt",
  ${isoColumn(Prisma.sql`"lockedUntil"`)} AS "lockedUntil",
  "lastErrorCode",
  "summary"
`;

function asGeneration(value: unknown): number | null {
  const numeric = typeof value === 'bigint' ? Number(value) : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  const parsed = PositiveIntSchema.safeParse(numeric);
  return parsed.success ? parsed.data : null;
}

function asSummary(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function viewFrom(key: string, row: StoredRow, now: Date): JobLeaseView | null {
  const parsedKey = JobKeySchema.safeParse(key);
  const generation = asGeneration(row.generation);
  const lastStatus = JobRunStatusSchema.safeParse(row.lastStatus);
  if (!parsedKey.success || generation === null || !lastStatus.success) return null;
  const error = AppErrorCodeSchema.safeParse(row.lastErrorCode);
  const summary = JobSummarySchema.safeParse(asSummary(row.summary));
  const lockedUntil = row.lockedUntil;
  const lockedAt = lockedUntil === null ? null : Date.parse(lockedUntil);
  return {
    key: parsedKey.data,
    generation,
    lastStatus: lastStatus.data,
    lastStartedAt: row.lastStartedAt,
    lastFinishedAt: row.lastFinishedAt,
    lastSucceededAt: row.lastSucceededAt,
    lockedUntil,
    leaseActive: lockedAt !== null && Number.isFinite(lockedAt) && lockedAt > now.getTime(),
    lastErrorCode: error.success ? error.data : null,
    summary: summary.success ? summary.data : null,
  };
}

async function currentTimezoneRevision(db: { $queryRaw: JobLeaseDb['$queryRaw'] }, lock: boolean): Promise<RevisionRead> {
  const rows = lock
    ? await db.$queryRaw<{ value: unknown }[]>`
        SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY} FOR UPDATE
      `
    : await db.$queryRaw<{ value: unknown }[]>`
        SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY}
      `;
  if (rows.length === 0) return { ok: true, revision: INITIAL_TIMEZONE_REVISION };
  const parsed = StoredTimezoneRevisionSchema.safeParse(rows[0]?.value);
  if (!parsed.success) return { ok: false, reason: 'revision_unreadable' };
  return { ok: true, revision: parsed.data.timezoneRevision };
}

function validClock(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}

/**
 * 固定作业的领取、续租、完成和安全读取。调用方传入共享 Prisma 客户端和服务端时钟，默认时钟是 `new Date()`。
 * 三次写都在同一条条件语句里比较租约：`lockedUntil` 等于时钟时，旧工人不能续租或完成。
 * 只有 `SUCCEEDED` 推进 `lastSucceededAt`。失败、部分完成，以及代次、租约或时区 revision 不匹配的提交，都不改原成功时间。
 * 完成时锁住 `analytics.settings` 行，并核调用方带回的 revision。读取不返回 `leaseOwner`；不合白名单的 summary 和错误码按空值返回。
 */
export function createJobLeaseRepo(deps: { db: JobLeaseDb; clock?: () => Date }) {
  const clock = deps.clock ?? (() => new Date());

  async function claim(input: ClaimInput): Promise<ClaimResult> {
    const key = JobKeySchema.safeParse(input.key);
    const owner = JobLeaseOwnerSchema.safeParse(input.owner);
    const now = clock();
    if (!key.success || !owner.success || !validClock(now)) return { acquired: false, reason: 'invalid' };
    const revision = await currentTimezoneRevision(deps.db, false);
    if (!revision.ok) return { acquired: false, reason: 'revision_unreadable' };
    const lockedUntil = new Date(now.getTime() + JOB_LEASE_MS);
    const rows = await deps.db.$queryRaw<StoredRow[]>`
      INSERT INTO "JobState" (
        "key", "leaseOwner", "generation", "lockedUntil", "lastStartedAt",
        "lastStatus", "lastErrorCode", "summary", "createdAt", "updatedAt"
      ) VALUES (
        ${key.data}, ${owner.data}, 1, ${utc(lockedUntil)}, ${utc(now)},
        ${'RUNNING'}::"JobRunStatus", NULL, NULL, ${utc(now)}, ${utc(now)}
      )
      ON CONFLICT ("key") DO UPDATE SET
        "leaseOwner" = EXCLUDED."leaseOwner",
        "generation" = "JobState"."generation" + 1,
        "lockedUntil" = EXCLUDED."lockedUntil",
        "lastStartedAt" = EXCLUDED."lastStartedAt",
        "lastStatus" = 'RUNNING'::"JobRunStatus",
        "lastErrorCode" = NULL,
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE "JobState"."lockedUntil" IS NULL OR "JobState"."lockedUntil" <= ${utc(now)}
      RETURNING ${returningView}
    `;
    const view = rows.length === 1 ? viewFrom(key.data, rows[0], now) : null;
    if (!view) return { acquired: false, reason: 'busy' };
    return {
      acquired: true,
      generation: view.generation,
      lockedUntil: view.lockedUntil ?? lockedUntil.toISOString(),
      timezoneRevision: revision.revision,
      view,
    };
  }

  async function renew(input: RenewInput): Promise<RenewResult> {
    const key = JobKeySchema.safeParse(input.key);
    const owner = JobLeaseOwnerSchema.safeParse(input.owner);
    const generation = PositiveIntSchema.safeParse(input.generation);
    const now = clock();
    if (!key.success || !owner.success || !generation.success || !validClock(now)) return { renewed: false, reason: 'invalid' };
    const lockedUntil = new Date(now.getTime() + JOB_LEASE_MS);
    const rows = await deps.db.$queryRaw<StoredRow[]>`
      UPDATE "JobState"
      SET "lockedUntil" = ${utc(lockedUntil)}, "updatedAt" = ${utc(now)}
      WHERE "key" = ${key.data}
        AND "leaseOwner" = ${owner.data}
        AND "generation" = ${generation.data}
        AND "lockedUntil" > ${utc(now)}
      RETURNING ${returningView}
    `;
    const view = rows.length === 1 ? viewFrom(key.data, rows[0], now) : null;
    if (view?.lockedUntil) return { renewed: true, generation: view.generation, lockedUntil: view.lockedUntil, view };
    return { renewed: false, reason: await missReason(key.data, owner.data, generation.data, now) };
  }

  async function complete(input: CompleteInput): Promise<CompleteResult> {
    const key = JobKeySchema.safeParse(input.key);
    const owner = JobLeaseOwnerSchema.safeParse(input.owner);
    const generation = PositiveIntSchema.safeParse(input.generation);
    const status = JobResultStatusSchema.safeParse(input.status);
    const timezoneRevision = PositiveIntSchema.safeParse(input.timezoneRevision);
    const summary = input.summary === null ? { success: true as const, data: null } : JobSummarySchema.safeParse(input.summary);
    const now = clock();
    if (!key.success || !owner.success || !generation.success || !status.success || !timezoneRevision.success || !summary.success || !validClock(now)) {
      return { committed: false, reason: 'invalid' };
    }
    const errorCode = input.errorCode ?? null;
    if (status.data === 'SUCCEEDED') {
      if (errorCode !== null) return { committed: false, reason: 'invalid' };
    } else if (!AppErrorCodeSchema.safeParse(errorCode).success) {
      return { committed: false, reason: 'invalid' };
    }
    const summarySql = summary.data === null ? Prisma.sql`NULL` : Prisma.sql`${JSON.stringify(summary.data)}::jsonb`;
    const errorSql = status.data === 'SUCCEEDED' ? Prisma.sql`NULL` : Prisma.sql`${errorCode}`;
    return deps.db.$transaction(async (tx) => {
      const revision = await currentTimezoneRevision(tx, true);
      if (!revision.ok) return { committed: false, reason: 'revision_unreadable' };
      if (revision.revision !== timezoneRevision.data) return { committed: false, reason: 'revision_conflict' };
      const rows = await tx.$queryRaw<StoredRow[]>`
        UPDATE "JobState"
        SET
          "lastStatus" = ${status.data}::"JobRunStatus",
          "lastFinishedAt" = ${utc(now)},
          "lastSucceededAt" = CASE
            WHEN ${status.data}::"JobRunStatus" = 'SUCCEEDED'::"JobRunStatus" THEN ${utc(now)}
            ELSE "lastSucceededAt"
          END,
          "lastErrorCode" = ${errorSql},
          "summary" = ${summarySql},
          "leaseOwner" = NULL,
          "lockedUntil" = NULL,
          "updatedAt" = ${utc(now)}
        WHERE "key" = ${key.data}
          AND "leaseOwner" = ${owner.data}
          AND "generation" = ${generation.data}
          AND "lockedUntil" > ${utc(now)}
          AND ${timezoneRevision.data} = ${revision.revision}
        RETURNING ${returningView}
      `;
      const view = rows.length === 1 ? viewFrom(key.data, rows[0], now) : null;
      if (!view) return { committed: false, reason: await missReason(key.data, owner.data, generation.data, now, tx) };
      return { committed: true, view };
    });
  }

  async function read(key: string): Promise<ReadResult> {
    const parsed = JobKeySchema.safeParse(key);
    if (!parsed.success) return { ok: false, reason: 'invalid' };
    const now = clock();
    if (!validClock(now)) return { ok: false, reason: 'invalid' };
    const rows = await deps.db.$queryRaw<StoredRow[]>`
      SELECT ${returningView} FROM "JobState" WHERE "key" = ${parsed.data}
    `;
    if (rows.length === 0) return { ok: true, view: neverView(parsed.data) };
    const view = viewFrom(parsed.data, rows[0], now);
    if (!view) throw new Error('job_state_unreadable');
    return { ok: true, view };
  }

  async function missReason(
    key: string,
    owner: string,
    generation: number,
    now: Date,
    db: { $queryRaw: JobLeaseDb['$queryRaw'] } = deps.db,
  ): Promise<'stale' | 'expired'> {
    const rows = await db.$queryRaw<{ leaseOwner: string | null; generation: number; lockedUntil: string | null }[]>`
      SELECT "leaseOwner", "generation", ${isoColumn(Prisma.sql`"lockedUntil"`)} AS "lockedUntil"
      FROM "JobState"
      WHERE "key" = ${key}
    `;
    const row = rows[0];
    if (!row || row.leaseOwner !== owner || row.generation !== generation || row.lockedUntil === null) return 'stale';
    return Date.parse(row.lockedUntil) <= now.getTime() ? 'expired' : 'stale';
  }

  return { claim, renew, complete, read };
}

export type JobLeaseRepo = ReturnType<typeof createJobLeaseRepo>;
