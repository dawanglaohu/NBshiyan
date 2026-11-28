'use client';

import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Status } from '@/components/ui';
import { siteLocalDate } from '@/lib/analytics/day-boundaries';
import { getStats, type StatsResult } from '@/lib/client/ops';
import type {
  AccountRole,
  StatsCoverage,
  StatsDTO,
  StatsModelSuccessRateDTO,
  StatsQueryDTO,
  StatsSource,
  StatsSourceDTO,
  StatsSourceState,
} from '@/lib/contracts';
import StatsFilters, { type StatsProductOption, type StatsScopeMode } from './StatsFilters';

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

type SourceMeta = {
  title: string;
  enLabel: string;
  unit: 'count' | 'ms' | 'bytes' | 'seconds';
  description: string;
};

export const SOURCE_CATALOG: Readonly<Record<StatsSource, SourceMeta>> = {
  visitors: {
    title: '授权匿名浏览器',
    enLabel: 'Consenting visitors',
    unit: 'count',
    description: '获分析同意后在同一站点自然日去重的匿名浏览器数（非跨设备唯一真人）。',
  },
  page_views: {
    title: '页面浏览量（PV）',
    enLabel: 'Page views',
    unit: 'count',
    description: '获分析同意后已完成的站内页面访问计数；单产品维度不拆页面 PV。',
  },
  product_views: {
    title: '产品归因访问',
    enLabel: 'Product views',
    unit: 'count',
    description: '获分析同意后绑定已发布产品 slug 的产品上下文访问次数。',
  },
  model_starts: {
    title: '3D 模型发起',
    enLabel: '3D model starts',
    unit: 'count',
    description: '获分析同意后真实 GLB 加载发起次数（作为配对成功率唯一分母）。',
  },
  model_successes: {
    title: '3D 加载成功',
    enLabel: '3D load successes',
    unit: 'count',
    description: '与同浏览器同 viewId 发起配对的真实 GLB 成功终态（海报/回退不计入）。',
  },
  model_failures: {
    title: '3D 加载失败/超时',
    enLabel: '3D load failures',
    unit: 'count',
    description: '与真实发起配对的失败或超时终态（每 viewId 至多记录一个终态）。',
  },
  mean_load_duration_ms: {
    title: '3D 平均加载耗时',
    enLabel: 'Mean 3D load duration',
    unit: 'ms',
    description: '按有效配对终态耗时样本加权计算；无样本时为 null，绝不填 0。',
  },
  chat_starts: {
    title: '分析咨询发起',
    enLabel: 'Chat starts',
    unit: 'count',
    description: '获分析同意后记录的站内咨询打开事件去重汇总。',
  },
  inquiries: {
    title: '已保存询盘',
    enLabel: 'Saved inquiries',
    unit: 'count',
    description: '按当前角色可见范围（SALES 受派范围）统计已持久化的真实询盘编号数。',
  },
  chat_conversations: {
    title: '人工咨询会话',
    enLabel: 'Chat conversations',
    unit: 'count',
    description: '所选站点日区间内已持久化创建的第一方人工咨询会话数。',
  },
  chat_messages: {
    title: '咨询收件消息',
    enLabel: 'Chat messages',
    unit: 'count',
    description: '已持久化收件的消息标识计数（同 UUID 幂等重试不重复累加）。',
  },
  chat_notifications: {
    title: '咨询通知状态',
    enLabel: 'Chat notifications',
    unit: 'count',
    description: '持久通知出箱真实尝试计数（未接入适配器时显示未接入）。',
  },
  api_requests: {
    title: '已接线 API 请求数',
    enLabel: 'Instrumented API requests',
    unit: 'count',
    description: '仅限本轮已接线路由最终响应计数，不声称全站请求量。',
  },
  api_errors: {
    title: '已接线 API 5xx 错误',
    enLabel: 'Instrumented API 5xx',
    unit: 'count',
    description: '仅限本轮已接线路由的 5xx 响应计数，与同范围请求数配对阅读。',
  },
  mail: {
    title: '邮件队列真实投递',
    enLabel: 'Mail queue attempts',
    unit: 'count',
    description: '按真实发送尝试记录，排队或收件不计作投递成功。',
  },
  storage: {
    title: '受控存储已用空间',
    enLabel: 'Controlled storage used',
    unit: 'bytes',
    description: '受控上传目录采样字节计数，不接受任意路径或文件内容读取。',
  },
  backup: {
    title: '最近备份距今时长',
    enLabel: 'Latest backup age',
    unit: 'seconds',
    description: '受控备份元数据距今秒数；未完成隔离恢复演练时覆盖标为 partial。',
  },
};

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

