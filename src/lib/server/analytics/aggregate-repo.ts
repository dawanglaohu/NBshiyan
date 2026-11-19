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
 * 在 RepeatableRead 快照内读取一天的事件，按 `receivedAt ≤ cutoff` 过滤。
 *
 * 可选的 `notAfter` 再按 `occurredAt ≤ notAfter` 截断：调度作业传本轮业务时钟，
 * 保证客户端时钟最多领先 5 分钟准入的未来事件，到其 occurredAt 前不提前计入
 * （E-60）。不传时保持既有快照语义——只由 receivedAt 截断（M5-T3 的 R7 会话
 * 一致性用例依赖这一点，日末事件仍属当日快照）。
 */
export async function loadEventsAtSnapshot(
  db: Query,
  bounds: SiteDayBounds,
  cutoff: Date,
  options: { notAfter?: Date } = {},
): Promise<RollupSourceEvent[]> {
  const occurredUpper = options.notAfter
    ? Prisma.sql`AND "occurredAt" <= ${utc(options.notAfter)}`
    : Prisma.empty;
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
      ${occurredUpper}
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
 * 带 WHERE 守卫的 watermark upsert。返回受影响行数；0 表示数据库拒绝了这次提交，
 * 调用方必须让整个事务回滚（`writeOneDayInTx` 里 `affected !== 1` 抛错），不能吞成部分成功。
 *
 * 守卫按 timezoneRevision 分流：
 * - **较新 revision**（stored < incoming）：允许重定基准，NULL 与更小的 `sourceMaxReceivedAt`
 *   都接受。时区代次前进后同一站点日的边界整体移动，旧水位不再可比，只能以新快照为准（E-83）。
 * - **同 revision**：watermark 只能单调前进——已存 NULL 时可写任意值；已存非 NULL 时，
 *   本次为 NULL 或更小都拒绝，相等/更大才接受（E-80）。空日不得把真实水位改写成 NULL。
 * - **更低 revision**：两个分支都不成立，直接拒绝（旧时区代次不得覆盖新结果）。
 *
 * 初次插入（无冲突行）不经过 WHERE，NULL 也允许。
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
    WHERE (
      "AnalyticsRollupDay"."timezoneRevision" < EXCLUDED."timezoneRevision"
      OR (
        "AnalyticsRollupDay"."timezoneRevision" = EXCLUDED."timezoneRevision"
        AND (
          "AnalyticsRollupDay"."sourceMaxReceivedAt" IS NULL
          OR (
            EXCLUDED."sourceMaxReceivedAt" IS NOT NULL
            AND "AnalyticsRollupDay"."sourceMaxReceivedAt" <= EXCLUDED."sourceMaxReceivedAt"
          )
        )
      )
    )
  `;
}

/**
 * 在显式 RepeatableRead 隔离级别下执行一次聚合事务。
 *
 * `db.$transaction` 的第二参数携带 `isolationLevel`，Prisma 会把它下发给
 * `BEGIN ISOLATION LEVEL REPEATABLE READ`，使事务内全部读取共享同一快照。
 * 调用方给出 `timeoutMs` 时按它截断（不再有最小值下限，避免反向扩大预算），
 * 事务内先设 statement_timeout / lock_timeout：单句 SQL 与行锁等待都不得越过预算。
 */
export async function runInRepeatableReadSnapshot<T>(
  db: Pick<PrismaClient, '$transaction'>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeoutMs?: number; maxWaitMs?: number } = {},
): Promise<T> {
  const timeout = options.timeoutMs === undefined
    ? 15_000
    : Math.max(1, Math.min(options.timeoutMs, 60_000));
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeout}`);
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${timeout}`);
    return fn(tx);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: options.maxWaitMs ?? 5_000,
    timeout,
  });
}

/* ------------------------------------------------------------------------- *
 * M5-T12 日聚合读取面（Q1–Q5）
 *
 * 语义取自 r5r3 设计 §4 与模型 `q1`–`q5`：
 * - 同一 RR 快照、同一 `cutoff`；`receivedAt` 必须落在 `(eventCutoff, cutoff]`。
 * - 冒烟谓词在 SQL 与应用层同一条：整条路径或以 `/` 分隔的任一段以 `nbs-smoke-` 开头。
 * - Q1 只按站点日界读当日事实；Q3 终态**不按自身发生日过滤**（归 start 日）；
 *   Q2/Q5 只投 occurredAt / receivedAt，不返回事件正文。
 * ------------------------------------------------------------------------- */

/** 与 `isSmokePath` 同一条规则的 SQL 形态；NULL 路径放行。 */
export const NOT_SMOKE_SQL = Prisma.sql`( "path" IS NULL OR (
  split_part(split_part("path", '?', 1), '#', 1) NOT LIKE 'nbs-smoke-%'
  AND split_part(split_part("path", '?', 1), '#', 1) NOT LIKE '%/nbs-smoke-%'
) )`;

const DAILY_KINDS_SQL = Prisma.sql`'page_view'::"AnalyticsEventKind", 'product_view'::"AnalyticsEventKind",
  'model_view_start'::"AnalyticsEventKind", 'model_load_success'::"AnalyticsEventKind",
  'model_load_failure'::"AnalyticsEventKind", 'chat_start'::"AnalyticsEventKind"`;

const FACT_COLUMNS = Prisma.sql`
  "eventId",
  "kind"::text AS "kind",
  "browserHash",
  "viewId",
  to_char("occurredAt", ${ISO_FORMAT}) AS "occurredAt",
  to_char("receivedAt", ${ISO_FORMAT}) AS "receivedAt",
  "durationMs",
  "locale",
  "productSlug",
  "path"
