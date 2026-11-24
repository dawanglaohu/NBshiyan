import type { AnalyticsEventKind, Prisma, PrismaClient } from '@prisma/client';
import { shiftLocalDate } from '../../analytics/aggregate-plan';
import { DayBoundaryError, siteDayUtcBounds, siteLocalDate } from '../../analytics/day-boundaries';
import { classifyDayCompleteness, meanDurationMs, successRate } from '../../analytics/daily-aggregate';
import type { AccountRole } from '../../contracts/account';
import { LocalDateSchema, PositiveIntSchema } from '../../contracts/common';
import {
  StatsQuerySchema,
  StatsSourceSchema,
  type StatsCoverage,
  type StatsQueryDTO,
  type StatsSource,
  type StatsSourceDTO,
} from '../../contracts/ops';
import { parseMarkerVersions, readLiveMarkerVersions } from '../analytics/aggregate-day-state';
import { AGGREGATE_JOB_KEY, runInRepeatableReadSnapshot } from '../analytics/aggregate-repo';
import { rollupExpiryCutoff, shiftCalendarMonths } from '../analytics/retention-plan';
import { AppError } from '../http/errors';
import { toStatsSourceDTO } from './source-dto';

const COUNT_COLUMNS = {
  page_views: 'pageViews',
  visitors: 'visitors',
  product_views: 'productViews',
  model_starts: 'modelStarts',
  model_successes: 'modelSuccesses',
  model_failures: 'modelFailures',
  chat_starts: 'chatStarts',
} as const;

type CountSource = keyof typeof COUNT_COLUMNS;
type CoreSource = CountSource | 'mean_load_duration_ms';

const LEGACY_KINDS = {
  page_view: 'page_views',
  product_view: 'product_views',
  model_view_start: 'model_starts',
  chat_start: 'chat_starts',
} as const satisfies Partial<Record<AnalyticsEventKind, CountSource>>;

const EDITOR_SOURCES: ReadonlySet<StatsSource> = new Set([
  'page_views', 'visitors', 'product_views', 'model_starts', 'model_successes', 'model_failures',
  'mean_load_duration_ms',
]);
const SALES_SOURCES: ReadonlySet<StatsSource> = new Set([
  ...EDITOR_SOURCES, 'chat_starts', 'inquiries', 'chat_conversations', 'chat_messages', 'chat_notifications',
]);
const AGGREGATE_FRESHNESS_MS = 15 * 60_000;

function isCoreSource(source: StatsSource): source is CoreSource {
  return source === 'mean_load_duration_ms' || Object.hasOwn(COUNT_COLUMNS, source);
}

export function selectStatsSources(role: AccountRole, requested?: readonly StatsSource[]): StatsSource[] {
  const selected = (requested ?? StatsSourceSchema.options).filter((source) => (
    role === 'ADMIN' || (role === 'SALES' && SALES_SOURCES.has(source)) || (role === 'EDITOR' && EDITOR_SOURCES.has(source))
  ));
  if (selected.length === 0) throw new AppError('forbidden');
  return selected;
}

type StatsRevision = {
  timezone: string;
  timezoneRevision: number;
  /** First modern-phase site day for this revision, supplied by the server from rollout metadata. */
  legacyBefore: string | null;
};

type CoreStatsRequest = {
  query: StatsQueryDTO;
  role: AccountRole;
  /** Resolved site timezone for the requested revision, including for legacy-only ranges. */
  revision: StatsRevision;
  /** Both analytics collection configuration and the aggregate job registration are available. */
  connected: boolean;
  now: Date;
};

function resolveScope(query: StatsQueryDTO, revision: StatsRevision, now: Date) {
  const { timezone, timezoneRevision, legacyBefore } = revision;
  try {
    const today = siteLocalDate(now, timezone);
    const parsed = StatsQuerySchema.safeParse({ ...query, from: query.from ?? today, to: query.to ?? today });
    if (!parsed.success || (query.timezoneRevision !== undefined && query.timezoneRevision !== timezoneRevision)
        || !PositiveIntSchema.safeParse(timezoneRevision).success
        || (legacyBefore !== null && !LocalDateSchema.safeParse(legacyBefore).success)) {
      throw new AppError('invalid');
    }
    const { from = today, to = today, productSlug } = parsed.data;
    if (from < shiftCalendarMonths(today, -13)) throw new AppError('invalid');
    const startUtc = siteDayUtcBounds(from, timezone).startUtc;
    const endUtc = siteDayUtcBounds(to, timezone).endUtc;
    return { from, toExclusive: shiftLocalDate(to, 1), startUtc, endUtc, productSlug, timezone, timezoneRevision };
  } catch (error) {
    if (error instanceof DayBoundaryError) throw new AppError('invalid');
    throw error;
  }
}

type StatsScope = ReturnType<typeof resolveScope>;

type DayReading = {
  complete: boolean;
  counts: Partial<Record<CountSource, number>>;
  duration: { sum: bigint; samples: number } | null;
  dataThrough: Date | null;
  lastSucceededAt: Date;
};