export function formatStateBadge(state: StatsSourceState): { prefix: string; text: string } {
  switch (state) {
    case 'ok':
      return { prefix: '●', text: '正常（OK）' };
    case 'zero':
      return { prefix: '○', text: '真实零值（0）' };
    case 'no_data':
      return { prefix: '—', text: '尚无数据（No data yet）' };
    case 'not_connected':
      return { prefix: '◌', text: '未接入（Not connected）' };
    case 'query_failed':
      return { prefix: '▲', text: '查询失败（Failed）' };
    case 'stale':
      return { prefix: '△', text: '旧值（Stale）' };
  }
}

export function formatCoverageText(coverage: StatsCoverage): string {
  switch (coverage) {
    case 'full':
      return '完整覆盖（full）';
    case 'partial':
      return '部分覆盖（partial）';
    case 'unavailable':
      return '无覆盖（unavailable）';
  }
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString('en-US')} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB (${bytes.toLocaleString('en-US')} B)`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB (${bytes.toLocaleString('en-US')} B)`;
}

/**
 * 严格按 09/11 节与 E-63 口径格式化单源数值：
 * - no_data / not_connected / query_failed(无值) / 无样本(null) 绝不渲染为 0；
 * - 只有 state === 'zero' 或确有 0 值时才显示 0。
 */
export function formatSourceValue(item: StatsSourceDTO): string {
  if (item.state === 'not_connected') return `Not connected: ${item.source}`;
  if (item.state === 'no_data') return 'No data yet';
  if (item.value === null) {
    if (item.source === 'mean_load_duration_ms') return '—（无样本）';
    if (item.state === 'query_failed') return '查询失败（无快照）';
    return '—';
  }
  const meta = SOURCE_CATALOG[item.source];
  if (meta.unit === 'ms') {
    const rounded = Number.isInteger(item.value) ? String(item.value) : item.value.toFixed(1);
    return `${rounded} ms`;
  }
  if (meta.unit === 'bytes') return formatByteCount(item.value);
  if (meta.unit === 'seconds') return `${item.value.toLocaleString('en-US')} s`;
  return item.value.toLocaleString('en-US');
}

/**
 * 格式化配对 3D 加载成功率（E-63）：
 * 分母仅为获同意后真实 model_view_start；无样本返回无样本说明，有发起分母且零成功才返回 0%。
 */
export function formatModelSuccessRate(rate: StatsModelSuccessRateDTO): string {
  if (rate.value === null) return '—（无发起样本）';
  if (rate.value === 0) return '0%';
  const pct = (rate.value * 100).toFixed(1).replace(/\.0$/, '');
  return `${pct}%`;
}

