import { Prisma, type PrismaClient } from '@prisma/client';
import { LocalDateSchema } from '../../contracts/common';
import {
  StatsApiErrorRateSchema,
  StatsNotificationBreakdownSchema,
  StatsSourceDTOSchema,
  type HttpCoverageScope,
  type JobKey,
  type StatsApiErrorRateDTO,
  type StatsDTO,
  type StatsNotificationBreakdownDTO,
  type StatsQueryDTO,
  type StatsSource,
  type StatsSourceDTO,
} from '../../contracts/ops';
import { CHAT_NOTIFICATION_JOB_KEY } from '../chat/notification-policy';
import { AppError } from '../http/errors';
import { API_ROUTE_IDS, type ApiCounter } from '../http/metrics';
import { toStatsSourceDTO } from './source-dto';
import type { DetailedNonCoreSourceReader, NonCoreSourceReader, NonCoreSourceReadInput } from './stats-service';

/** 固定邮件队列作业键（与 JobKeySchema 同源，不导入 mail/queue-job 以免提前初始化全局 db 单例）。 */
const MAIL_QUEUE_JOB_KEY = 'mail-queue' as const satisfies JobKey;
const HTTP_SNAPSHOT_MEMO_KEY = Symbol('m6t5.httpCounterSnapshot');

/** HTTP 与邮件/聊天通知可靠性来源（M6-T5；E-51、E-52、E-53、E-64、E-67）。 */
export const HTTP_RELIABILITY_SOURCES = ['api_requests', 'api_errors'] as const satisfies readonly StatsSource[];
export const NOTIFICATION_RELIABILITY_SOURCES = ['chat_notifications', 'mail'] as const satisfies readonly StatsSource[];
export const RELIABILITY_SOURCES = [
  ...HTTP_RELIABILITY_SOURCES,
  ...NOTIFICATION_RELIABILITY_SOURCES,
] as const satisfies readonly StatsSource[];

export type HttpReliabilitySource = (typeof HTTP_RELIABILITY_SOURCES)[number];
export type NotificationReliabilitySource = (typeof NOTIFICATION_RELIABILITY_SOURCES)[number];
export type ReliabilitySource = (typeof RELIABILITY_SOURCES)[number];

/** HTTP 可靠性固定只覆盖第 10 节本轮已接线路由，严禁声称全站错误率（E-64）。 */
export const HTTP_COVERAGE_SCOPE: HttpCoverageScope = 'instrumented_routes';

/** 第 09/16 节：聊天通知与邮件队列每 1 分钟调度，超过 5 分钟无成功记录标 stale。 */
export const NOTIFICATION_FRESHNESS_MS = 5 * 60_000;

const READ_OPTIONS = { maxWait: 2_000, timeout: 5_000 } as const;
const MAX_BOUNDED_COUNT = 2_147_483_647;

export type ReliabilityDb = Pick<PrismaClient, '$transaction'>;

export type ReliabilitySourceDeps = {
  db: ReliabilityDb;
  /** 实际 HTTP 最终响应计数器接线；未传且未提供 httpConnected 时默认未接通（fail-closed）。 */
  apiCounter?: Pick<ApiCounter, 'recordFinalResponse'> | null;
  httpConnected?: () => boolean;
  chatNotificationConfigured?: () => boolean;
  chatNotificationJobRegistered?: () => boolean;
  mailConfigured?: () => boolean;
  mailQueueJobRegistered?: () => boolean;
};

type ApiCounterSummaryRow = {
  requestCount: bigint | number | string;
  errorCount: bigint | number | string;
  rowCount: number;
  corrupt: boolean | null;
  lastObservedAt: string | null;
};

type JobStateRow = {
  lastStatus: string;
  lastSucceededAt: string | null;
  lastFinishedAt: string | null;
};

type NotificationBreakdownRow = {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  unknown: number;
};

function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
}

function parseUtcIso(raw: string | null): Date | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function toBoundedNonNegativeInt(raw: bigint | number | string): number | null {
  const num = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isSafeInteger(num) || num < 0 || num > MAX_BOUNDED_COUNT) return null;
  return num;
}