function dailySelection(sources: readonly CoreSource[]) {
  return {
    localDate: true,
    dimension: true,
    timezone: true,
    aggregatedAt: true,
    sourceThrough: true,
    pageViews: sources.includes('page_views'),
    visitors: sources.includes('visitors'),
    productViews: sources.includes('product_views'),
    modelStarts: sources.includes('model_starts'),
    modelSuccesses: sources.includes('model_successes'),
    modelFailures: sources.includes('model_failures'),
    chatStarts: sources.includes('chat_starts'),
    durationMsSum: sources.includes('mean_load_duration_ms'),
    loadDurationSamples: sources.includes('mean_load_duration_ms'),
  } satisfies Prisma.AnalyticsDailySelect;
}

async function readLegacyDays(
  tx: Prisma.TransactionClient,
  scope: StatsScope,
  before: string | null,
  sources: readonly CoreSource[],
  siteDates: ReadonlySet<string>,
  now: Date,
): Promise<DayReading[]> {
  if (before === null || before <= scope.from) return [];
  const kinds = (Object.keys(LEGACY_KINDS) as Array<keyof typeof LEGACY_KINDS>)
    .filter((kind) => sources.includes(LEGACY_KINDS[kind]));
  if (kinds.length === 0) return [];

  const watermarks = (await tx.analyticsRollupDay.findMany({
    where: {
      timezoneRevision: scope.timezoneRevision,
      siteDate: { gte: scope.from, gt: rollupExpiryCutoff(now, scope.timezone),
        lt: before < scope.toExclusive ? before : scope.toExclusive },
    },
    select: { siteDate: true, completedAt: true, sourceMaxReceivedAt: true },
  })).filter(({ siteDate }) => !siteDates.has(siteDate));
  if (watermarks.length === 0) return [];

  const days = new Map(watermarks.map((row): [string, DayReading] => [
    row.siteDate,
    { complete: false, counts: {}, duration: null, dataThrough: row.sourceMaxReceivedAt, lastSucceededAt: row.completedAt },
  ]));
  const rows = await tx.analyticsDailyRollup.groupBy({
    by: ['siteDate', 'kind'],
    where: { siteDate: { in: [...days.keys()] }, kind: { in: kinds }, productSlug: scope.productSlug },
    _sum: { count: true },
  });
  for (const row of rows) {
    if (!Object.hasOwn(LEGACY_KINDS, row.kind)) continue;
    days.get(row.siteDate)!.counts[LEGACY_KINDS[row.kind as keyof typeof LEGACY_KINDS]] = row._sum.count ?? 0;
  }
  return [...days.values()];
}

async function readSnapshot(
  tx: Prisma.TransactionClient,
  scope: StatsScope,
  sources: readonly CoreSource[],
  legacyBefore: string | null,
  now: Date,
) {
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  const dimension = scope.productSlug === undefined ? 'site' : 'product:' + scope.productSlug;
  const where = { timezoneRevision: scope.timezoneRevision, localDate: { gte: scope.from, lt: scope.toExclusive } };
  const rows = await tx.analyticsDaily.findMany({
    where: { ...where, dimension: { in: dimension === 'site' ? ['site'] : ['site', dimension] }, expiresAt: { gt: now } },
    select: dailySelection(sources),
  });
  const siteRows = rows.filter((row) => row.dimension === 'site');
  const selectedRows = new Map(rows.filter((row) => row.dimension === dimension).map((row) => [row.localDate, row]));
  const job = await tx.jobState.findUnique({
    where: { key: AGGREGATE_JOB_KEY },
    select: { lastStatus: true, lastSucceededAt: true, lastFinishedAt: true },
  });

  const modern: DayReading[] = [];
  if (siteRows.length > 0) {
    const states = await tx.analyticsAggregateDayState.findMany({
      where,
      select: { localDate: true, timezone: true, markerVersions: true, deferUntil: true, gapKind: true },
    });
    const byDay = new Map(states.map((state) => [state.localDate, state]));
    const liveVersions = await readLiveMarkerVersions(tx);
    for (const siteRow of siteRows) {
      if (siteRow.timezone !== scope.timezone) {
        throw new Error('Analytics daily timezone differs from the selected revision');
      }
      const state = byDay.get(siteRow.localDate);
      const day = classifyDayCompleteness({
        siteRow,
        state: state?.timezone === siteRow.timezone
          ? { ...state, markerVersions: parseMarkerVersions(state.markerVersions) }
          : null,
        bounds: siteDayUtcBounds(siteRow.localDate, siteRow.timezone),
        liveVersions,
      });

      const row = selectedRows.get(siteRow.localDate);
      if (row !== undefined && row.timezone !== siteRow.timezone) {
        throw new Error('Analytics product timezone differs from the site day');
      }
      // Product rows are sparse. The site day proves coverage for a missing product row.
      const timestamps = row ?? siteRow;
      const counts: DayReading['counts'] = {};
      for (const source of sources) {
        if (source === 'mean_load_duration_ms') continue;
        const value = row === undefined ? 0 : row[COUNT_COLUMNS[source]];
        if (value !== null) counts[source] = value;
      }
      modern.push({
        complete: day.status === 'complete',
        counts,
        duration: sources.includes('mean_load_duration_ms')
          ? { sum: row?.durationMsSum ?? 0n, samples: row?.loadDurationSamples ?? 0 }
          : null,
        dataThrough: timestamps.sourceThrough,
        lastSucceededAt: timestamps.aggregatedAt,
      });
    }
  }

  const legacy = await readLegacyDays(tx, scope, legacyBefore, sources, new Set(siteRows.map((row) => row.localDate)), now);
  const lastJobSuccess = job?.lastSucceededAt?.getTime();
  const stale = job !== null && (
    (lastJobSuccess !== undefined && now.getTime() - lastJobSuccess >= AGGREGATE_FRESHNESS_MS)
    || (job.lastStatus === 'FAILED' && (job.lastFinishedAt?.getTime() ?? 0) > (lastJobSuccess ?? 0))
  );
  return { modern, days: [...modern, ...legacy], stale };
}

