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

export type JobLeaseDb = Pick<PrismaClient, '$queryRaw'>;
export type JobLeaseTx = Prisma.TransactionClient;

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

async function currentTimezoneRevision(db: { $queryRaw: JobLeaseDb['$queryRaw'] }): Promise<RevisionRead> {
  const rows = await db.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY}
  `;
  return revisionFrom(rows[0]?.value, rows.length === 0);
}

async function lockedTimezoneRevision(query: JobLeaseTx, clock: () => Date): Promise<RevisionRead> {
  // 缺行时行锁锁不住任何元组。表级锁与插入冲突，核对和提交才能串行。
  await query.$executeRaw`LOCK TABLE "SiteSetting" IN SHARE ROW EXCLUSIVE MODE`;
  const rows = await query.$queryRaw<{ value: unknown }[]>`
    SELECT "value" FROM "SiteSetting" WHERE "key" = ${ANALYTICS_SETTINGS_KEY} FOR UPDATE
  `;
  if (rows.length > 0) return revisionFrom(rows[0]?.value, false);
  const now = clock();
  if (!validClock(now)) return { ok: false, reason: 'revision_unreadable' };
  const initial = {
    version: 0, timezone: 'UTC', timezoneRevision: INITIAL_TIMEZONE_REVISION,
    changedAt: now.toISOString(), updatedBy: null,
  };
  // RR 旧快照看不到已插入的行；唯一冲突的写会让 PostgreSQL 拒绝整笔旧事务。
  const initialized = await query.$queryRaw<{ value: unknown }[]>`
    INSERT INTO "SiteSetting" ("key", "value")
    VALUES (${ANALYTICS_SETTINGS_KEY}, ${JSON.stringify(initial)}::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = "SiteSetting"."value"
    RETURNING "value"
  `;
  return revisionFrom(initialized[0]?.value, false);
}

function revisionFrom(value: unknown, missing: boolean): RevisionRead {
  if (missing) return { ok: true, revision: INITIAL_TIMEZONE_REVISION };
  const parsed = StoredTimezoneRevisionSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: 'revision_unreadable' };
  return { ok: true, revision: parsed.data.timezoneRevision };
}

function leaseAbort(reason: string): Error {
  return Object.assign(new Error(reason), { name: 'JobLeaseAbort' });
}

function validClock(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}

/**
 * 固定作业的领取、续租、完成和安全读取。调用方传入共享 Prisma 客户端和服务端时钟，默认时钟是 `new Date()`。
 * 续租和完成必须传入 service/顶层 use-case 开启的事务，与业务结果共同提交或回滚。
 * 续租和完成用拿到 JobState 与设置锁之后的时钟；领取返回前按当前时钟确认租约仍有效。
 * `lockedUntil` 等于该时钟时，不能交付、续租或完成租约。
 * 只有 `SUCCEEDED` 推进 `lastSucceededAt`。失败、部分完成，以及代次、租约或时区 revision 不匹配的提交，都不改原成功时间。
 * 拒绝续租或完成时抛出 JobLeaseAbort，调用方须让异常退出上层事务，使业务写入一起回滚。读取不返回 `leaseOwner`。
 */
export function createJobLeaseRepo(deps: { db: JobLeaseDb; clock?: () => Date }) {
  const clock = deps.clock ?? (() => new Date());

  async function claim(input: ClaimInput): Promise<ClaimResult> {
    const key = JobKeySchema.safeParse(input.key);
    const owner = JobLeaseOwnerSchema.safeParse(input.owner);
    const now = clock();
    if (!key.success || !owner.success || !validClock(now)) return { acquired: false, reason: 'invalid' };
    const revision = await currentTimezoneRevision(deps.db);
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
    const returnedAt = clock();
    if (!validClock(returnedAt)) return { acquired: false, reason: 'invalid' };
    const view = rows.length === 1 ? viewFrom(key.data, rows[0], returnedAt) : null;
    if (!view?.leaseActive) return { acquired: false, reason: 'busy' };
    return {
      acquired: true,
      generation: view.generation,
      lockedUntil: view.lockedUntil ?? lockedUntil.toISOString(),
      timezoneRevision: revision.revision,
      view,
    };
  }

  async function renew(input: RenewInput, tx: JobLeaseTx): Promise<RenewResult> {
    if (!tx) throw leaseAbort('transaction_required');
    const key = JobKeySchema.safeParse(input.key);
    const owner = JobLeaseOwnerSchema.safeParse(input.owner);
    const generation = PositiveIntSchema.safeParse(input.generation);
    if (!key.success || !owner.success || !generation.success) {
      throw leaseAbort('invalid');
    }
    const outcome = await finishRenew(tx, key.data, owner.data, generation.data);
    if (!outcome.renewed) throw leaseAbort(outcome.reason);
    return outcome;
  }

  async function finishRenew(query: JobLeaseTx, key: string, owner: string, generation: number): Promise<RenewResult> {
    await query.$queryRaw`SELECT "generation" FROM "JobState" WHERE "key" = ${key} FOR UPDATE`;
    const now = clock();
    if (!validClock(now)) return { renewed: false, reason: 'invalid' };
    const lockedUntil = new Date(now.getTime() + JOB_LEASE_MS);
    const rows = await query.$queryRaw<StoredRow[]>`
      UPDATE "JobState"
      SET "lockedUntil" = ${utc(lockedUntil)}, "updatedAt" = ${utc(now)}
      WHERE "key" = ${key}
        AND "leaseOwner" = ${owner}
        AND "generation" = ${generation}
        AND "lockedUntil" > ${utc(now)}
      RETURNING ${returningView}
    `;
    const view = rows.length === 1 ? viewFrom(key, rows[0], now) : null;
    if (view?.lockedUntil) return { renewed: true, generation: view.generation, lockedUntil: view.lockedUntil, view };
    return { renewed: false, reason: await missReason(key, owner, generation, now, query) };
  }

  async function complete(input: CompleteInput, tx: JobLeaseTx): Promise<CompleteResult> {
    if (!tx) throw leaseAbort('transaction_required');
    const key = JobKeySchema.safeParse(input.key);
    const owner = JobLeaseOwnerSchema.safeParse(input.owner);
    const generation = PositiveIntSchema.safeParse(input.generation);
    const status = JobResultStatusSchema.safeParse(input.status);
    const timezoneRevision = PositiveIntSchema.safeParse(input.timezoneRevision);
    const summary = input.summary === null ? { success: true as const, data: null } : JobSummarySchema.safeParse(input.summary);
    if (!key.success || !owner.success || !generation.success || !status.success || !timezoneRevision.success || !summary.success) {
      throw leaseAbort('invalid');
    }
    const errorCode = input.errorCode ?? null;
    if (status.data === 'SUCCEEDED' ? errorCode !== null : !AppErrorCodeSchema.safeParse(errorCode).success) {
      throw leaseAbort('invalid');
    }
    const summarySql = summary.data === null ? Prisma.sql`NULL` : Prisma.sql`${JSON.stringify(summary.data)}::jsonb`;
    const errorSql = status.data === 'SUCCEEDED' ? Prisma.sql`NULL` : Prisma.sql`${errorCode}`;
    const outcome = await finishComplete(tx, {
      key: key.data, owner: owner.data, generation: generation.data, status: status.data,
      timezoneRevision: timezoneRevision.data, summarySql, errorSql,
    });
    if (!outcome.committed) throw leaseAbort(outcome.reason);
    return outcome;
  }

  async function finishComplete(query: JobLeaseTx, parsed: {
    key: string; owner: string; generation: number; status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL';
    timezoneRevision: number; summarySql: Prisma.Sql; errorSql: Prisma.Sql;
  }): Promise<CompleteResult> {
    await query.$queryRaw`SELECT "generation" FROM "JobState" WHERE "key" = ${parsed.key} FOR UPDATE`;
    const revision = await lockedTimezoneRevision(query, clock);
    const now = clock();
    if (!validClock(now)) return { committed: false, reason: 'invalid' };
    if (!revision.ok) return { committed: false, reason: 'revision_unreadable' };
    if (revision.revision !== parsed.timezoneRevision) return { committed: false, reason: 'revision_conflict' };
    const rows = await query.$queryRaw<StoredRow[]>`
      UPDATE "JobState"
      SET
        "lastStatus" = ${parsed.status}::"JobRunStatus",
        "lastFinishedAt" = ${utc(now)},
        "lastSucceededAt" = CASE
          WHEN ${parsed.status}::"JobRunStatus" = 'SUCCEEDED'::"JobRunStatus" THEN ${utc(now)}
          ELSE "lastSucceededAt"
        END,
        "lastErrorCode" = ${parsed.errorSql},
        "summary" = ${parsed.summarySql},
        "leaseOwner" = NULL,
        "lockedUntil" = NULL,
        "updatedAt" = ${utc(now)}
      WHERE "key" = ${parsed.key}
        AND "leaseOwner" = ${parsed.owner}
        AND "generation" = ${parsed.generation}
        AND "lockedUntil" > ${utc(now)}
        AND ${parsed.timezoneRevision} = ${revision.revision}
      RETURNING ${returningView}
    `;
    const view = rows.length === 1 ? viewFrom(parsed.key, rows[0], now) : null;
    if (!view) return { committed: false, reason: await missReason(parsed.key, parsed.owner, parsed.generation, now, query) };
    return { committed: true, view };
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