/**
 * 基于同范围已读取的 `api_requests` 与 `api_errors` 配对计算本轮已接线路由的 5xx 错误率（E-64）。
 * - 未同时包含两项来源时返回 `null`；
 * - 无分母（`requestCount === 0` 或 `null`）、未接入或任一侧失败时返回 `{ value: null, coverage: 'unavailable', scope: 'instrumented_routes' }`；
 * - 有真实正整数分母时返回 `coverage: 'partial'`（仅覆盖本轮 instrumented routes，绝不标为全站 `'full'`）。
 */
export function computeApiErrorRate(sources: readonly StatsSourceDTO[]): StatsApiErrorRateDTO | null {
  const byName = new Map(sources.map((item) => [item.source, item]));
  const requests = byName.get('api_requests');
  const errors = byName.get('api_errors');
  if (!requests || !errors) return null;

  const usableStates = new Set<StatsSourceDTO['state']>(['ok', 'zero', 'stale']);
  if (!usableStates.has(requests.state) || !usableStates.has(errors.state)) {
    return StatsApiErrorRateSchema.parse({
      value: null,
      coverage: 'unavailable',
      scope: HTTP_COVERAGE_SCOPE,
    });
  }
  if (
    requests.value === null
    || requests.value <= 0
    || errors.value === null
    || errors.value < 0
    || errors.value > requests.value
  ) {
    return StatsApiErrorRateSchema.parse({
      value: null,
      coverage: 'unavailable',
      scope: HTTP_COVERAGE_SCOPE,
    });
  }
  return StatsApiErrorRateSchema.parse({
    value: errors.value / requests.value,
    coverage: 'partial',
    scope: HTTP_COVERAGE_SCOPE,
  });
}

/**
 * 单源读取失败时的无状态快照回退（E-51、E-52、E-53）：
 * - 若存在同 `source`、同 `timezone`、同 `timezoneRevision` 且携真实旧值与原成功时间的上次快照，
 *   保留原 `value`、`dataThrough` 与 `lastSucceededAt`（绝不把 `lastSucceededAt` 刷成新的 `queriedAt`），
 *   状态保持 `'query_failed'`、`coverage` 置为 `'partial'`；
 * - 无上次成功快照时保持 `value: null, lastSucceededAt: null`，绝不填默认 0。
 */
export function preserveSourceSnapshotOnFailure(
  failedDto: StatsSourceDTO,
  previous?: StatsSourceDTO | null,
): StatsSourceDTO {
  if (failedDto.state !== 'query_failed' || failedDto.value !== null || !previous) {
    return failedDto;
  }
  if (
    previous.source !== failedDto.source
    || previous.timezone !== failedDto.timezone
    || previous.timezoneRevision !== failedDto.timezoneRevision
    || previous.value === null
    || previous.lastSucceededAt === null
  ) {
    return failedDto;
  }
  const candidate: StatsSourceDTO = {
    ...failedDto,
    state: 'query_failed',
    value: previous.value,
    dataThrough: previous.dataThrough,
    lastSucceededAt: previous.lastSucceededAt,
    coverage: 'partial',
  };
  const parsed = StatsSourceDTOSchema.safeParse(candidate);
  return parsed.success ? parsed.data : failedDto;
}

export function sameStatsQueryScope(
  a?: Partial<StatsQueryDTO> | null,
  b?: Partial<StatsQueryDTO> | null,
): boolean {
  if (!a || !b) return false;
  if (
    typeof a.from !== 'string'
    || typeof a.to !== 'string'
    || typeof b.from !== 'string'
    || typeof b.to !== 'string'
  ) {
    return false;
  }
  const aFrom = LocalDateSchema.safeParse(a.from);
  const aTo = LocalDateSchema.safeParse(a.to);
  const bFrom = LocalDateSchema.safeParse(b.from);
  const bTo = LocalDateSchema.safeParse(b.to);
  if (!aFrom.success || !aTo.success || !bFrom.success || !bTo.success) {
    return false;
  }
  if (aFrom.data > aTo.data || bFrom.data > bTo.data) {
    return false;
  }
  return aFrom.data === bFrom.data
    && aTo.data === bTo.data
    && (a.productSlug ?? undefined) === (b.productSlug ?? undefined)
    && (a.timezoneRevision ?? undefined) === (b.timezoneRevision ?? undefined);
}

