import { Prisma, type PrismaClient } from '@prisma/client';
import { shiftLocalDate } from '../../analytics/aggregate-plan';
import { siteDayUtcBounds, type SiteDayBounds } from '../../analytics/day-boundaries';
import { rollupExpiresAt } from './retention-plan';

/**
 * M5-T12 日聚合的元数据层：`AnalyticsAggregateDayState`（marker/defer/gap 落点）与
 * `AnalyticsDayChange`（UTC 日 live 版本）。
 *
 * 语义取自 r5r3 设计 §5/§6 与模型 `gap_write_cas` / `coverage_write` / `commit`：
 * - 四个写者（日提交、gap、覆盖、bootstrap）用**同一个 `$now` 源、同一精度**显式写 `updatedAt`；
 *   raw SQL 不依赖 Prisma `@updatedAt` 的写路径，避免两套时钟。
 * - CAS 同时比较 `markerVersions` 与 `updatedAt`：只比 markers 会放过「markers 相同、
 *   updatedAt 不同」的并发写（R2 第二守卫）。
 * - 行存在时 `expectedUpdatedAt=NULL` 永不匹配（SQL `= NULL` 为 NULL）；`NULL` 只用于
 *   「确认当时无该行」的插入分支，且此时 expected markers 必须是空对象。
 */

/** 十进制字符串，避免 BigInt 版本在 JS number 上丢精度。缺键按 0 比。 */
export type MarkerVersions = Record<string, string>;

/** 终止类 gap：不再重试；`deferUntil` 保留为 partial 证据。 */
export const TERMINAL_GAPS: ReadonlySet<string> = new Set(['raw_partial', 'not_backfilled']);

/** 可重试 gap：每轮重来，直到成功或转为覆盖元数据。 */
export const RETRY_GAPS: ReadonlySet<string> = new Set(['clock_inversion', 'budget', 'late_unattributable']);

export const DAY_STATE_DEFAULT_MAX_DAYS = 500;

export type DayStateKey = { localDate: string; timezoneRevision: number };

export type DayStateRow = {
  localDate: string;
  timezoneRevision: number;
  timezone: string;
  markerVersions: MarkerVersions;
  deferUntil: Date | null;
  gapKind: string | null;
  gapSince: Date | null;
  /** 上一次真实写入时刻；CAS 的期望值只能来自读回的这一列。 */
  updatedAt: Date;
};

export type StateDb = {
  $queryRaw: PrismaClient['$queryRaw'];
  $executeRaw: PrismaClient['$executeRaw'];
};

const ISO_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/** 与 rollup / event-repo / retention 相同的 UTC 绑定：不让会话时区参与 timestamp 解释。 */
export function utc(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

/** `updatedAt` 读回：ISO 再转 Date，与写入精度（毫秒）逐位一致。 */
function parseIso(value: string): Date {
  return new Date(value);
}

/** `markerVersions` 一律按字符串读：Prisma 的 JsonValue 可能是 number，BigInt 只留在 DB 侧相加。 */
export function parseMarkerVersions(value: unknown): MarkerVersions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: MarkerVersions = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      out[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = BigInt(Math.trunc(raw)).toString();
    } else if (typeof raw === 'bigint') {
      out[key] = raw.toString();
    }
  }
  return out;
}

