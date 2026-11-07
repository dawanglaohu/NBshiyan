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

/** 与 aggregate-repo / rollup / event-repo 相同：ISO 字符串再按 UTC 写入 timestamp，避免会话时区平移。 */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/**
 * M5-T3 「以一致快照重算并原子替换日聚合」服务层。
 *
 * 09 节 `:71` 的三条硬要求：
 *   - 每轮先定 cutoff，只统计 `receivedAt ≤ cutoff` 的事实；
 *   - **整组目标日 + 各自 watermark 在一条 RepeatableRead 事务里替换**，
 *     任一目标日失败整组回滚，进程中断保留上一轮完整结果；
 *   - 用数据库行锁与带 WHERE 守卫的 upsert 做 generation/版本互斥，而非内存判断。
 *
 * 覆盖度（09 节 `:72`）：超出完整原始覆盖的日不重算，返回 partial/unavailable，
 * 不用残片替换旧完整值，也不填 0。
 */

/** 并发/版本冲突：让整组事务回滚，不写任何半成品。 */
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
  /** 本轮是否真的写库。跳过时为 false。 */
  written: boolean;
  eventCount: number;
  sourceMaxReceivedAt: string | null;
  /** 被跳过的原因；written=true 时为 null。 */
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

type DayArgs = {
  siteDate: string;
  siteTimezone: string;
  cutoff: Date;
  timezoneRevision: number;
  now: Date;
};

/**
 * 在一个**已开启**的 RepeatableRead 事务 `tx` 上处理一天的全部写入。
 * 不再自己 `$transaction`：调用方负责把整组目标日放进同一事务，实现整组原子替换。
 *
 * 步骤：按 cutoff 读事件 → DELETE 该日汇总 → 整组 INSERT → 带 WHERE 守卫 upsert watermark。
 * watermark 受影响行数为 0（旧代次/旧 watermark 试图覆盖）时抛错，让整组事务回滚。
 */
async function writeOneDayInTx(
  tx: Prisma.TransactionClient,
  args: DayArgs,
): Promise<AggregateDayResult> {
  const { siteDate, cutoff, timezoneRevision, now } = args;
  const bounds = siteDayUtcBounds(siteDate, args.siteTimezone);

  // 真读已存版本，旧时区代次不得写入（E-83）。
  const storedRevisionRows = await tx.$queryRaw<{ timezoneRevision: number }[]>`
    SELECT "timezoneRevision" FROM "AnalyticsRollupDay" WHERE "siteDate" = ${siteDate}
  `;
  const storedRevision = storedRevisionRows[0] ? Number(storedRevisionRows[0].timezoneRevision) : null;
  if (storedRevision !== null && storedRevision > timezoneRevision) {
    throw new AggregateVersionConflict('stale_timezone_revision');
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
      ${utc(now)},
      ${utc(now)}
    )`);
    await tx.$executeRaw`
      INSERT INTO "AnalyticsDailyRollup" (
        "siteDate", "kind", "locale", "productSlug", "count", "uniqueBrowsers", "createdAt", "updatedAt"
      ) VALUES ${Prisma.join(values)}
    `;
  }

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
}

/**
 * 单独处理一天（保留给单日验证／测试用）。仍是一条 RepeatableRead 事务，
 * 但生产整组路径请用 `runAggregateOnce`，它把多天放进同一事务。
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
  const { db, generation } = deps;
  return runInRepeatableReadSnapshot(db, async (tx) => {
    const lockedGeneration = await readLockedGeneration(tx);
    if (lockedGeneration !== null && lockedGeneration > generation) {
      throw new AggregateVersionConflict('stale_generation');
    }
    return writeOneDayInTx(tx, {
      siteDate: deps.siteDate,
      siteTimezone: deps.siteTimezone,
      cutoff: deps.cutoff,
      timezoneRevision: deps.timezoneRevision,
      now: deps.now,
    });
  });
}

/**
 * 整轮聚合：**一条** RepeatableRead 事务覆盖全部目标日。
 *
 * 事务开头做一次行锁 + generation 校验；随后对每个目标日用同一个 `tx`
 * 顺序执行 DELETE/INSERT/watermark。任一天失败或版本冲突 → 异常抛到事务外，
 * 整组回滚，一天都不写，上一轮完整结果保留（E-81 / 09 节 `:71`）。
 * 超范围的日不进事务，只在结果里标记 out_of_coverage。
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

  let days: AggregateDayResult[] = [];
  // 整组事务：任一天失败或版本冲突都会把异常抛到这里，Prisma 整笔回滚，一天都不写。
  // 不 catch 成「部分成功」——09 节 `:71` 禁止留下部分天新、部分天旧的半成品。
  days = await runInRepeatableReadSnapshot(deps.db, async (tx) => {
    // 整组只做一次行锁与代次校验。
    const lockedGeneration = await readLockedGeneration(tx);
    if (lockedGeneration !== null && lockedGeneration > deps.generation) {
      throw new AggregateVersionConflict('stale_generation');
    }
    const written: AggregateDayResult[] = [];
    for (const siteDate of plan.siteDates) {
      written.push(await writeOneDayInTx(tx, {
        siteDate,
        siteTimezone: deps.siteTimezone,
        cutoff: plan.cutoff,
        timezoneRevision: deps.timezoneRevision,
        now: deps.now,
      }));
    }
    return written;
  });

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
