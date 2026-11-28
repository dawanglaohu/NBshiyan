'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Status } from '@/components/ui';
import { siteLocalDate } from '@/lib/analytics/day-boundaries';
import { getStats, type StatsResult } from '@/lib/client/ops';
import type {
  AccountRole,
  StatsDTO,
  StatsModelSuccessRateDTO,
  StatsQueryDTO,
  StatsSource,
  StatsSourceDTO,
  StatsSourceState,
} from '@/lib/contracts';
import SourceCard, { formatCoverageText, formatStateBadge } from './SourceCard';
import StatsTrend from './StatsTrend';
import StatsFilters, { type StatsProductOption, type StatsScopeMode } from './StatsFilters';

export { formatDurationSamples, formatSourceValue } from './SourceCard';

export type StatsClientApi = {
  query: (input: StatsQueryDTO, options?: { signal?: AbortSignal }) => Promise<StatsResult>;
};

const defaultStatsApi: StatsClientApi = {
  query: (input, options) => getStats(input, options),
};

export const CORE_SOURCES: readonly StatsSource[] = [
  'visitors',
  'page_views',
  'product_views',
  'model_starts',
  'model_successes',
  'model_failures',
  'mean_load_duration_ms',
];

export const BUSINESS_SOURCES: readonly StatsSource[] = [
  'chat_starts',
  'inquiries',
  'chat_conversations',
  'chat_messages',
  'chat_notifications',
];

export const OPS_SOURCES: readonly StatsSource[] = [
  'api_requests',
  'api_errors',
  'mail',
  'storage',
  'backup',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本地预检日期输入：非法格式、起止倒置或超过 400 天直接给出字段级提示。 */
export function validateStatsDates(from: string, to: string): { fromError?: string; toError?: string } {
  if (!from && !to) return {};
  if (!from || !DATE_RE.test(from)) return { fromError: '请输入 YYYY-MM-DD 格式的开始日期。' };
  if (!to || !DATE_RE.test(to)) return { toError: '请输入 YYYY-MM-DD 格式的结束日期。' };
  const startMs = Date.parse(`${from}T00:00:00Z`);
  const endMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(startMs)) return { fromError: '开始日期无效。' };
  if (!Number.isFinite(endMs)) return { toError: '结束日期无效。' };
  const span = endMs - startMs;
  if (span < 0) return { toError: '结束日期不能早于开始日期。' };
  if (span > 399 * 86_400_000) return { toError: '单次查询跨度不能超过 400 个连续自然日。' };
  return {};
}

/** 构造查询快照键：含角色、日期、产品、来源范围与时区版本；换键不复用旧快照。 */
export function buildStatsSnapshotKey(input: {
  role: AccountRole;
  from?: string;
  to?: string;
  productSlug?: string;
  scopeMode: StatsScopeMode;
  timezoneRevision?: number;
}): string {
  return [
    input.role,
    input.from ?? 'site-today',
    input.to ?? 'site-today',
    input.productSlug || 'all-products',
    input.scopeMode,
    input.timezoneRevision ?? 'current',
  ].join('|');
}

export type ModelSuccessRatePairing = {
  startsSource?: StatsSourceDTO;
  successesSource?: StatsSourceDTO;
};

export type ModelSuccessRateDisplay = {
  badgeState: StatsSourceState;
  valueText: string;
  pairText: string;
  isAlert: boolean;
};

function formatSuccessRatePct(val: number): string {
  if (val === 0) return '0%';
  const pct = (val * 100).toFixed(1).replace(/\.0$/, '');
  return `${pct}%`;
}

/**
 * 结合配对来源（model_starts / model_successes）的实际状态与 DTO 推导 3D 加载成功率展示（R4 / E-63）：
 * 完整区分 query_failed、not_connected、stale、no_data/zero 真实无样本与有分母的 0%；
 * 查询失败或未接入时绝不断言「0 starts」。
 */
