import { Prisma, type PrismaClient } from '@prisma/client';
import type { SiteDayBounds } from '../../analytics/day-boundaries';
import type { RollupSourceEvent } from '../../analytics/rollup-plan';

/**
 * M5-T3 一致快照聚合的数据库层。
 *
 * 与既有 `rollup.ts` 的分工：`rollup.ts` 负责调度、租约、设置版本校验与整日替换；
 * 本文件提供聚合事务里真正落到 PostgreSQL 的三件原语——
 * 1. **显式 RepeatableRead 快照**：一次聚合内所有读取都落在同一快照上；
 * 2. **`receivedAt ≤ cutoff` 过滤**：cutoff 之后到达的新事件留给下一轮（E-80）；
 * 3. **代次/版本的数据库级互斥**：`JobState` 行锁真读 generation，watermark 用带
 *    `WHERE` 守卫的 upsert，旧代次／旧 watermark 由数据库拒绝，而不是只在内存里
 *    用一个纯函数判断（E-81/E-83）。
 */

/** 只读查询面，便于单测注入。 */
export type Query = { $queryRaw: PrismaClient['$queryRaw'] };

/** 聚合写入面。 */
export type AggregateTx = Query & {
  $executeRaw: PrismaClient['$executeRaw'];
};

/** 与 rollup.ts 的 ANALYTICS_ROLLUP_JOB_KEY 是同一把租约锁。 */
export const AGGREGATE_JOB_KEY = 'analytics-aggregate';

const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/** 与 rollup.ts / event-repo / settings-repo 相同的 utc：ISO 字符串再按 UTC 写入 timestamp，避免会话时区平移。 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/**
 * 在 RepeatableRead 快照内读取一天的事件，并按 `receivedAt ≤ cutoff` 过滤。
 *
 * 返回的事件仍交给 `aggregateSiteDay` 做去重与计数，本函数不改聚合语义。
 */
export async function loadEventsAtSnapshot(
  db: Query,
  bounds: SiteDayBounds,
  cutoff: Date,
): Promise<RollupSourceEvent[]> {
  const rows = await db.$queryRaw<{
    kind: string;
    locale: string;
    productSlug: string | null;
    path: string | null;
    browserHash: string;
    occurredAt: string;
    receivedAt: string;
  }[]>`
    SELECT
      "kind"::text AS "kind",
      "locale",
      "productSlug",
      "path",
      "browserHash",
      to_char("occurredAt", ${ISO_FORMAT}) AS "occurredAt",
      to_char("receivedAt", ${ISO_FORMAT}) AS "receivedAt"
    FROM "AnalyticsEvent"
    WHERE "occurredAt" >= ${utc(new Date(bounds.startUtc))}
      AND "occurredAt" < ${utc(new Date(bounds.endUtc))}
      AND "receivedAt" <= ${utc(cutoff)}
  `;
  return rows.map((row) => ({
    kind: row.kind,
    locale: row.locale,
    productSlug: row.productSlug,
    path: row.path,
    browserHash: row.browserHash,
    occurredAt: new Date(row.occurredAt),
    receivedAt: new Date(row.receivedAt),
  }));
}

/**
 * 在聚合事务里对 `analytics-aggregate` 的租约行加行锁，并真读当前 generation。
 *
 * 这是并发互斥的第一道数据库防线：两个调度实例重叠时，`SELECT ... FOR UPDATE`
 * 会让后到的事务等到前者提交；RepeatableRead 下若前者已改过该行并commit，
 * 后到事务会拿到 serialization failure（40001）整笔回滚，不可能覆盖新结果。
 * 返回值是当前库里的 generation；行不存在（首次运行）时返回 null，表示无并发竞争者。
 */
export async function readLockedGeneration(
  tx: Prisma.TransactionClient,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ generation: number }[]>`
    SELECT "generation" FROM "JobState" WHERE "key" = ${AGGREGATE_JOB_KEY} FOR UPDATE
  `;
  const value = rows[0]?.generation;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * 带 WHERE 守卫的 watermark upsert。返回受影响行数；0 表示数据库拒绝了这次提交
 * （旧 timezoneRevision 或旧 watermark 试图覆盖新结果），调用方必须让整个事务回滚。
 *
 * 两个守卫条件：
 * - 已存 timezoneRevision 不得高于本次（旧时区代次不得覆盖，E-83）；
 * - 已存 sourceMaxReceivedAt 不得新于本次（watermark 只能单调前进，E-80）。
 *   任一为 NULL 时用 conservative 规则：本次有值即可推进，本次为 NULL 则不覆盖已有值。
 */
export async function upsertWatermarkGuarded(
  tx: Prisma.TransactionClient,
  args: {
    siteDate: string;
    timezoneRevision: number;
    completedAt: Date;
    eventCount: number;
    sourceMaxReceivedAt: Date | null;
    now: Date;
  },
): Promise<number> {
  const { siteDate, timezoneRevision, completedAt, eventCount, sourceMaxReceivedAt, now } = args;
  return tx.$executeRaw`
    INSERT INTO "AnalyticsRollupDay" (
      "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
    ) VALUES (
      ${siteDate},
      ${timezoneRevision},
      ${utc(completedAt)},
      ${eventCount},
      ${sourceMaxReceivedAt === null ? Prisma.sql`NULL` : utc(sourceMaxReceivedAt)},
      ${utc(now)},
      ${utc(now)}
    )
    ON CONFLICT ("siteDate") DO UPDATE SET
      "timezoneRevision" = EXCLUDED."timezoneRevision",
      "completedAt" = EXCLUDED."completedAt",
      "eventCount" = EXCLUDED."eventCount",
      "sourceMaxReceivedAt" = EXCLUDED."sourceMaxReceivedAt",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "AnalyticsRollupDay"."timezoneRevision" <= EXCLUDED."timezoneRevision"
      AND (
        "AnalyticsRollupDay"."sourceMaxReceivedAt" IS NULL
        OR EXCLUDED."sourceMaxReceivedAt" IS NULL
        OR "AnalyticsRollupDay"."sourceMaxReceivedAt" <= EXCLUDED."sourceMaxReceivedAt"
      )
  `;
}

/**
 * 在显式 RepeatableRead 隔离级别下执行一次聚合事务。
 *
 * `db.$transaction` 的第二参数携带 `isolationLevel`，Prisma 会把它下发给
 * `BEGIN ISOLATION LEVEL REPEATABLE READ`，使事务内全部读取共享同一快照。
 */
export async function runInRepeatableReadSnapshot<T>(
  db: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: 5_000,
    timeout: 15_000,
  });
}