function coverageOf(days: DayReading[], requestedDays: number): StatsCoverage {
  if (days.length === 0) return 'unavailable';
  return days.length === requestedDays && days.every((day) => day.complete) ? 'full' : 'partial';
}

function newest(dates: Iterable<Date | null>): Date | null {
  let latest: Date | null = null;
  for (const date of dates) {
    if (date && (latest === null || date > latest)) latest = date;
  }
  return latest;
}

function measureSource(source: CoreSource, days: DayReading[], requestedDays: number) {
  const selected = days.filter((day) => source === 'mean_load_duration_ms'
    ? day.duration !== null : day.counts[source] !== undefined);
  const coverage = coverageOf(selected, requestedDays);
  const times = {
    dataThrough: newest(selected.map((day) => day.dataThrough)),
    lastSucceededAt: newest(selected.map((day) => day.lastSucceededAt)),
  };
  if (source === 'mean_load_duration_ms') {
    let sum = 0n;
    let samples = 0;
    for (const day of selected) {
      sum += day.duration!.sum;
      samples += day.duration!.samples;
    }
    return { ...times, value: meanDurationMs(sum, samples), coverage, loadDurationSamples: samples };
  }

  const total = selected.reduce((sum, day) => sum + (day.counts[source] ?? 0), 0);
  return { ...times, value: total !== 0 || coverage === 'full' ? total : null, coverage };
}

type CoreStatsResult = {
  scope: StatsScope;
  sources: StatsSourceDTO[];
  /** Ratio from the same paired data on both sides, in the interval [0, 1]. */
  modelSuccessRate: { value: number | null; coverage: StatsCoverage } | null;
};

/**
 * The caller resolves the site timezone for the selected revision and supplies the source connection state.
 * Request errors reject before analytics reads. Snapshot errors are returned as per-source query_failed states.
 */
export async function readCoreStats(
  db: Pick<PrismaClient, '$transaction'>,
  request: CoreStatsRequest,
): Promise<CoreStatsResult> {
  const { query, role, revision, now, connected } = request;
  const scope = resolveScope(query, revision, now);
  const core = selectStatsSources(role, query.sources).filter(isCoreSource);
  const context = { timezone: scope.timezone, timezoneRevision: scope.timezoneRevision, queriedAt: now.toISOString() };
  const showRate = core.includes('model_starts') && core.includes('model_successes');
  const emptyRate = showRate ? { value: null, coverage: 'unavailable' as const } : null;
  if (core.length === 0) return { scope, sources: [], modelSuccessRate: null };
  if (!connected) {
    return { scope, modelSuccessRate: emptyRate,
      sources: core.map((source) => toStatsSourceDTO(context, source, { unavailableState: 'not_connected' })) };
  }

  const requestedDays = (Date.parse(scope.toExclusive) - Date.parse(scope.from)) / 86_400_000;
  const measured = scope.productSlug === undefined ? core : core.filter((source) => source !== 'page_views');
  if (measured.length === 0) {
    return { scope, modelSuccessRate: emptyRate, sources: core.map((source) => toStatsSourceDTO(context, source)) };
  }
  try {
    const { modern, days, stale } = await runInRepeatableReadSnapshot(
      db, (tx) => readSnapshot(tx, scope, measured, revision.legacyBefore, now),
    );
    const rate = showRate ? {
      value: successRate(
        modern.reduce((sum, day) => sum + (day.counts.model_starts ?? 0), 0),
        modern.reduce((sum, day) => sum + (day.counts.model_successes ?? 0), 0),
      ),
      coverage: coverageOf(modern, requestedDays),
    } : null;
    return {
      scope,
      modelSuccessRate: rate,
      sources: core.map((source) => toStatsSourceDTO(context, source, { ...measureSource(source, days, requestedDays), stale })),
    };
  } catch {
    return { scope, modelSuccessRate: emptyRate,
      sources: core.map((source) => toStatsSourceDTO(context, source,
        measured.includes(source) ? { unavailableState: 'query_failed' } : {})) };
  }
}
