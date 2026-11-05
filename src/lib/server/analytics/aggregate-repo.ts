import { Prisma, type PrismaClient } from '@prisma/client';
import type { SiteDayBounds } from '../../analytics/day-boundaries';
import type { RollupSourceEvent } from '../../analytics/rollup-plan';

/**
 * M5-T3 一致快照聚合的数据库层。
 *
 * 与既有 `rollup.ts` 的分工：`rollup.ts` 负责调度、租约、设置版本校验与整日替换；
 * 本文件只补它缺的两件东西——
 * 1. **显式 RepeatableRead 快照**：一次聚合内所有读取都落在同一快照上；
 * 2. **`receivedAt ≤ cutoff` 过滤**：cutoff 之后到达的新事件留给下一轮，不在已发布结果上滚加（E-80）。
 *
 * 为什么要显式 RepeatableRead：`rollup.ts` 的 `loadEvents` 目前虽只发一条 SELECT，
 * 在 ReadCommitted 下单条 SELECT 本身自洽；但接下来的写（DELETE + 整组 INSERT + upsert watermark）
 * 与读处于同一事务，显式声明隔离级别能把「读写同快照」变成可断言的不变式，
 * 而不是依赖「当前恰好只有一条 SELECT」这个实现细节。今后若 loadEvents 改成多条查询或分页，
 * ReadCommitted 会静默退化为读不一致，显式 RepeatableRead 可以挡住这种退化。
 */

/** 只读查询面，便于单测注入。 */
export type Query = { $queryRaw: PrismaClient['$queryRaw'] };

/** 聚合写入面。 */
export type AggregateTx = Query & {
  $executeRaw: PrismaClient['$executeRaw'];
};

const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

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
    WHERE "occurredAt" >= ${new Date(bounds.startUtc)}
      AND "occurredAt" < ${new Date(bounds.endUtc)}
      AND "receivedAt" <= ${cutoff}
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