export type SnapshotFallbackOptions = {
  sameQueryKey?: boolean;
  currentQuery?: Partial<StatsQueryDTO> | null;
  previousQuery?: Partial<StatsQueryDTO> | null;
};

/**
 * 整张看板响应的无全局状态分源失败回退（E-51、E-53、E-67）：
 * 必须显式证明同一有效查询范围（传入匹配的 currentQuery + previousQuery 或显式 sameQueryKey: true），
 * 缺键、未传匹配证明、不同日期或不同产品一律拒绝回退，保持 query_failed / null。
 */
export function preserveStatsSnapshotOnFailure(
  current: StatsDTO,
  previous?: StatsDTO | null,
  options?: SnapshotFallbackOptions,
): StatsDTO {
  if (!previous || !options) return current;
  const hasExplicitQueries = 'currentQuery' in options || 'previousQuery' in options;
  const provenSameScope = hasExplicitQueries
    ? options.sameQueryKey !== false && sameStatsQueryScope(options.currentQuery, options.previousQuery)
    : options.sameQueryKey === true;
  if (!provenSameScope) return current;
  const prevBySource = new Map(previous.sources.map((item) => [item.source, item]));
  const mergedSources = current.sources.map((item) =>
    preserveSourceSnapshotOnFailure(item, prevBySource.get(item.source)),
  );

  let mergedNotificationCounts = current.notificationCounts;
  if (
    current.notificationCounts !== undefined
    && current.notificationCounts !== null
    && previous.notificationCounts
  ) {
    const nextCounts = { ...current.notificationCounts };
    for (const key of NOTIFICATION_RELIABILITY_SOURCES) {
      const mergedItem = mergedSources.find((item) => item.source === key);
      if (
        mergedItem
        && mergedItem.state === 'query_failed'
        && mergedItem.value !== null
        && nextCounts[key] === null
        && previous.notificationCounts[key]
      ) {
        nextCounts[key] = previous.notificationCounts[key];
      }
    }
    mergedNotificationCounts = nextCounts;
  }

  return {
    ...current,
    sources: mergedSources,
    ...(current.apiErrorRate !== undefined ? { apiErrorRate: computeApiErrorRate(mergedSources) } : {}),
    ...(mergedNotificationCounts !== undefined ? { notificationCounts: mergedNotificationCounts } : {}),
  };
}

type HttpCounterSnapshotOutcome =
  | { kind: 'not_connected' }
  | { kind: 'no_data' }
  | { kind: 'query_failed' }
  | {
    kind: 'measured';
    requestCount: number;
    errorCount: number;
    observedAt: Date;
  };