/** 单日 day-state；不存在返回 null（首次运行/未覆盖）。 */
export async function readDayState(db: StateDb, key: DayStateKey): Promise<DayStateRow | null> {
  const rows = await db.$queryRaw<{
    localDate: string;
    timezoneRevision: number;
    timezone: string;
    markerVersions: unknown;
    deferUntil: string | null;
    gapKind: string | null;
    gapSince: string | null;
    updatedAt: string;
  }[]>`
    SELECT
      "localDate",
      "timezoneRevision",
      "timezone",
      "markerVersions",
      to_char("deferUntil", ${ISO_FORMAT}) AS "deferUntil",
      "gapKind",
      to_char("gapSince", ${ISO_FORMAT}) AS "gapSince",
      to_char("updatedAt", ${ISO_FORMAT}) AS "updatedAt"
    FROM "AnalyticsAggregateDayState"
    WHERE "localDate" = ${key.localDate} AND "timezoneRevision" = ${key.timezoneRevision}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    localDate: row.localDate,
    timezoneRevision: Number(row.timezoneRevision),
    timezone: row.timezone,
    markerVersions: parseMarkerVersions(row.markerVersions),
    deferUntil: row.deferUntil === null ? null : parseIso(row.deferUntil),
    gapKind: row.gapKind,
    gapSince: row.gapSince === null ? null : parseIso(row.gapSince),
    updatedAt: parseIso(row.updatedAt),
  };
}

/** 扫描域内当前 revision 的全部 day-state（一次读，供 plan 判脏）。 */
export async function readDayStatesInDomain(
  db: StateDb,
  revision: number,
  fromLocalDate: string,
  beforeLocalDate: string,
): Promise<Map<string, DayStateRow>> {
  const rows = await db.$queryRaw<{
    localDate: string;
    timezoneRevision: number;
    timezone: string;
    markerVersions: unknown;
    deferUntil: string | null;
    gapKind: string | null;
    gapSince: string | null;
    updatedAt: string;
  }[]>`
    SELECT
      "localDate",
      "timezoneRevision",
      "timezone",
      "markerVersions",
      to_char("deferUntil", ${ISO_FORMAT}) AS "deferUntil",
      "gapKind",
      to_char("gapSince", ${ISO_FORMAT}) AS "gapSince",
      to_char("updatedAt", ${ISO_FORMAT}) AS "updatedAt"
    FROM "AnalyticsAggregateDayState"
    WHERE "timezoneRevision" = ${revision}
      AND "localDate" >= ${fromLocalDate}
      AND "localDate" < ${beforeLocalDate}
  `;
  const out = new Map<string, DayStateRow>();
  for (const row of rows) {
    out.set(row.localDate, {
      localDate: row.localDate,
      timezoneRevision: Number(row.timezoneRevision),
      timezone: row.timezone,
      markerVersions: parseMarkerVersions(row.markerVersions),
      deferUntil: row.deferUntil === null ? null : parseIso(row.deferUntil),
      gapKind: row.gapKind,
      gapSince: row.gapSince === null ? null : parseIso(row.gapSince),
      updatedAt: parseIso(row.updatedAt),
    });
  }
  return out;
}

/** 全表 live 版本。GC 保证表内只留 13 个自然月＋2 天，行数有界（约 400 行）。 */
export async function readLiveMarkerVersions(db: StateDb): Promise<Map<string, string>> {
  const rows = await db.$queryRaw<{ utcDate: string; version: bigint | string | number }[]>`
    SELECT "utcDate", "version" FROM "AnalyticsDayChange"
  `;
  const out = new Map<string, string>();
  for (const row of rows) {
    out.set(row.utcDate, String(row.version));
  }
  return out;
}

/** 当前 revision 已有 site 行的站点日：plan 用来区分「无 state 但已聚合」与 bootstrap。 */
export async function readSiteRowDatesInDomain(
  db: StateDb,
  revision: number,
  fromLocalDate: string,
  beforeLocalDate: string,
): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ localDate: string }[]>`
    SELECT "localDate"
    FROM "AnalyticsDaily"
    WHERE "timezoneRevision" = ${revision}
      AND "dimension" = 'site'
      AND "localDate" >= ${fromLocalDate}
      AND "localDate" < ${beforeLocalDate}
  `;
  return new Set(rows.map((row) => row.localDate));
}

/**
 * 事件接收后 bump 其 occurredAt 的 UTC 日版本；终态额外 bump 配对 start 的 UTC 日版本
 * （对齐模型 `Db.add`：终态会把 start 日重新标脏）。
 *
 * 先 bump 再写事件是刻意选择：崩溃只留下「多一次重算」，不会出现「事件已落库但版本没前进」
 * 导致当日被误判 complete。重复投递多 bump 一次同样只多一次重算。
 */
export async function bumpDayChangeVersions(
  db: StateDb,
  utcDates: readonly string[],
  now: Date,
): Promise<void> {
  const unique = [...new Set(utcDates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  if (unique.length === 0) return;
  const values = unique.map((utcDate) => Prisma.sql`(${utcDate}, 1, ${utc(now)})`);
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsDayChange" ("utcDate", "version", "updatedAt")
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("utcDate") DO UPDATE SET
      "version" = "AnalyticsDayChange"."version" + 1,
      "updatedAt" = EXCLUDED."updatedAt"
  `);
}