export function resolveModelSuccessRateDisplay(
  rate: StatsModelSuccessRateDTO,
  pairing: ModelSuccessRatePairing = {},
): ModelSuccessRateDisplay {
  const { startsSource, successesSource } = pairing;

  const pairedCountsText = (): string | null => {
    if (
      startsSource?.value !== null &&
      startsSource?.value !== undefined &&
      successesSource?.value !== null &&
      successesSource?.value !== undefined
    ) {
      if (
        rate.value !== null &&
        startsSource.value > 0 &&
        Math.abs(successesSource.value / startsSource.value - rate.value) <= 1e-6
      ) {
        return `${successesSource.value.toLocaleString('en-US')} / ${startsSource.value.toLocaleString('en-US')} starts`;
      }
      if (rate.value === null && startsSource.value === 0 && successesSource.value === 0) {
        return '0 starts（无配对分母）';
      }
    }
    return null;
  };

  if (startsSource?.state === 'query_failed' || successesSource?.state === 'query_failed') {
    const retainedCounts = pairedCountsText();
    if (rate.value !== null && retainedCounts !== null) {
      return {
        badgeState: 'query_failed',
        valueText: formatSuccessRatePct(rate.value),
        pairText: retainedCounts,
        isAlert: true,
      };
    }
    return {
      badgeState: 'query_failed',
      valueText: '查询失败（无快照）',
      pairText: '查询失败（配对分母未知）',
      isAlert: true,
    };
  }

  if (startsSource?.state === 'not_connected' || successesSource?.state === 'not_connected') {
    return {
      badgeState: 'not_connected',
      valueText: 'Not connected: model_success_rate',
      pairText: 'Not connected（未接入配对来源）',
      isAlert: false,
    };
  }

  if (startsSource?.state === 'stale' || successesSource?.state === 'stale') {
    const counts = pairedCountsText();
    return {
      badgeState: 'stale',
      valueText: rate.value === null ? '—（无发起样本）' : formatSuccessRatePct(rate.value),
      pairText:
        counts ??
        (rate.value !== null
          ? `配对覆盖：${formatCoverageText(rate.coverage)}`
          : '无配对样本（旧快照无分母）'),
      isAlert: true,
    };
  }

  if (rate.value === null) {
    const hasMeasuredZeroStarts = startsSource?.state === 'zero' && startsSource.value === 0;
    const isNoData =
      startsSource?.state === 'no_data' ||
      successesSource?.state === 'no_data' ||
      rate.coverage === 'unavailable';
    return {
      badgeState: 'no_data',
      valueText: '—（无发起样本）',
      pairText: hasMeasuredZeroStarts
        ? '0 starts（无配对分母）'
        : isNoData
          ? 'No data yet（尚无配对样本）'
          : '无配对分母',
      isAlert: false,
    };
  }

  const counts = pairedCountsText();
  return {
    badgeState: rate.value === 0 ? 'zero' : 'ok',
    valueText: formatSuccessRatePct(rate.value),
    pairText: counts ?? `配对覆盖：${formatCoverageText(rate.coverage)}`,
    isAlert: false,
  };
}

/**
 * 格式化配对 3D 加载成功率主读数（E-63 / R4）：
 * 分母仅为获同意后真实 model_view_start；支持传入配对来源以区分失败/未接入/无样本/0%。
 */
export function formatModelSuccessRate(
  rate: StatsModelSuccessRateDTO,
  pairing?: ModelSuccessRatePairing,
): string {
  return resolveModelSuccessRateDisplay(rate, pairing).valueText;
}

/**
 * 同查询键且同 timezoneRevision 合并逐源旧值（R3）：
 * 仅当 prev 与当前项的 timezoneRevision 及 timezone 完全一致、当前项为 query_failed 且 value === null、
 * 且上次快照有成功值时，保留旧数值、样本数与原 dataThrough / lastSucceededAt；跨版本绝不串值。
 */