/**
 * 同查询键合并逐源旧值：若某源当前为 query_failed 且 value === null，但上次同键快照有成功值，
 * 保留旧数值与原 dataThrough / lastSucceededAt，同时将状态保持为 query_failed 并标记保留旧值。
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
      if (prev && prev.value !== null && prev.lastSucceededAt !== null) {
        retained.add(item.source);
        return {
          ...item,
          value: prev.value,
          dataThrough: prev.dataThrough,
          lastSucceededAt: prev.lastSucceededAt,
          loadDurationSamples: prev.loadDurationSamples,
        };
      }
    }
    return item;
  });
  return {
    dto: {
      ...current,
      sources: merged,
    },
    retainedSources: retained,
  };
}

function SourceCardView({
  item,
  retainedFromSnapshot,
}: {
  item: StatsSourceDTO;
  retainedFromSnapshot: boolean;
}) {
  const meta = SOURCE_CATALOG[item.source];
  const badge = formatStateBadge(item.state);
  const isAlert = item.state === 'query_failed' || item.state === 'stale';

  return (
    <article
      className="stats-card"
      data-testid={`stats-source-${item.source}`}
      data-source-state={item.state}
      data-alert={isAlert ? 'true' : undefined}
    >
      <div className="stats-card-top">
        <div>
          <h3 className="stats-card-title">{meta.title}</h3>
          <p className="stats-card-desc">{meta.enLabel}</p>
        </div>
        <span
          className="stats-badge"
          data-state={item.state}
          data-testid={`stats-state-${item.source}`}
        >
          <span aria-hidden="true">{badge.prefix}</span>
          <span>{badge.text}</span>
        </span>
      </div>

      <p className="stats-value" data-testid={`stats-value-${item.source}`}>
        {formatSourceValue(item)}
      </p>

      <p className="stats-card-desc">{meta.description}</p>

      <div className="stats-card-meta">
        {item.source === 'mean_load_duration_ms' && (
          <p data-testid="stats-duration-samples">
            <strong>有效终态样本（samples）：</strong>
            <span className="stats-mono">{item.loadDurationSamples ?? 0}</span>
          </p>
        )}
        {retainedFromSnapshot && item.lastSucceededAt && (
          <p>
            <strong>旧值保留：</strong>Couldn&apos;t refresh. Showing data through {item.dataThrough ?? item.lastSucceededAt}.
          </p>
        )}
        <p>
          <strong>覆盖：</strong>
          <span>{formatCoverageText(item.coverage)}</span>
          {' · '}
          <strong>时区：</strong>
          <span className="stats-mono">{item.timezone} (rev {item.timezoneRevision})</span>
        </p>
        <p>
          <strong>数据截止：</strong>
          <span className="stats-mono">{item.dataThrough ?? '—'}</span>
        </p>
        <p>
          <strong>最近成功：</strong>
          <span className="stats-mono">{item.lastSucceededAt ?? '—'}</span>
        </p>
      </div>
    </article>
  );
}

function ModelSuccessRateCard({
  rate,
  startsSource,
  successesSource,
}: {
  rate: StatsModelSuccessRateDTO;
  startsSource?: StatsSourceDTO;
  successesSource?: StatsSourceDTO;
}) {
  const isZeroOrOk = rate.value !== null;
  const badgeState: StatsSourceState = rate.coverage === 'unavailable'
    ? 'not_connected'
    : rate.value === null
      ? 'no_data'
      : rate.value === 0
        ? 'zero'
        : 'ok';
  const badge = formatStateBadge(badgeState);

  return (
    <article
      className="stats-card"
      data-testid="stats-model-success-rate"
      data-source-state={badgeState}
    >
      <div className="stats-card-top">
        <div>
          <h3 className="stats-card-title">3D 加载成功率</h3>
          <p className="stats-card-desc">3D load success rate</p>
        </div>
        <span className="stats-badge" data-state={badgeState}>
          <span aria-hidden="true">{badge.prefix}</span>
          <span>{badge.text}</span>
        </span>
      </div>

      <p className="stats-value" data-testid="stats-value-model_success_rate">
        {formatModelSuccessRate(rate)}
      </p>

      <p className="stats-card-desc">
        配对口径（09 节 / E-63）：以获同意后真实 model_view_start 为唯一分母；无发起样本为 null，有样本零成功才显示 0%。
      </p>

      <div className="stats-card-meta">
        <p data-testid="stats-success-rate-pair">
          <strong>配对读数：</strong>
          <span className="stats-mono">
            {isZeroOrOk
              ? `${successesSource?.value ?? 0} / ${startsSource?.value ?? 0} starts`
              : '0 starts（无配对分母）'}
          </span>
        </p>
        <p>
          <strong>覆盖：</strong>
          <span>{formatCoverageText(rate.coverage)}</span>
          {startsSource && (
            <>
              {' · '}
              <strong>时区：</strong>
              <span className="stats-mono">{startsSource.timezone} (rev {startsSource.timezoneRevision})</span>
            </>
          )}
        </p>
        <p>
          <strong>数据截止：</strong>
          <span className="stats-mono">{startsSource?.dataThrough ?? '—'}</span>
        </p>
      </div>
    </article>
  );
}

function StatsComparisonChart({
  sources,
  timezone,
}: {
  sources: readonly StatsSourceDTO[];
  timezone: string;
}) {
  const comparable = sources.filter(
    (s) => SOURCE_CATALOG[s.source].unit === 'count' && s.value !== null && (s.state === 'ok' || s.state === 'zero' || s.state === 'stale'),
  );
  const maxVal = Math.max(1, ...comparable.map((s) => s.value ?? 0));
  const rowHeight = 28;
  const chartHeight = Math.max(48, comparable.length * rowHeight + 16);

  return (
    <section className="stats-panel" aria-labelledby="stats-chart-heading" data-testid="stats-chart-panel">
      <div className="stats-section-head">
        <h2 id="stats-chart-heading" className="stats-section-title">
          同源计数对比（单位：事件/业务记录数 · 站点时区 {timezone}）
        </h2>
        <span className="stats-section-note">
          与下方明细表共享同一份 StatsDTO；未接入、无数据与非计数单位（ms/字节/秒）不参与等比例条形比较。
        </span>
      </div>

      {comparable.length === 0 ? (
        <p className="stats-section-note" data-testid="stats-chart-empty">
          当前所选区间尚无已就绪的计数型指标样本（No comparable count readings yet）。
        </p>
      ) : (
        <figure className="stats-svg-wrap">
          <svg
            className="stats-svg"
            viewBox={`0 0 720 ${chartHeight}`}
            role="img"
            aria-labelledby="stats-chart-title stats-chart-desc"
            data-testid="stats-svg-chart"
          >
            <title id="stats-chart-title">授权计数来源对比图（时区 {timezone}）</title>
            <desc id="stats-chart-desc">
              {comparable.map((item) => `${SOURCE_CATALOG[item.source].title}: ${item.value ?? 0}`).join('；')}
            </desc>
            {comparable.map((item, idx) => {
              const y = 8 + idx * rowHeight;
              const val = item.value ?? 0;
              const barWidth = Math.round((val / maxVal) * 400);
              return (
                <g key={item.source} transform={`translate(0, ${y})`}>
                  <text x="0" y="16" fill="#000000" fontSize="13" fontWeight="600">
                    {SOURCE_CATALOG[item.source].title}
                  </text>
                  <rect x="200" y="3" width="404" height="18" fill="#ffffff" stroke="#000000" strokeWidth="2" />
                  {barWidth > 0 && (
                    <rect x="202" y="5" width={barWidth} height="14" fill="#000000" />
                  )}
                  <text x="616" y="16" fill="#000000" fontSize="13" fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace">
                    {val.toLocaleString('en-US')}
                  </text>
                </g>
              );
            })}
          </svg>
        </figure>
      )}
    </section>
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
  const [retainedSources, setRetainedSources] = useState<ReadonlySet<StatsSource>>(new Set());
  const [errorBanner, setErrorBanner] = useState<{
    kind: 'unauthorized' | 'forbidden' | 'stale-error' | 'fatal-error';
    text: string;
  } | null>(null);

  const snapshotsRef = useRef<Map<string, StatsDTO>>(new Map());
  const activeAbortRef = useRef<AbortController | null>(null);
  const initializedDatesRef = useRef(false);

  const activeKey = useMemo(
    () =>
      buildStatsSnapshotKey({
        role,
        from: appliedQuery.from,
        to: appliedQuery.to,
        productSlug: appliedQuery.productSlug,
        scopeMode: appliedQuery.scopeMode,
      }),
    [role, appliedQuery.from, appliedQuery.to, appliedQuery.productSlug, appliedQuery.scopeMode],
  );

  useEffect(() => {
    activeAbortRef.current?.abort();
    const controller = new AbortController();
    activeAbortRef.current = controller;

    const previousGood = snapshotsRef.current.get(activeKey) ?? null;
    if (!previousGood) {
      setDto(null);
      setRetainedSources(new Set());
    }
    setBusy(true);
    setErrorBanner(null);

    const requestQuery: StatsQueryDTO = {
      ...(appliedQuery.from ? { from: appliedQuery.from } : {}),
      ...(appliedQuery.to ? { to: appliedQuery.to } : {}),
      ...(appliedQuery.productSlug ? { productSlug: appliedQuery.productSlug } : {}),
      ...(role === 'ADMIN' && appliedQuery.scopeMode === 'ops' ? { sources: [...OPS_SOURCES] } : {}),
    };

    void api
      .query(requestQuery, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setBusy(false);

        if (result.ok) {
          const first = result.data.sources[0];
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

          const merged = mergeSnapshotSources(result.data, previousGood);
          setDto(merged.dto);
          setRetainedSources(merged.retainedSources);

          const hasGoodReading = merged.dto.sources.some((s) => s.value !== null || s.state === 'zero' || s.state === 'ok');
          if (hasGoodReading) {
            snapshotsRef.current.set(activeKey, merged.dto);
            if (resolvedDay && !appliedQuery.from && !appliedQuery.to) {
              const explicitKey = buildStatsSnapshotKey({
                role,
                from: resolvedDay,
                to: resolvedDay,
                productSlug: appliedQuery.productSlug,
                scopeMode: appliedQuery.scopeMode,
              });
              snapshotsRef.current.set(explicitKey, merged.dto);
            }
          }
          return;
        }

        if (result.action === 'login' || result.status === 401) {
          snapshotsRef.current.clear();
          setDto(null);
          setRetainedSources(new Set());
          setErrorBanner({
            kind: 'unauthorized',
            text: 'Your session has ended. Sign in again to continue.（当前会话已失效，请重新登录。）',
          });
          return;
        }

        if (result.status === 403) {
          setDto(null);
          setRetainedSources(new Set());
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

        if (previousGood) {
          const oldThrough =
            previousGood.sources.find((s) => s.dataThrough)?.dataThrough ??
            previousGood.sources.find((s) => s.lastSucceededAt)?.lastSucceededAt ??
            '上次成功读取';
          setDto(previousGood);
          setErrorBanner({
            kind: 'stale-error',
            text: `Couldn't refresh. Showing data through ${oldThrough}.（${result.text || '刷新失败，当前保留原成功快照时间与数值。'}）`,
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
        if (previousGood) {
          const oldThrough =
            previousGood.sources.find((s) => s.dataThrough)?.dataThrough ??
            previousGood.sources.find((s) => s.lastSucceededAt)?.lastSucceededAt ??
            '上次成功读取';
          setDto(previousGood);
          setErrorBanner({
            kind: 'stale-error',
            text: `Couldn't refresh. Showing data through ${oldThrough}.（网络异常，保留原成功快照。）`,
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
  }, [activeKey, api, appliedQuery, refreshNonce, role]);

  const submitQuery = useCallback(
    (nextFrom: string, nextTo: string, nextProduct: string, nextScope: StatsScopeMode) => {
      const validation = validateStatsDates(nextFrom, nextTo);
      setFromError(validation.fromError);
      setToError(validation.toError);
      if (validation.fromError || validation.toError) return;
      setAppliedQuery({
        from: nextFrom || undefined,
        to: nextTo || undefined,
        productSlug: nextProduct || undefined,
        scopeMode: nextScope,
      });
    },
    [],
  );

  const handleFromChange = (value: string) => {
    setDraftFrom(value);
    setFromError(undefined);
    if (value && draftTo) {
      const validation = validateStatsDates(value, draftTo);
      if (!validation.fromError && !validation.toError) {
        setAppliedQuery({
          from: value,
          to: draftTo,
          productSlug: productSlug || undefined,
          scopeMode,
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
        setAppliedQuery({
          from: draftFrom,
          to: value,
          productSlug: productSlug || undefined,
          scopeMode,
        });
      }
    }
  };

  const handleProductChange = (value: string) => {
    setProductSlug(value);
    const validation = validateStatsDates(draftFrom, draftTo);
    if (!validation.fromError && !validation.toError) {
      setAppliedQuery({
        from: draftFrom || undefined,
        to: draftTo || undefined,
        productSlug: value || undefined,
        scopeMode,
      });
    }
  };

  const handleScopeModeChange = (nextMode: StatsScopeMode) => {
    if (role !== 'ADMIN') return;
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
    setAppliedQuery({
      from: draftFrom || undefined,
      to: draftTo || undefined,
      productSlug: productSlug || undefined,
      scopeMode,
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

  const coreWatermark = useMemo(() => {
    if (!dto) return null;
    const coreSet = new Set<StatsSource>(CORE_SOURCES);
    const stamps = dto.sources
      .filter((s) => coreSet.has(s.source) && s.dataThrough)
      .map((s) => s.dataThrough!)
      .sort();
    if (stamps.length > 0) return stamps[stamps.length - 1]!;
    const fallback = dto.sources.find((s) => s.dataThrough)?.dataThrough ?? null;
    return fallback;
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
        isAdmin={role === 'ADMIN'}
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
              onClick={handleRefresh}
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
                <span className="stats-section-note">
                  5 分钟聚合作业一致快照；所有日期边界均按站点 IANA 时区 [{siteTimezone}] 自然日计算。
                </span>
              </div>
              <div className="stats-grid">
                {coreItems.map((item) => (
                  <SourceCardView
                    key={item.source}
                    item={item}
                    retainedFromSnapshot={retainedSources.has(item.source)}
                  />
                ))}
                {dto.modelSuccessRate !== null && dto.modelSuccessRate !== undefined && (
                  <ModelSuccessRateCard
                    rate={dto.modelSuccessRate}
                    startsSource={startsItem}
                    successesSource={successesItem}
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
                  <SourceCardView
                    key={item.source}
                    item={item}
                    retainedFromSnapshot={retainedSources.has(item.source)}
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
                  <SourceCardView
                    key={item.source}
                    item={item}
                    retainedFromSnapshot={retainedSources.has(item.source)}
                  />
                ))}
              </div>
            </section>
          )}

          <StatsComparisonChart sources={dto.sources} timezone={siteTimezone ?? 'UTC'} />

          <section className="stats-panel" aria-labelledby="stats-table-heading" data-testid="stats-table-panel">
            <div className="stats-section-head">
              <h2 id="stats-table-heading" className="stats-section-title">
                授权来源明细表（共 {dto.sources.length} 项）
              </h2>
              <span className="stats-section-note">
                站点时区：{siteTimezone ?? 'UTC'}（rev {siteRevision ?? 1}）
              </span>
            </div>
            <div className="stats-table-wrap">
              <table className="stats-table" data-testid="stats-table">
                <thead>
                  <tr>
                    <th scope="col">来源（Source）</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="stats-col-num">数值</th>
                    <th scope="col">样本 / 覆盖</th>
                    <th scope="col">数据截止（dataThrough）</th>
                    <th scope="col">最近成功（lastSucceededAt）</th>
                    <th scope="col">站点时区</th>
                  </tr>
                </thead>
                <tbody>
                  {dto.sources.map((item) => {
                    const meta = SOURCE_CATALOG[item.source];
                    const badge = formatStateBadge(item.state);
                    return (
                      <tr key={item.source} data-testid={`stats-row-${item.source}`}>
                        <td>
                          <strong>{meta.title}</strong>{' '}
                          <span className="stats-mono">({item.source})</span>
                        </td>
                        <td>
                          {badge.prefix} {badge.text}
                        </td>
                        <td className="stats-col-num stats-mono">{formatSourceValue(item)}</td>
                        <td>
                          {item.source === 'mean_load_duration_ms'
                            ? `samples=${item.loadDurationSamples ?? 0} · ${formatCoverageText(item.coverage)}`
                            : formatCoverageText(item.coverage)}
                        </td>
                        <td className="stats-mono">{item.dataThrough ?? '—'}</td>
                        <td className="stats-mono">{item.lastSucceededAt ?? '—'}</td>
                        <td className="stats-mono">
                          {item.timezone} (rev {item.timezoneRevision})
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