/** 接收侧写入的 marker 落点；`ingest` 只依赖这个窄接口，便于注入与单测。 */
export type AnalyticsDayMarkerEvent = {
  occurredAt: Date;
  kind: string;
  browserHash: string;
  viewId: string | null;
  path?: string | null;
};

export type AnalyticsDayMarkerSink = {
  /** 先于事件落库调用：崩溃只会多一次重算，不会漏掉版本前进。 */
  bump(events: readonly AnalyticsDayMarkerEvent[], at: Date): Promise<void>;
};

/**
 * 事件接收的 marker 落点：bump 事件 occurredAt 的 UTC 日；终态再 bump 配对 start 的 UTC 日。
 *
 * 与模型 `Db.add` 一致：终态会让 **start 那一天**重新变脏，否则两天前的 start 日
 * 永远等不到配对终态更新。smoke 事件同样 bump（它不计数，但会让当日重算一次并消费版本）。
 */
export function createAnalyticsDayMarkerSink(db: StateDb): AnalyticsDayMarkerSink {
  return {
    async bump(events, at) {
      if (events.length === 0) return;
      const dates: string[] = [];
      for (const event of events) {
        if (!Number.isFinite(event.occurredAt.getTime())) continue;
        dates.push(event.occurredAt.toISOString().slice(0, 10));
      }
      const terminalKeys = events.filter(
        (event) => event.kind === 'model_load_success' || event.kind === 'model_load_failure',
      ).filter((event) => event.viewId !== null);
      if (terminalKeys.length > 0) {
        const pairs = terminalKeys.map((event) => Prisma.sql`(${event.browserHash}, ${event.viewId})`);
        const rows = await db.$queryRaw<{ utcDate: string }[]>(Prisma.sql`
          SELECT DISTINCT to_char(("occurredAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS "utcDate"
          FROM "AnalyticsEvent"
          WHERE "kind" = 'model_view_start'::"AnalyticsEventKind"
            AND ("browserHash", "viewId") IN (${Prisma.join(pairs)})
        `);
        for (const row of rows) dates.push(row.utcDate);
      }
      await bumpDayChangeVersions(db, dates, at);
    },
  };
}

/**
 * 一天日提交或 gap 写入的 CAS upsert。
 *
 * - 行存在：`markerVersions` 与 `updatedAt` 都必须等于期望值，否则影响 0 行。
 * - 行不存在且 `expectedUpdatedAt === null` 且 expected markers 为空：普通插入。
 * - 行存在但 `expectedUpdatedAt === null`：SQL 的 `= NULL` 为 NULL，永不匹配（R2）。
 *
 * 返回受影响行数；0 表示并发写已经推进了该行，调用方必须放弃本次写入并回滚。
 */