export function mergeSnapshotSources(
  current: StatsDTO,
  previousGood: StatsDTO | null,
): { dto: StatsDTO; retainedSources: ReadonlySet<StatsSource> } {
  const retained = new Set<StatsSource>();
  if (!previousGood) return { dto: current, retainedSources: retained };
  const prevBySource = new Map<StatsSource, StatsSourceDTO>(
    previousGood.sources.map((entry) => [entry.source, entry]),
  );
  const merged = current.sources.map((item) => {
    if (item.state === 'query_failed' && item.value === null) {
      const prev = prevBySource.get(item.source);
      if (
        prev &&
        prev.timezoneRevision === item.timezoneRevision &&
        prev.timezone === item.timezone &&
        prev.value !== null &&
        prev.lastSucceededAt !== null
      ) {
        retained.add(item.source);
        return {
          ...item,
          value: prev.value,
          dataThrough: prev.dataThrough,
          lastSucceededAt: prev.lastSucceededAt,
          coverage: prev.coverage,
          loadDurationSamples: prev.loadDurationSamples,
        };
      }
    }
    return item;
  });

  const retainPairedRate =
    retained.has('model_starts') &&
    retained.has('model_successes') &&
    current.modelSuccessRate !== null &&
    current.modelSuccessRate !== undefined &&
    current.modelSuccessRate.value === null &&
    previousGood.modelSuccessRate !== null &&
    previousGood.modelSuccessRate !== undefined &&
    previousGood.modelSuccessRate.value !== null;

  return {
    dto: {
      ...current,
      sources: merged,
      ...(retainPairedRate ? { modelSuccessRate: previousGood.modelSuccessRate } : {}),
    },
    retainedSources: retained,
  };
}

function ModelSuccessRateCard({
  rate,
  startsSource,
  successesSource,
  refreshFailed,
}: {
  rate: StatsModelSuccessRateDTO;
  startsSource?: StatsSourceDTO;
  successesSource?: StatsSourceDTO;
  refreshFailed: boolean;
}) {
  const display = resolveModelSuccessRateDisplay(rate, { startsSource, successesSource });
  const state = refreshFailed && rate.value !== null && display.badgeState !== 'query_failed'
    ? 'stale'
    : display.badgeState;
  const badge = formatStateBadge(state);
  const refSource = startsSource ?? successesSource;

  return (
    <article
      className="stats-card"
      data-testid="stats-model-success-rate"
      data-source-state={state}
      data-alert={state === 'stale' || display.isAlert ? 'true' : undefined}
    >
      <div className="stats-card-top">
        <div>
          <h3 className="stats-card-title">3D 加载成功率</h3>
          <p className="stats-card-desc">3D load success rate</p>
        </div>
        <span
          className="stats-badge"
          data-state={state}
          data-testid="stats-state-model_success_rate"
        >
          <span aria-hidden="true">{badge.prefix}</span>
          <span>{badge.text}</span>
        </span>
      </div>

      <p className="stats-value" data-testid="stats-value-model_success_rate">
        {display.valueText}
      </p>

      <p className="stats-card-desc">
        配对口径（09 节 / E-63）：以获同意后真实 model_view_start 为唯一分母；无发起样本为 null，有样本零成功才显示 0%。
      </p>

      <div className="stats-card-meta">
        <p data-testid="stats-success-rate-pair">
          <strong>配对读数：</strong>
          <span className="stats-mono">{display.pairText}</span>
        </p>
        <p>
          <strong>覆盖：</strong>
          <span>{formatCoverageText(rate.coverage)}</span>
          {refSource && (
            <>
              {' · '}
              <strong>时区：</strong>
              <span className="stats-mono">{refSource.timezone} (rev {refSource.timezoneRevision})</span>
            </>
          )}
        </p>
        <p>
          <strong>数据截止：</strong>
          <span className="stats-mono">{refSource?.dataThrough ?? '—'}</span>
        </p>
      </div>
    </article>
  );
}

export type StatsContainerProps = {
  role: AccountRole;
  products: readonly StatsProductOption[];
  api?: StatsClientApi;
};

/**
 * /admin/stats 核心看板容器（M6-T4）：
 * - 首次挂载不依赖浏览器本地时区，请求无 from/to 的 GET /api/admin/stats，由服务端按站点 IANA 时区确定今日并回填输入框；
 * - 切换查询键时通过 AbortController 取消旧请求；同键刷新失败保留上次成功快照与原时间戳，换键或失权立即清空；
 * - 仅呈现服务端裁剪后实际返回的授权来源，并提供同 DTO 的 SVG 图与原生可读数据表。
 */