async function queryHttpCounterSnapshotOnce(
  db: ReliabilityDb,
  httpConnected: () => boolean,
  input: NonCoreSourceReadInput,
): Promise<HttpCounterSnapshotOutcome> {
  const { scope, now } = input;
  if (!httpConnected()) {
    return { kind: 'not_connected' };
  }
  // ApiDailyCounter 按路由维度统计，不含产品归因；带 productSlug 或未来日期窗口返回 no_data。
  if (scope.productSlug !== undefined || Date.parse(scope.startUtc) > now.getTime()) {
    return { kind: 'no_data' };
  }

  try {
    const summary = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      const rows = await tx.$queryRaw<ApiCounterSummaryRow[]>`
        SELECT
          COALESCE(SUM("requestCount"), 0)::bigint AS "requestCount",
          COALESCE(SUM("errorCount"), 0)::bigint AS "errorCount",
          COUNT(*)::int AS "rowCount",
          BOOL_OR("requestCount" < 0 OR "errorCount" < 0 OR "errorCount" > "requestCount") AS "corrupt",
          to_char(MAX("lastObservedAt"), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastObservedAt"
        FROM "ApiDailyCounter"
        WHERE "localDate" >= ${scope.from}
          AND "localDate" < ${scope.toExclusive}
          AND "timezoneRevision" = ${scope.timezoneRevision}
          AND "routeId" IN (${Prisma.join(API_ROUTE_IDS)})
      `;
      return rows[0] ?? null;
    }, READ_OPTIONS);

    if (!summary || summary.corrupt) {
      if (summary?.corrupt) throw new Error('api_daily_counter_corrupt');
      return { kind: 'no_data' };
    }

    const requestCount = toBoundedNonNegativeInt(summary.requestCount);
    const errorCount = toBoundedNonNegativeInt(summary.errorCount);
    if (requestCount === null || errorCount === null || errorCount > requestCount) {
      throw new Error('api_daily_counter_out_of_bounds');
    }

    // 无真实 requestCount 分母时返回 no_data (value=null)，不伪造 0 或观测时间（AC1、E-54、E-64）。
    const observedAt = parseUtcIso(summary.lastObservedAt);
    if (summary.rowCount === 0 || requestCount === 0 || !observedAt) {
      return { kind: 'no_data' };
    }

    return {
      kind: 'measured',
      requestCount,
      errorCount,
      observedAt,
    };
  } catch {
    return { kind: 'query_failed' };
  }
}

async function readHttpCounterSource(
  db: ReliabilityDb,
  source: HttpReliabilitySource,
  httpConnected: () => boolean,
  input: NonCoreSourceReadInput,
): Promise<StatsSourceDTO> {
  const { role, scope, context, now, previousSource, requestMemo } = input;
  if (role !== 'ADMIN') throw new AppError('forbidden');

  let snapshotPromise = requestMemo?.get(HTTP_SNAPSHOT_MEMO_KEY) as Promise<HttpCounterSnapshotOutcome> | undefined;
  if (!snapshotPromise) {
    snapshotPromise = queryHttpCounterSnapshotOnce(db, httpConnected, input);
    requestMemo?.set(HTTP_SNAPSHOT_MEMO_KEY, snapshotPromise);
  }
  const outcome = await snapshotPromise;

  if (outcome.kind === 'not_connected') {
    return toStatsSourceDTO(context, source, { unavailableState: 'not_connected' });
  }
  if (outcome.kind === 'no_data') {
    return toStatsSourceDTO(context, source);
  }
  if (outcome.kind === 'query_failed') {
    const failed = toStatsSourceDTO(context, source, { unavailableState: 'query_failed' });
    return preserveSourceSnapshotOnFailure(failed, previousSource);
  }

  const endMs = Date.parse(scope.endUtc);
  const dataThrough = new Date(Math.min(now.getTime(), endMs, outcome.observedAt.getTime()));
  const value = source === 'api_requests' ? outcome.requestCount : outcome.errorCount;
  // 覆盖范围严格只是第 10 节本轮已接线路由，因此固定标 partial，绝不冒称全站 full。
  return toStatsSourceDTO(context, source, {
    value,
    coverage: 'partial',
    dataThrough,
    lastSucceededAt: outcome.observedAt,
  });
}