export async function casWriteDayState(
  db: StateDb,
  args: {
    localDate: string;
    timezoneRevision: number;
    timezone: string;
    markerVersions: MarkerVersions;
    deferUntil: Date | null;
    gapKind: string | null;
    gapSince: Date | null;
    expectedMarkers: MarkerVersions;
    expectedUpdatedAt: Date | null;
    now: Date;
  },
): Promise<number> {
  if (args.expectedUpdatedAt === null) {
    if (Object.keys(args.expectedMarkers).length > 0) return 0;
    return insertDayStateIfAbsent(db, {
      localDate: args.localDate,
      timezoneRevision: args.timezoneRevision,
      timezone: args.timezone,
      markerVersions: args.markerVersions,
      deferUntil: args.deferUntil,
      gapKind: args.gapKind,
      gapSince: args.gapSince,
      now: args.now,
    });
  }
  const affected = await db.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsAggregateDayState" (
      "localDate", "timezoneRevision", "timezone", "markerVersions",
      "deferUntil", "gapKind", "gapSince", "updatedAt"
    ) VALUES (
      ${args.localDate},
      ${args.timezoneRevision},
      ${args.timezone},
      ${JSON.stringify(args.markerVersions)}::jsonb,
      ${args.deferUntil === null ? Prisma.sql`NULL` : utc(args.deferUntil)},
      ${args.gapKind},
      ${args.gapSince === null ? Prisma.sql`NULL` : utc(args.gapSince)},
      ${utc(args.now)}
    )
    ON CONFLICT ("localDate", "timezoneRevision") DO UPDATE SET
      "timezone" = EXCLUDED."timezone",
      "markerVersions" = EXCLUDED."markerVersions",
      "deferUntil" = EXCLUDED."deferUntil",
      "gapKind" = EXCLUDED."gapKind",
      "gapSince" = EXCLUDED."gapSince",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "AnalyticsAggregateDayState"."markerVersions" = ${JSON.stringify(args.expectedMarkers)}::jsonb
      AND "AnalyticsAggregateDayState"."updatedAt" = ${utc(args.expectedUpdatedAt)}
  `);
  return Number(affected);
}

/**
 * bootstrap：只在「确认无该行」时插入，冲突 0 行＝期间已有日写入，不覆盖。
 * 不 UPDATE 已有行，也不改任何指标行。
 */
export async function insertDayStateIfAbsent(
  db: StateDb,
  args: {
    localDate: string;
    timezoneRevision: number;
    timezone: string;
    markerVersions: MarkerVersions;
    deferUntil: Date | null;
    gapKind: string | null;
    gapSince: Date | null;
    now: Date;
  },
): Promise<number> {
  const affected = await db.$executeRaw(Prisma.sql`
    INSERT INTO "AnalyticsAggregateDayState" (
      "localDate", "timezoneRevision", "timezone", "markerVersions",
      "deferUntil", "gapKind", "gapSince", "updatedAt"
    ) VALUES (
      ${args.localDate},
      ${args.timezoneRevision},
      ${args.timezone},
      ${JSON.stringify(args.markerVersions)}::jsonb,
      ${args.deferUntil === null ? Prisma.sql`NULL` : utc(args.deferUntil)},
      ${args.gapKind},
      ${args.gapSince === null ? Prisma.sql`NULL` : utc(args.gapSince)},
      ${utc(args.now)}
    )
    ON CONFLICT ("localDate", "timezoneRevision") DO NOTHING
  `);
  return Number(affected);
}

/** 该站点日本地日 13 个自然月后那一日最早的 UTC 瞬时；`expiresAt<=now` 即到期。 */export function dailyExpiresAt(localDate: string, timezone: string): Date {
  const expiryLocalDate = rollupExpiresAt(localDate);
  return new Date(siteDayUtcBounds(expiryLocalDate, timezone).startUtc);
}

/** 扫描域下界：`今日 − 13 自然月 − 2 天`（只已结束日进域，上界由调用方排除今日）。 */
export function scanFloorLocalDate(todayLocalDate: string): string {
  return shiftLocalDate(shiftCalendarMonthsLocal(todayLocalDate, -13), -2);
}

/** 与 retention-plan.shiftCalendarMonths 同一算法；本文件只做纯日期推进，不碰 Prisma。 */
function shiftCalendarMonthsLocal(localDate: string, months: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const monthIndex = year * 12 + (month - 1) + months;
  let nextYear = Math.floor(monthIndex / 12);
  let nextMonth = monthIndex % 12;
  if (nextMonth < 0) {
    nextMonth += 12;
    nextYear -= 1;
  }
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const nextDay = Math.min(day, lastDay);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(nextYear).padStart(4, '0')}-${pad(nextMonth + 1)}-${pad(nextDay)}`;
}

/**
 * 提交后合并 defer：旧 defer 只在仍晚于 `now` 时保留（过期旧 defer 丢弃），
 * 与新的最早 deferred 事实取最小值；都没有则 null。
 */
export function mergeDeferUntil(previous: Date | null, next: Date | null, now: Date): Date | null {
  const kept = previous !== null && previous.getTime() > now.getTime() ? previous : null;
  if (kept === null) return next;
  if (next === null) return kept;
  return next.getTime() <= kept.getTime() ? next : kept;
}

export type { SiteDayBounds };