`;

/** 读回行：时间为 ISO 字符串，统一由 `mapFact` 转 Date。 */
export type DailyFactRow = {
  eventId: string;
  kind: string;
  browserHash: string;
  viewId: string | null;
  occurredAt: string;
  receivedAt: string;
  durationMs: number | null;
  locale: string | null;
  productSlug: string | null;
  path: string | null;
};

export type DailyFact = Omit<DailyFactRow, 'occurredAt' | 'receivedAt'> & {
  occurredAt: Date;
  receivedAt: Date;
};

function mapFact(row: DailyFactRow): DailyFact {
  return {
    eventId: row.eventId,
    kind: row.kind,
    browserHash: row.browserHash,
    viewId: row.viewId,
    occurredAt: new Date(row.occurredAt),
    receivedAt: new Date(row.receivedAt),
    durationMs: row.durationMs,
    locale: row.locale,
    productSlug: row.productSlug,
    path: row.path,
  };
}

/** Q1：站点日内、`(eventCutoff, cutoff]` 可见、非冒烟的事实（含终态；纯函数再按 notAfter 分区）。 */
export async function loadDailyDayFacts(
  db: Query,
  bounds: SiteDayBounds,
  options: { cutoff: Date; eventCutoff: Date },
): Promise<DailyFact[]> {
  const rows = await db.$queryRaw<DailyFactRow[]>`
    SELECT ${FACT_COLUMNS}
    FROM "AnalyticsEvent"
    WHERE "occurredAt" >= ${utc(new Date(bounds.startUtc))}
      AND "occurredAt" < ${utc(new Date(bounds.endUtc))}
      AND "receivedAt" > ${utc(options.eventCutoff)}
      AND "receivedAt" <= ${utc(options.cutoff)}
      AND "kind" IN (${DAILY_KINDS_SQL})
      AND ${NOT_SMOKE_SQL}
    ORDER BY "occurredAt" ASC, "eventId" ASC
  `;
  return rows.map(mapFact);
}

/** Q2：终态 → start 的归属查询；同键取 occurredAt 最早（同刻按 eventId 稳定）。 */
export async function findEarliestStart(
  db: Query,
  args: { browserHash: string; viewId: string; cutoff: Date; eventCutoff: Date },
): Promise<{ occurredAt: Date } | null> {
  const rows = await db.$queryRaw<{ occurredAt: string }[]>`
    SELECT to_char("occurredAt", ${ISO_FORMAT}) AS "occurredAt"
    FROM "AnalyticsEvent"
    WHERE "browserHash" = ${args.browserHash}
      AND "viewId" = ${args.viewId}
      AND "kind" = 'model_view_start'::"AnalyticsEventKind"
      AND "receivedAt" > ${utc(args.eventCutoff)}
      AND "receivedAt" <= ${utc(args.cutoff)}
      AND ${NOT_SMOKE_SQL}
    ORDER BY "occurredAt" ASC, "eventId" ASC
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : { occurredAt: new Date(row.occurredAt) };
}

export type StartKey = { browserHash: string; viewId: string };

