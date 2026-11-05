import { Prisma, type PrismaClient } from '@prisma/client';
import { siteDayUtcBounds, type SiteDayBounds } from '../../analytics/day-boundaries';
import { aggregateSiteDay, type RollupSourceEvent } from '../../analytics/rollup-plan';
import { planSnapshot, type CoverageState, type SnapshotPlan } from '../../analytics/aggregate-plan';
import {
  loadEventsAtSnapshot,
  readLockedGeneration,
  runInRepeatableReadSnapshot,
  upsertWatermarkGuarded,
} from './aggregate-repo';

/**
 * M5-T3 「以一致快照重算并原子替换日聚合」服务层。
 *
 * 与 `rollup.ts` 的关系：`rollup.ts` 是既有调度实现（租约、设置 revision、整日替换）。
 * 本服务不取代它，而是把 09 节 `:71` 要求、而 `rollup.ts` 尚未表达的三点补齐：
 *   - 每轮先定 cutoff，只统计 `receivedAt ≤ cutoff` 的事实；
 *   - 事务使用显式 RepeatableRead，整组目标日在**一次事务**里替换并提交 watermark；
 *   - 用数据库行锁与带 WHERE 守卫的 upsert 做 generation/版本互斥，而非仅内存判断。
 *
 * 覆盖度（09 节 `:72`）：超出完整原始覆盖的日不重算，返回 partial/unavailable，
 * 不用残片替换旧完整值，也不填 0。
 */

/** 并发/版本冲突：调用方应让整个事务回滚，不写任何半成品。 */
export class AggregateVersionConflict extends Error {
  constructor(reason: 'stale_generation' | 'stale_timezone_revision' | 'watermark_regression') {
    super(reason);
    this.name = 'AggregateVersionConflict';
  }
}

export type AggregateDb = Pick<PrismaClient, '$transaction'> & {
  $queryRaw: PrismaClient['$queryRaw'];
  $executeRaw: PrismaClient['$executeRaw'];
};

export type AggregateDayResult = {
  siteDate: string;
  /** 本轮是否真的写库。冲突／跳过时为 false。 */
  written: boolean;
  eventCount: number;
  sourceMaxReceivedAt: string | null;
  /** 被跳过的原因；written=true 时为 null。 */
  skippedReason: 'out_of_coverage' | 'version_conflict' | null;
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
 * 在**一个** RepeatableRead 事务里完成一天的全部写入：
 *
 *   1. `SELECT ... FOR UPDATE` 锁住 `analytics-aggregate` 的 JobState 行并真读 generation；
 *   2. 校验传入 generation 不低于库里的代次（旧任务不能覆盖新结果，E-81）；
 *   3. 读已存 timezoneRevision，旧时区代次直接判冲突（E-83）；
 *   4. 按 cutoff 读事件、DELETE 该日汇总、整组 INSERT；
 *   5. 带 WHERE 守卫的 upsert 提交 watermark；
 *   6. 返回。任一步失败抛错，整个事务回滚，上一轮完整结果保留。
 *
 * 关键：`DELETE + 整组 INSERT + watermark upsert` 全在同一个 `tx` 上，
 * 不存在「先删旧结果、再分批填充可见半成品」的窗口（09 节 `:71`）。
 * 守卫是数据库级的：受影响行数为 0 或行锁读到的代次较新，都会抛错并回滚，
 * 不依赖纯函数 `mayPublish` 的事先放行。
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
    // 2. 真行锁 + 真读代次：库里代次比本次新，说明旧任务在覆盖新结果，直接拒。
    const lockedGeneration = await readLockedGeneration(tx);
    if (lockedGeneration !== null && lockedGeneration > generation) {
      throw new AggregateVersionConflict('stale_generation');
    }

    // 3. 真读已存版本，旧时区代次不得写入。
    const storedRevisionRows = await tx.$queryRaw<{ timezoneRevision: number }[]>`
      SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${siteDate}
    `;
    const storedRevision = storedRevisionRows[0] ? Number(storedRevisionRows[0].timezoneRevision) : null;
    if (storedRevision !== null && storedRevision > timezoneRevision) {
      throw new AggregateVersionConflict('stale_timezone_revision');
    }

    const events: RollupSourceEvent[] = await loadEventsAtSnapshot(tx, bounds, cutoff);
    const aggregated = aggregateSiteDay(events, bounds);

    // 4. 同一 tx 内整组替换（DELETE + 一次 INSERT 全部行）。
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

    // 5. 带 WHERE 守卫提交 watermark；0 行表示旧代次/旧 watermark 试图覆盖，回滚。
    const sourceMax = aggregated.sourceMaxReceivedAt;
    const affected = await upsertWatermarkGuarded(tx, {
      siteDate: bounds.localDate,
      timezoneRevision,
      completedAt: now,
      eventCount: aggregated.eventCount,
      sourceMaxReceivedAt: sourceMax,
      now,
    });
    if (affected !== 1) throw new AggregateVersionConflict('watermark_regression');

    return {
      siteDate,
      written: true,
      eventCount: aggregated.eventCount,
      sourceMaxReceivedAt: sourceMax ? sourceMax.toISOString() : null,
      skippedReason: null,
    };
  });
}

/**
 * 运行一轮聚合：定 cutoff → 计划目标日 → 逐日在同一快照语义下替换。
 *
 * `plan` 由纯函数生成（可在无库环境单测），本函数只负责把它落到数据库。
 * 单个目标日发生版本冲突时，该日记为 version_conflict，不阻断其余目标日。
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
    try {
      days.push(await aggregateOneDayInSnapshot({
        db: deps.db,
        siteDate,
        siteTimezone: deps.siteTimezone,
        cutoff: plan.cutoff,
        timezoneRevision: deps.timezoneRevision,
        generation: deps.generation,
        now: deps.now,
      }));
    } catch (error) {
      if (!(error instanceof AggregateVersionConflict)) throw error;
      days.push({ siteDate, written: false, eventCount: 0, sourceMaxReceivedAt: null, skippedReason: 'version_conflict' });
    }
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
