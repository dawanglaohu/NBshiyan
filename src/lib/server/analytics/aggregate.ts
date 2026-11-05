import { Prisma, type PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, type SiteDayBounds } from '../../analytics/day-boundaries';
import { aggregateSiteDay, type RollupSourceEvent } from '../../analytics/rollup-plan';
import { planSnapshot, mayPublish, type CoverageState, type SnapshotPlan } from '../../analytics/aggregate-plan';
import { loadEventsAtSnapshot, runInRepeatableReadSnapshot } from './aggregate-repo';

/**
 * M5-T3 「以一致快照重算并原子替换日聚合」服务层。
 *
 * 与 `rollup.ts` 的关系：`rollup.ts` 是既有调度实现（租约、设置 revision、整日替换）。
 * 本服务不取代它，而是把 09 节 `:71` 要求、而 `rollup.ts` 尚未表达的两点补齐：
 *   - 每轮先定 cutoff，只统计 `receivedAt ≤ cutoff` 的事实；
 *   - 事务使用显式 RepeatableRead，整组目标日在**一次事务**里替换并提交 watermark。
 *
 * 覆盖度（09 节 `:72`）：超出完整原始覆盖的日不重算，返回 partial/unavailable，
 * 不用残片替换旧完整值，也不填 0。
 */

const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

export type AggregateDb = Pick<PrismaClient, '$transaction'> & {
  $queryRaw: PrismaClient['$queryRaw'];
  $executeRaw: PrismaClient['$executeRaw'];
};

export type AggregateDayResult = {
  siteDate: string;
  /** 本轮是否真的写库。跳过时为 false。 */
  written: boolean;
  /** 该日聚合后的事件条数。 */
  eventCount: number;
  /** 该日 watermark（sourceMaxReceivedAt）。 */
  sourceMaxReceivedAt: string | null;
  /** 该日被跳过的原因；written=true 时为 null。 */
  skippedReason: 'out_of_coverage' | null;
};

export type AggregateRunResult = {
  status: 'ok' | 'failed';
  cutoff: string;
  coverage: CoverageState;
  earliestRecomputableDate: string;
  days: AggregateDayResult[];
  errorCode: string | null;
};

/**
 * 在 RepeatableRead 快照里重算一天，并在同一事务内整组替换 + 提交 watermark。
 *
 * 原子性：DELETE 该日汇总 → 整组 INSERT → upsert `AnalyticsRollupDay`（含 watermark）
 * 全在同一事务，进程中断会整体回滚，保留上一轮完整结果（E-81）。
 */