export default function StatsContainer({
  role,
  products,
  api = defaultStatsApi,
}: StatsContainerProps) {
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [productSlug, setProductSlug] = useState('');
  const [scopeMode, setScopeMode] = useState<StatsScopeMode>('all');
  const [opsForbidden, setOpsForbidden] = useState(false);
  const [appliedQuery, setAppliedQuery] = useState<{
    from?: string;
    to?: string;
    productSlug?: string;
    scopeMode: StatsScopeMode;
  }>({ scopeMode: 'all' });
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [fromError, setFromError] = useState<string | undefined>(undefined);
  const [toError, setToError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(true);
  const [dto, setDto] = useState<StatsDTO | null>(null);
  const [errorBanner, setErrorBanner] = useState<{
    kind: 'unauthorized' | 'forbidden' | 'stale-error' | 'fatal-error';
    text: string;
    snapshotKey?: string;
  } | null>(null);

  const snapshotsRef = useRef<Map<string, StatsDTO>>(new Map());
  const latestRevisionRef = useRef<number | undefined>(undefined);
  const opsForbiddenRef = useRef(false);
  const activeAbortRef = useRef<AbortController | null>(null);
  const initializedDatesRef = useRef(false);

  const snapshotKeyForRevision = useCallback(
    (revision: number, siteDay?: string) =>
      buildStatsSnapshotKey({
        role,
        from: appliedQuery.from ?? siteDay,
        to: appliedQuery.to ?? siteDay,
        productSlug: appliedQuery.productSlug,
        scopeMode: appliedQuery.scopeMode,
        timezoneRevision: revision,
      }),
    [role, appliedQuery.from, appliedQuery.to, appliedQuery.productSlug, appliedQuery.scopeMode],
  );

  useEffect(() => {
    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;

    // R2 + R3：切换查询时仅展示当前已知 timezoneRevision 下目标查询自身的缓存快照或加载态（null），绝不残留上一个查询的计数。
    const knownRevision = latestRevisionRef.current;
    const targetKey = knownRevision === undefined ? undefined : snapshotKeyForRevision(knownRevision);
    const targetCached = targetKey ? snapshotsRef.current.get(targetKey) ?? null : null;
    setDto(targetCached);
    setBusy(true);
    setErrorBanner((previous) => (
      previous?.kind === 'stale-error' && previous.snapshotKey === targetKey ? previous : null
    ));

    const requestQuery: StatsQueryDTO = {
      ...(appliedQuery.from ? { from: appliedQuery.from } : {}),
      ...(appliedQuery.to ? { to: appliedQuery.to } : {}),
      ...(appliedQuery.productSlug ? { productSlug: appliedQuery.productSlug } : {}),
      ...(role === 'ADMIN' && !opsForbiddenRef.current && appliedQuery.scopeMode === 'ops'
        ? { sources: [...OPS_SOURCES] }
        : {}),
    };

    void api
      .query(requestQuery, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setBusy(false);

        if (result.ok) {
          setErrorBanner(null);
          const first = result.data.sources[0];
          const responseRevision = first?.timezoneRevision;
          let resolvedDay: string | null = null;
          if (first) {
            try {
              resolvedDay = siteLocalDate(new Date(first.queriedAt), first.timezone);
            } catch {
              resolvedDay = null;
            }
          }
          if (!initializedDatesRef.current && resolvedDay) {
            initializedDatesRef.current = true;
            setDraftFrom((curr) => curr || resolvedDay);
            setDraftTo((curr) => curr || resolvedDay);
          }

          // R3：按服务端实际返回的 timezoneRevision 隔离快照；版本变更时剔除旧版本快照。
          if (responseRevision !== undefined) {
            const prevRevision = latestRevisionRef.current;
            if (prevRevision !== undefined && prevRevision !== responseRevision) {
              const suffix = `|${responseRevision}`;
              for (const existingKey of snapshotsRef.current.keys()) {
                if (!existingKey.endsWith(suffix)) {
                  snapshotsRef.current.delete(existingKey);
                }
              }
            }
            latestRevisionRef.current = responseRevision;
          }

          // 默认今日按响应的站点日存储，避免跨站点午夜时继承前一天的值。
          const responseKey = responseRevision === undefined
            ? undefined
            : snapshotKeyForRevision(responseRevision, resolvedDay ?? undefined);
          const previous = responseKey ? snapshotsRef.current.get(responseKey) ?? null : null;
          const merged = mergeSnapshotSources(result.data, previous);
          setDto(merged.dto);
          if (responseKey) snapshotsRef.current.set(responseKey, merged.dto);
          return;
        }

        if (result.action === 'login' || result.status === 401) {
          snapshotsRef.current.clear();
          latestRevisionRef.current = undefined;
          setDto(null);
          setErrorBanner({
            kind: 'unauthorized',
            text: 'Your session has ended. Sign in again to continue.（当前会话已失效，请重新登录。）',
          });
          return;
        }

        if (result.status === 403) {
          // R1：收到 403 立即清除失权会话的全部留存快照，并停止该越权查询（回退默认范围且不自动重发）。
          snapshotsRef.current.clear();
          latestRevisionRef.current = undefined;
          opsForbiddenRef.current = true;
          setDto(null);
          setOpsForbidden(true);
          setScopeMode('all');
          setErrorBanner({
            kind: 'forbidden',
            text: "You don't have access to this area.（当前账号角色无权查看所请求的统计来源。）",
          });
          return;
        }

        if (result.code === 'invalid' && result.fieldErrors) {
          if (result.fieldErrors.from) setFromError(result.fieldErrors.from);
          if (result.fieldErrors.to) setToError(result.fieldErrors.to);
        }

        if (targetCached) {
          setErrorBanner({
            kind: 'stale-error',
            text: '刷新失败。各来源显示最近一次返回的快照。',
            snapshotKey: targetKey,
          });
        } else {
          setDto(null);
          setErrorBanner({
            kind: 'fatal-error',
            text: result.text || '读取统计数据失败，请点击重试。',
          });
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setBusy(false);
        if (targetCached) {
          setErrorBanner({
            kind: 'stale-error',
            text: '网络异常。各来源显示最近一次返回的快照。',
            snapshotKey: targetKey,
          });
        } else {
          setDto(null);
          setErrorBanner({
            kind: 'fatal-error',
            text: '读取统计数据失败，请检查连接后重试。',
          });
        }
      });

    return () => {
      controller.abort();
    };
  }, [api, appliedQuery, refreshNonce, role, snapshotKeyForRevision]);

  const submitQuery = useCallback(
    (nextFrom: string, nextTo: string, nextProduct: string, nextScope: StatsScopeMode) => {
      const validation = validateStatsDates(nextFrom, nextTo);
      setFromError(validation.fromError);
      setToError(validation.toError);
      if (validation.fromError || validation.toError) return;
      const effectiveScope: StatsScopeMode = opsForbidden ? 'all' : nextScope;
      setAppliedQuery({
        from: nextFrom || undefined,
        to: nextTo || undefined,
        productSlug: nextProduct || undefined,
        scopeMode: effectiveScope,
      });
    },
    [opsForbidden],
  );

  const handleFromChange = (value: string) => {
    setDraftFrom(value);
    setFromError(undefined);
    if (value && draftTo) {
      const validation = validateStatsDates(value, draftTo);
      if (!validation.fromError && !validation.toError) {
        const effectiveScope: StatsScopeMode = opsForbidden ? 'all' : scopeMode;
        setAppliedQuery({
          from: value,
          to: draftTo,
          productSlug: productSlug || undefined,
          scopeMode: effectiveScope,
        });
      }
    }
  };

  const handleToChange = (value: string) => {
    setDraftTo(value);
    setToError(undefined);
    if (draftFrom && value) {
      const validation = validateStatsDates(draftFrom, value);
      if (!validation.fromError && !validation.toError) {
        const effectiveScope: StatsScopeMode = opsForbidden ? 'all' : scopeMode;
        setAppliedQuery({
          from: draftFrom,
          to: value,
          productSlug: productSlug || undefined,
          scopeMode: effectiveScope,
        });
      }
    }
  };

  const handleProductChange = (value: string) => {
    setProductSlug(value);
    const validation = validateStatsDates(draftFrom, draftTo);
    if (!validation.fromError && !validation.toError) {
      const effectiveScope: StatsScopeMode = opsForbidden ? 'all' : scopeMode;
      setAppliedQuery({
        from: draftFrom || undefined,
        to: draftTo || undefined,
        productSlug: value || undefined,
        scopeMode: effectiveScope,
      });
    }
  };

  const handleScopeModeChange = (nextMode: StatsScopeMode) => {
    if (role !== 'ADMIN') return;
    if (opsForbidden && nextMode === 'ops') return;
    setScopeMode(nextMode);
    const validation = validateStatsDates(draftFrom, draftTo);
    if (!validation.fromError && !validation.toError) {
      setAppliedQuery({
        from: draftFrom || undefined,
        to: draftTo || undefined,
        productSlug: productSlug || undefined,
        scopeMode: nextMode,
      });
    }
  };

  const handleApply = () => {
    submitQuery(draftFrom, draftTo, productSlug, scopeMode);
  };

  const handleRefresh = () => {
    const validation = validateStatsDates(draftFrom, draftTo);
    setFromError(validation.fromError);
    setToError(validation.toError);
    if (validation.fromError || validation.toError) return;
    const effectiveScope: StatsScopeMode = opsForbidden ? 'all' : scopeMode;
    setAppliedQuery({
      from: draftFrom || undefined,
      to: draftTo || undefined,
      productSlug: productSlug || undefined,
      scopeMode: effectiveScope,
    });
    setRefreshNonce((n) => n + 1);
  };

  const firstSource = dto?.sources[0] ?? null;
  const siteTimezone = firstSource?.timezone ?? null;
  const siteRevision = firstSource?.timezoneRevision ?? null;
  const resolvedDefaultDay = useMemo(() => {
    if (!firstSource) return null;
    try {
      return siteLocalDate(new Date(firstSource.queriedAt), firstSource.timezone);
    } catch {
      return null;
    }
  }, [firstSource]);

  const displayedFrom = appliedQuery.from ?? resolvedDefaultDay;
  const displayedTo = appliedQuery.to ?? resolvedDefaultDay;

  const refreshFailed = errorBanner?.kind === 'stale-error';

  const retryAppliedQuery = () => {
    if (busy) return;
    if (!appliedQuery.from && !appliedQuery.to && resolvedDefaultDay) {
      setAppliedQuery({ ...appliedQuery, from: resolvedDefaultDay, to: resolvedDefaultDay });
    }
    setRefreshNonce((n) => n + 1);
  };

  const coreWatermark = useMemo(() => {
    if (!dto) return null;
    const coreSet = new Set<StatsSource>(CORE_SOURCES);
    const stamps = dto.sources
      .filter((s) => coreSet.has(s.source) && s.dataThrough)
      .map((s) => s.dataThrough!)
      .sort();
    if (stamps.length > 0) return stamps[stamps.length - 1]!;
    return null;
  }, [dto]);

  const coreItems = useMemo(() => {
    if (!dto) return [];
    const order = new Map(CORE_SOURCES.map((s, idx) => [s, idx]));
    return dto.sources
      .filter((s) => order.has(s.source))
      .slice()
      .sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0));
  }, [dto]);

  const businessItems = useMemo(() => {
    if (!dto) return [];
    const order = new Map(BUSINESS_SOURCES.map((s, idx) => [s, idx]));
    return dto.sources
      .filter((s) => order.has(s.source))
      .slice()
      .sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0));
  }, [dto]);

  const opsItems = useMemo(() => {
    if (!dto) return [];
    const order = new Map(OPS_SOURCES.map((s, idx) => [s, idx]));
    return dto.sources
      .filter((s) => order.has(s.source))
      .slice()
      .sort((a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0));
  }, [dto]);

  const startsItem = coreItems.find((s) => s.source === 'model_starts');
  const successesItem = coreItems.find((s) => s.source === 'model_successes');

  return (
    <div className="stats-page" data-testid="stats-page" data-role={role}>
      <header className="stats-header">
        <h1 className="stats-title">数据看板</h1>
        <p className="stats-subtitle">
          仅呈现当前角色获授权的真实聚合与只读计数来源；手动刷新只发安全 GET，不触发计划任务。
        </p>
      </header>

      <StatsFilters
        from={draftFrom}
        to={draftTo}
        productSlug={productSlug}
        products={products}
        isAdmin={role === 'ADMIN' && !opsForbidden}
        scopeMode={scopeMode}
        busy={busy}
        fromError={fromError}
        toError={toError}
        timezone={siteTimezone}
        timezoneRevision={siteRevision}
        appliedFrom={displayedFrom}
        appliedTo={displayedTo}
        watermark={coreWatermark}
        recomputableFrom={dto?.recomputableFrom ?? null}
        onFromChange={handleFromChange}
        onToChange={handleToChange}
        onProductChange={handleProductChange}
        onScopeModeChange={handleScopeModeChange}
        onApply={handleApply}
        onRefresh={handleRefresh}
      />

      {errorBanner && (
        <div
          className="stats-state-box"
          data-tone={errorBanner.kind === 'stale-error' ? 'warning' : 'error'}
          data-testid="stats-error-banner"
        >
          <Status
            tone={errorBanner.kind === 'stale-error' ? 'warning' : 'error'}
            prefix={errorBanner.kind === 'stale-error' ? '警示：' : '错误：'}
            urgent={errorBanner.kind !== 'stale-error'}
          >
            {errorBanner.text}
          </Status>
          {errorBanner.kind === 'unauthorized' ? (
            <Link href="/admin-login" className="stats-inline-link" data-testid="stats-relogin-link">
              重新登录
            </Link>
          ) : errorBanner.kind !== 'forbidden' ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="stats-retry"
              busy={busy}
              busyLabel="重试中…"
              onClick={retryAppliedQuery}
            >
              重试
            </Button>
          ) : null}
        </div>
      )}

      {busy && !dto && !errorBanner && (
        <div className="stats-state-box" data-tone="loading" data-testid="stats-loading">
          <Status tone="loading" prefix="加载中：">
            正在读取当前角色获授权的统计数据…
          </Status>
        </div>
      )}

      {dto && (
        <>
          {coreItems.length > 0 && (
            <section className="stats-section" aria-labelledby="stats-core-heading" data-testid="stats-section-core">
              <div className="stats-section-head">
                <h2 id="stats-core-heading" className="stats-section-title">
                  公开流量、产品归因与 3D 模型指标
                </h2>
                <span className="stats-section-note" data-testid="stats-ingestion-status">
                  站点自然日（{siteTimezone}）· 事件接收链路状态未知 · 最近接收时间未知
                </span>
              </div>
              <div className="stats-grid">
                {coreItems.map((item) => (
                  <SourceCard
                    key={item.source}
                    item={item}
                    refreshFailed={refreshFailed}
                    busy={busy}
                    onRetry={retryAppliedQuery}
                  />
                ))}
                {dto.modelSuccessRate !== null && dto.modelSuccessRate !== undefined && (
                  <ModelSuccessRateCard
                    rate={dto.modelSuccessRate}
                    startsSource={startsItem}
                    successesSource={successesItem}
                    refreshFailed={refreshFailed}
                  />
                )}
              </div>
            </section>
          )}

          {businessItems.length > 0 && (
            <section
              className="stats-section"
              aria-labelledby="stats-business-heading"
              data-testid="stats-section-business"
            >
              <div className="stats-section-head">
                <h2 id="stats-business-heading" className="stats-section-title">
                  询盘与第一方人工咨询
                </h2>
                <span className="stats-section-note">
                  只读统计已持久化业务主键（SALES 询盘受既有本人范围限制），不含邮箱或消息正文。
                </span>
              </div>
              <div className="stats-grid">
                {businessItems.map((item) => (
                  <SourceCard
                    key={item.source}
                    item={item}
                    refreshFailed={refreshFailed}
                    busy={busy}
                    onRetry={retryAppliedQuery}
                  />
                ))}
              </div>
            </section>
          )}

          {opsItems.length > 0 && (
            <section className="stats-section" aria-labelledby="stats-ops-heading" data-testid="stats-section-ops">
              <div className="stats-section-head">
                <h2 id="stats-ops-heading" className="stats-section-title">
                  系统可靠性、存储与备份（ADMIN）
                </h2>
                <span className="stats-section-note">
                  仅限 ADMIN 可见；单源未接入或故障独立呈现，不阻塞核心与业务指标读取。
                </span>
              </div>
              <div className="stats-grid">
                {opsItems.map((item) => (
                  <SourceCard
                    key={item.source}
                    item={item}
                    refreshFailed={refreshFailed}
                    busy={busy}
                    onRetry={retryAppliedQuery}
                  />
                ))}
              </div>
            </section>
          )}

          {firstSource && (
            <StatsTrend
              sources={dto.sources}
              timezone={firstSource.timezone}
              timezoneRevision={firstSource.timezoneRevision}
              refreshFailed={refreshFailed}
            />
          )}
        </>
      )}
    </div>
  );
}