async function queryChatNotificationBreakdownInTx(
  tx: Prisma.TransactionClient,
  fromUtc: Date,
  toExclusiveUtc: Date,
  productSlug?: string,
): Promise<StatsNotificationBreakdownDTO> {
  // 归桶使用稳定的实际尝试时间 requestStartedAt / 接收时间 createdAt，避免后续维护操作推进 updatedAt 导致跨日迁移。
  const rows = await tx.$queryRaw<NotificationBreakdownRow[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE n."status" = 'QUEUED'::"ChatNotificationStatus"
          AND COALESCE(n."requestStartedAt", n."createdAt") >= ${utcTimestamp(fromUtc)}
          AND COALESCE(n."requestStartedAt", n."createdAt") < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "queued",
      COUNT(*) FILTER (
        WHERE n."status" = 'SENDING'::"ChatNotificationStatus"
          AND COALESCE(n."requestStartedAt", n."createdAt") >= ${utcTimestamp(fromUtc)}
          AND COALESCE(n."requestStartedAt", n."createdAt") < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "sending",
      COUNT(*) FILTER (
        WHERE n."status" = 'SENT'::"ChatNotificationStatus"
          AND n."attempts" > 0
          AND n."sentAt" IS NOT NULL
          AND n."sentAt" >= ${utcTimestamp(fromUtc)}
          AND n."sentAt" < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "sent",
      COUNT(*) FILTER (
        WHERE n."status" = 'FAILED'::"ChatNotificationStatus"
          AND n."attempts" > 0
          AND n."requestStartedAt" IS NOT NULL
          AND n."requestStartedAt" >= ${utcTimestamp(fromUtc)}
          AND n."requestStartedAt" < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "failed",
      COUNT(*) FILTER (
        WHERE n."status" = 'UNKNOWN'::"ChatNotificationStatus"
          AND n."attempts" > 0
          AND n."requestStartedAt" IS NOT NULL
          AND n."requestStartedAt" >= ${utcTimestamp(fromUtc)}
          AND n."requestStartedAt" < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "unknown"
    FROM "ChatNotification" n
    ${productSlug !== undefined
      ? Prisma.sql`INNER JOIN "ChatMessage" cm ON cm."id" = n."messageId"
        INNER JOIN "ChatConversation" cc ON cc."id" = cm."conversationId" AND cc."productSlug" = ${productSlug}`
      : Prisma.empty}
  `;
  return StatsNotificationBreakdownSchema.parse(rows[0] ?? {
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
  });
}

async function queryMailBreakdownInTx(
  tx: Prisma.TransactionClient,
  fromUtc: Date,
  toExclusiveUtc: Date,
  productSlug?: string,
): Promise<StatsNotificationBreakdownDTO> {
  // 严格只读 OUTBOUND 出站邮件：INBOUND 的 RECEIVED/UNASSIGNED/IGNORED 普通询盘收件一律排除（AC2、E-64）。
  // 终态 FAILED / unknown_delivery 按稳定的实际尝试时间 requestStartedAt（兜底不可变 createdAt）归桶，
  // 严禁用 updatedAt，防止 privacy.ts 询盘匿名化更新 messageId/redactedAt 时将历史失败邮件迁移至脱敏日。
  const rows = await tx.$queryRaw<NotificationBreakdownRow[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE m."status" = 'QUEUED'::"MailStatus"
          AND COALESCE(m."requestStartedAt", m."createdAt") >= ${utcTimestamp(fromUtc)}
          AND COALESCE(m."requestStartedAt", m."createdAt") < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "queued",
      COUNT(*) FILTER (
        WHERE m."status" = 'SENDING'::"MailStatus"
          AND COALESCE(m."requestStartedAt", m."createdAt") >= ${utcTimestamp(fromUtc)}
          AND COALESCE(m."requestStartedAt", m."createdAt") < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "sending",
      COUNT(*) FILTER (
        WHERE m."status" = 'SENT'::"MailStatus"
          AND m."attempts" > 0
          AND m."sentAt" IS NOT NULL
          AND m."sentAt" >= ${utcTimestamp(fromUtc)}
          AND m."sentAt" < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "sent",
      COUNT(*) FILTER (
        WHERE m."status" = 'FAILED'::"MailStatus"
          AND (m."errorCode" IS NULL OR m."errorCode" <> 'unknown_delivery')
          AND m."attempts" > 0
          AND COALESCE(m."requestStartedAt", m."createdAt") >= ${utcTimestamp(fromUtc)}
          AND COALESCE(m."requestStartedAt", m."createdAt") < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "failed",
      COUNT(*) FILTER (
        WHERE m."status" = 'FAILED'::"MailStatus"
          AND m."errorCode" = 'unknown_delivery'
          AND m."attempts" > 0
          AND COALESCE(m."requestStartedAt", m."createdAt") >= ${utcTimestamp(fromUtc)}
          AND COALESCE(m."requestStartedAt", m."createdAt") < ${utcTimestamp(toExclusiveUtc)}
      )::int AS "unknown"
    FROM "MailMessage" m
    WHERE m."direction" = 'OUTBOUND'::"MailDirection"
    ${productSlug !== undefined
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM "InquiryItem" ii
          WHERE ii."inquiryId" = m."inquiryId"
            AND ii."productSlug" = ${productSlug}
        )`
      : Prisma.empty}
  `;
  return StatsNotificationBreakdownSchema.parse(rows[0] ?? {
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
  });
}

async function readNotificationSourceDetailed(
  db: ReliabilityDb,
  source: NotificationReliabilitySource,
  jobKey: string,
  configured: () => boolean,
  jobRegistered: () => boolean,
  input: NonCoreSourceReadInput,
): Promise<{ dto: StatsSourceDTO; notificationBreakdown: StatsNotificationBreakdownDTO | null }> {
  const { role, scope, context, now, previousSource, previousBreakdown } = input;
  if (source === 'mail') {
    if (role !== 'ADMIN') throw new AppError('forbidden');
  } else if (role !== 'ADMIN' && role !== 'SALES') {
    throw new AppError('forbidden');
  }

  if (!jobRegistered()) {
    return {
      dto: toStatsSourceDTO(context, source, { unavailableState: 'not_connected' }),
      notificationBreakdown: null,
    };
  }

  const fromUtc = new Date(scope.startUtc);
  const toExclusiveUtc = new Date(scope.endUtc);

  try {
    const txResult = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const jobs = await tx.$queryRaw<JobStateRow[]>`
        SELECT
          "lastStatus"::text AS "lastStatus",
          to_char("lastSucceededAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastSucceededAt",
          to_char("lastFinishedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastFinishedAt"
        FROM "JobState"
        WHERE "key" = ${jobKey}
      `;
      const isConfigured = configured();
      const job = jobs[0] ?? null;
      if (!job || job.lastStatus === 'NEVER') {
        // 已注册作业且发信配置已接通但尚无作业运行样本 -> no_data/null；未配置发信 -> not_connected。
        return isConfigured ? { kind: 'no_data' as const } : { kind: 'not_connected' as const };
      }

      const lastSucceededAt = parseUtcIso(job.lastSucceededAt);
      const lastFinishedAt = parseUtcIso(job.lastFinishedAt);
      if (!lastSucceededAt) {
        if (job.lastStatus === 'FAILED') return { kind: 'failed_without_snapshot' as const };
        return isConfigured ? { kind: 'no_data' as const } : { kind: 'not_connected' as const };
      }

      if (fromUtc.getTime() > now.getTime()) {
        return isConfigured ? { kind: 'no_data' as const } : { kind: 'not_connected' as const };
      }

      const breakdown = source === 'chat_notifications'
        ? await queryChatNotificationBreakdownInTx(tx, fromUtc, toExclusiveUtc, scope.productSlug)
        : await queryMailBreakdownInTx(tx, fromUtc, toExclusiveUtc, scope.productSlug);

      const totalAttempted = breakdown.sent + breakdown.failed + breakdown.unknown;
      // 发信配置未接通且无任何已发生尝试事实时，即使 cron 空跑写过 JobState 也不得冒充已接通 0 值（16 节 / E-54）。
      if (!isConfigured && totalAttempted === 0) {
        return { kind: 'not_connected' as const };
      }

      const failedAfterSuccess = job.lastStatus === 'FAILED'
        && (lastFinishedAt?.getTime() ?? 0) > lastSucceededAt.getTime();
      const ageExceeded = now.getTime() - lastSucceededAt.getTime() >= NOTIFICATION_FRESHNESS_MS;
      const stale = !isConfigured || failedAfterSuccess || ageExceeded;

      return {
        kind: 'measured' as const,
        breakdown,
        lastSucceededAt,
        stale,
      };
    }, READ_OPTIONS);

    if (txResult.kind === 'not_connected') {
      return {
        dto: toStatsSourceDTO(context, source, { unavailableState: 'not_connected' }),
        notificationBreakdown: null,
      };
    }
    if (txResult.kind === 'no_data') {
      return {
        dto: toStatsSourceDTO(context, source),
        notificationBreakdown: null,
      };
    }
    if (txResult.kind === 'failed_without_snapshot') {
      const failed = toStatsSourceDTO(context, source, { unavailableState: 'query_failed' });
      const preserved = preserveSourceSnapshotOnFailure(failed, previousSource);
      return {
        dto: preserved,
        notificationBreakdown: preserved.value !== null ? (previousBreakdown ?? null) : null,
      };
    }

    const dataThrough = new Date(Math.min(
      now.getTime(),
      toExclusiveUtc.getTime(),
      txResult.lastSucceededAt.getTime(),
    ));
    return {
      dto: toStatsSourceDTO(context, source, {
        value: txResult.breakdown.sent,
        coverage: txResult.stale ? 'partial' : 'full',
        dataThrough,
        lastSucceededAt: txResult.lastSucceededAt,
        stale: txResult.stale,
      }),
      notificationBreakdown: txResult.breakdown,
    };
  } catch {
    // 单源异常独立隔离并完全脱敏，不泄露连接串、凭据或堆栈，也不拖垮其余来源（E-51、E-52、E-53、E-67）。
    const failed = toStatsSourceDTO(context, source, { unavailableState: 'query_failed' });
    const preserved = preserveSourceSnapshotOnFailure(failed, previousSource);
    return {
      dto: preserved,
      notificationBreakdown: preserved.value !== null ? (previousBreakdown ?? null) : null,
    };
  }
}

/** 构造可靠性四源的只读适配器包（缺依赖严格 fail-closed 返回 not_connected，不默认放行）。 */
export function createReliabilitySourceBundle(deps: ReliabilitySourceDeps): {
  readers: Record<ReliabilitySource, NonCoreSourceReader>;
  detailedReaders: Record<ReliabilitySource, DetailedNonCoreSourceReader>;
} {
  const httpConnected = deps.httpConnected
    ?? (() => Boolean(
      deps.apiCounter
      && typeof deps.apiCounter.recordFinalResponse === 'function'
      && API_ROUTE_IDS.length > 0,
    ));
  const chatConfigured = deps.chatNotificationConfigured ?? (() => false);
  const chatJobRegistered = deps.chatNotificationJobRegistered ?? (() => false);
  const mailConfigured = deps.mailConfigured ?? (() => false);
  const mailJobRegistered = deps.mailQueueJobRegistered ?? (() => false);

  const detailedReaders: Record<ReliabilitySource, DetailedNonCoreSourceReader> = {
    api_requests: async (input) => ({
      dto: await readHttpCounterSource(deps.db, 'api_requests', httpConnected, input),
    }),
    api_errors: async (input) => ({
      dto: await readHttpCounterSource(deps.db, 'api_errors', httpConnected, input),
    }),
    chat_notifications: (input) => readNotificationSourceDetailed(
      deps.db,
      'chat_notifications',
      CHAT_NOTIFICATION_JOB_KEY,
      chatConfigured,
      chatJobRegistered,
      input,
    ),
    mail: (input) => readNotificationSourceDetailed(
      deps.db,
      'mail',
      MAIL_QUEUE_JOB_KEY,
      mailConfigured,
      mailJobRegistered,
      input,
    ),
  };

  const readers: Record<ReliabilitySource, NonCoreSourceReader> = {
    api_requests: async (input) => (await detailedReaders.api_requests(input)).dto,
    api_errors: async (input) => (await detailedReaders.api_errors(input)).dto,
    chat_notifications: async (input) => (await detailedReaders.chat_notifications(input)).dto,
    mail: async (input) => (await detailedReaders.mail(input)).dto,
  };

  return { readers, detailedReaders };
}

/** 返回标准四源 `NonCoreSourceReader` 映射（`api_requests`、`api_errors`、`chat_notifications`、`mail`）。 */
export function createReliabilitySourceReaders(
  deps: ReliabilitySourceDeps,
): Record<ReliabilitySource, NonCoreSourceReader> {
  return createReliabilitySourceBundle(deps).readers;
}