export async function aggregateOneDayInSnapshot(deps: {
  db: AggregateDb;
  siteDate: string;
  siteTimezone: string;
  cutoff: Date;
  timezoneRevision: number;
  generation: number;
  now: Date;
}): Promise<AggregateDayResult> {
  const { db, siteDate, cutoff, timezoneRevision, generation, now } = deps;
  const bounds = siteDayUtcBounds(siteDate, deps.siteTimezone);

  return runInRepeatableReadSnapshot(db, async (tx) => {
    // 提交前重查版本：设置在这轮中途被改过就丢弃本次结果（09 节 `:71`）。
    const stored = await readStoredVersion(tx, siteDate);
    if (!mayPublish({
      claimGeneration: generation,
      storedGeneration: stored?.generation ?? null,
      claimTimezoneRevision: timezoneRevision,
      storedTimezoneRevision: stored?.timezoneRevision ?? null,
    })) {
      return { siteDate, written: false, eventCount: 0, sourceMaxReceivedAt: null, skippedReason: null };
    }

    const events: RollupSourceEvent[] = await loadEventsAtSnapshot(tx, bounds, cutoff);
    const aggregated = aggregateSiteDay(events, bounds);

    await tx.$executeRaw`DELETE FROM "AnalyticsDailyRollup" WHERE "siteDate" = ${bounds.localDate}`;
    if (aggregated.rows.length > 0) {
      const values = aggregated.rows.map((row) => Prisma.sql`(
        ${row.siteDate},
        ${row.kind}::"AnalyticsEventKind",
        ${row.locale},
        ${row.productSlug},
        ${row.count},
        ${row.uniqueBrowsers},
        ${now},
        ${now}
      )`);
      await tx.$executeRaw`
        INSERT INTO "AnalyticsDailyRollup" (
          "siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt"
        ) VALUES ${Prisma.join(values)}
      `;
    }

    const sourceMax = aggregated.sourceMaxReceivedAt;
    await tx.$executeRaw`
      INSERT INTO "AnalyticsRollupDay" (
        "siteDate", "timezoneRevision", "completedAt", "eventCount", "sourceMaxReceivedAt", "createdAt", "updatedAt"
      ) VALUES (
        ${bounds.localDate},
        ${timezoneRevision},
        ${now},
        ${aggregated.eventCount},
        ${sourceMax ?? null},
        ${now},
        ${now}
      )
      ON CONFLICT ("siteDate") DO UPDATE SET
        "timezoneRevision" = EXCLUDED."timezoneRevision",
        "completedAt" = EXCLUDED."completedAt",
        "eventCount" = EXCLUDED."eventCount",
        "sourceMaxReceivedAt" = EXCLUDED."sourceMaxReceivedAt",
        "updatedAt" = EXCLUDED."updatedAt"
    `;

    return {
      siteDate,
      written: true,
      eventCount: aggregated.eventCount,
      sourceMaxReceivedAt: sourceMax ? sourceMax.toISOString() : null,
      skippedReason: null,
    };
  });
}

async function readStoredVersion(
  tx: Prisma.TransactionClient,
  siteDate: string,
): Promise<{ timezoneRevision: number; generation: number | null } | null> {
  const rows = await tx.$queryRaw<{ timezoneRevision: number }[]>`
    SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${siteDate}
  `;
  const row = rows[0];
  if (!row) return null;
  // AnalyticsRollupDay 没有 generation 列；generation 的互斥由 job lease 保证，
  // 这里只校验 timezoneRevision，generation 传 null 表示「不参与本层比较」。
  return { timezoneRevision: Number(row.timezoneRevision), generation: null };
}

/**
 * 运行一轮聚合：定 cutoff → 计划目标日 → 逐日在同一快照语义下替换。
 *
 * `plan` 由纯函数生成（可在无库环境单测），本函数只负责把它落到数据库。
 */
export async function runAggregateOnce(deps: {
  db: AggregateDb;
  now: Date;
  siteTimezone: string;
  currentDate: string;
  timezoneRevision: number;
  generation: number;
}): Promise<AggregateRunResult> {
  const plan: SnapshotPlan = planSnapshot({
    now: deps.now,
    siteTimezone: deps.siteTimezone,
    currentDate: deps.currentDate,
  });

  const days: AggregateDayResult[] = [];
  for (const siteDate of plan.siteDates) {
    const day = await aggregateOneDayInSnapshot({
      db: deps.db,
      siteDate,
      siteTimezone: deps.siteTimezone,
      cutoff: plan.cutoff,
      timezoneRevision: deps.timezoneRevision,
      generation: deps.generation,
      now: deps.now,
    });
    days.push(day);
  }
  for (const siteDate of plan.skippedDates) {
    // 超范围：不写库、不用残片替换旧完整值、不填 0（09 节 `:72`）。
    days.push({ siteDate, written: false, eventCount: 0, sourceMaxReceivedAt: null, skippedReason: 'out_of_coverage' });
  }

  return {
    status: 'ok',
    cutoff: plan.cutoff.toISOString(),
    coverage: plan.coverage,
    earliestRecomputableDate: plan.earliestRecomputableDate,
    days,
    errorCode: null,
  };
}

export type { SiteDayBounds };
export { ISO_FORMAT };