/** 单片键上限：行值 IN 列表过大会顶到参数上限，也失去有界查询的意义。 */
export const PAIRED_KEYS_CHUNK = 400;

/** Q3：本日 start 键的配对终态；不按终态自身发生日过滤，冒烟谓词一致。 */
export async function loadPairedTerminals(
  db: Query,
  keys: readonly StartKey[],
  options: { cutoff: Date; eventCutoff: Date },
): Promise<DailyFact[]> {
  const unique = new Map<string, StartKey>();
  for (const key of keys) unique.set(`${key.browserHash}\u0000${key.viewId}`, key);
  const list = [...unique.values()];
  const out: DailyFact[] = [];
  for (let offset = 0; offset < list.length; offset += PAIRED_KEYS_CHUNK) {
    const slice = list.slice(offset, offset + PAIRED_KEYS_CHUNK);
    const pairs = slice.map((key) => Prisma.sql`(${key.browserHash}, ${key.viewId})`);
    const rows = await db.$queryRaw<DailyFactRow[]>(Prisma.sql`
      SELECT ${FACT_COLUMNS}
      FROM "AnalyticsEvent"
      WHERE ("browserHash", "viewId") IN (${Prisma.join(pairs)})
        AND "kind" IN ('model_load_success'::"AnalyticsEventKind", 'model_load_failure'::"AnalyticsEventKind")
        AND "receivedAt" > ${utc(options.eventCutoff)}
        AND "receivedAt" <= ${utc(options.cutoff)}
        AND ${NOT_SMOKE_SQL}
      ORDER BY "occurredAt" ASC, "eventId" ASC
    `);
    for (const row of rows) out.push(mapFact(row));
  }
  return out;
}

/** Q4：跨日可见倒置 guard——站点日内但 `receivedAt > cutoff` 的一行（非冒烟、raw 未删）。 */
export async function probeCrossDayInversion(
  db: Query,
  bounds: SiteDayBounds,
  options: { cutoff: Date; eventCutoff: Date },
): Promise<{ eventId: string; kind: string; occurredAt: Date; receivedAt: Date } | null> {
  const rows = await db.$queryRaw<{
    eventId: string;
    kind: string;
    occurredAt: string;
    receivedAt: string;
  }[]>`
    SELECT
      "eventId",
      "kind"::text AS "kind",
      to_char("occurredAt", ${ISO_FORMAT}) AS "occurredAt",
      to_char("receivedAt", ${ISO_FORMAT}) AS "receivedAt"
    FROM "AnalyticsEvent"
    WHERE "occurredAt" >= ${utc(new Date(bounds.startUtc))}
      AND "occurredAt" < ${utc(new Date(bounds.endUtc))}
      AND "receivedAt" > ${utc(options.cutoff)}
      AND "receivedAt" > ${utc(options.eventCutoff)}
      AND ${NOT_SMOKE_SQL}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    eventId: row.eventId,
    kind: row.kind,
    occurredAt: new Date(row.occurredAt),
    receivedAt: new Date(row.receivedAt),
  };
}

/**
 * Q5：可见倒置探测——终态已可见、但其 start 的 `receivedAt > cutoff`（尚未进入本快照）。
 * 命中说明这不是孤儿终态而是快照边界，必须让当日停手（guard），不能写成 late_unattributable。
 */
export async function probeFilteredStartInversion(
  db: Query,
  args: { browserHash: string; viewId: string; cutoff: Date; eventCutoff: Date },
): Promise<{ occurredAt: Date; receivedAt: Date } | null> {
  const rows = await db.$queryRaw<{ occurredAt: string; receivedAt: string }[]>`
    SELECT
      to_char("occurredAt", ${ISO_FORMAT}) AS "occurredAt",
      to_char("receivedAt", ${ISO_FORMAT}) AS "receivedAt"
    FROM "AnalyticsEvent"
    WHERE "browserHash" = ${args.browserHash}
      AND "viewId" = ${args.viewId}
      AND "kind" = 'model_view_start'::"AnalyticsEventKind"
      AND "receivedAt" > ${utc(args.cutoff)}
      AND "receivedAt" > ${utc(args.eventCutoff)}
      AND ${NOT_SMOKE_SQL}
    ORDER BY "receivedAt" ASC, "eventId" ASC
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? null : { occurredAt: new Date(row.occurredAt), receivedAt: new Date(row.receivedAt) };
}
