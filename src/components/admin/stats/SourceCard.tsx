import React from 'react';
import { Button } from '@/components/ui';
import type { StatsCoverage, StatsSource, StatsSourceDTO, StatsSourceState } from '@/lib/contracts';

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
    description: '访客同意分析后，按首条消息保存成功的咨询去重计数。',
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
    title: 'SMTP 已接受的咨询通知',
    enLabel: 'SMTP-accepted chat notifications',
    unit: 'count',
    description: '邮件服务器已接受的人工咨询通知数。',
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
    title: 'SMTP 已接受的出站邮件',
    enLabel: 'SMTP-accepted outbound mail',
    unit: 'count',
    description: '邮件服务器已接受的出站邮件数。',
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

export function formatStateBadge(state: StatsSourceState): { prefix: string; text: string } {
  switch (state) {
    case 'ok':
      return { prefix: '●', text: '查询成功（OK）' };
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
 * 严格按 09/11 节与 E-63 口径格式化单源数值（R4）：
 * - no_data / not_connected / query_failed(无值) / 无样本(null) 绝不渲染为 0；
 * - query_failed(无快照) 优先展示失败文案，绝不将失败误报为「无样本」；
 * - 只有 state === 'zero' 或确有 0 值时才显示 0。
 */
export function formatSourceValue(item: StatsSourceDTO): string {
  if (item.state === 'not_connected') return `Not connected: ${item.source}`;
  if (item.state === 'query_failed' && item.value === null) return '查询失败（无快照）';
  if (item.state === 'no_data') {
    if (item.source === 'mean_load_duration_ms' && item.coverage !== 'unavailable') {
      return '—（无样本）';
    }
    return 'No data yet';
  }
  if (item.value === null) {
    if (item.source === 'mean_load_duration_ms') return '—（无样本）';
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
 * 格式化 3D 平均加载耗时的有效终态样本数（samples）：
 * 未接入或无留存快照的查询失败属于未知状态，返回 '—' 而非断言 0。
 */
export function formatDurationSamples(item: StatsSourceDTO): string {
  if (item.state === 'not_connected') return '—';
  if (item.state === 'query_failed' && item.value === null) return '—';
  return (item.loadDurationSamples ?? 0).toLocaleString('en-US');
}

export function sourceDisplayState(item: StatsSourceDTO, refreshFailed: boolean): StatsSourceState {
  return refreshFailed && item.value !== null && item.state !== 'query_failed' ? 'stale' : item.state;
}

export function sourceStatusText(item: StatsSourceDTO, state: StatsSourceState): string {
  return state === 'query_failed' && item.value !== null
    ? '查询失败 · 保留旧值'
    : formatStateBadge(state).text;
}

export function SourceTime({ value }: { value: string | null }) {
  return value
    ? <time className="stats-mono" dateTime={value}>{value}</time>
    : <span>未知</span>;
}

export default function SourceCard({
  item,
  refreshFailed,
  busy,
  onRetry,
}: {
  item: StatsSourceDTO;
  refreshFailed: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const meta = SOURCE_CATALOG[item.source];
  const state = sourceDisplayState(item, refreshFailed);
  const badge = formatStateBadge(state);
  const isAlert = state === 'query_failed' || state === 'stale';

  return (
    <article
      className="stats-card"
      aria-busy={busy}
      data-testid={`stats-source-${item.source}`}
      data-source-state={state}
      data-alert={isAlert ? 'true' : undefined}
    >
      <div className="stats-card-top">
        <div>
          <h3 className="stats-card-title">{meta.title}</h3>
          <p className="stats-card-desc">{meta.enLabel}</p>
        </div>
        <span
          className="stats-badge"
          aria-live="polite"
          aria-atomic="true"
          data-state={state}
          data-testid={`stats-state-${item.source}`}
        >
          <span aria-hidden="true">{badge.prefix}</span>
          <span>{sourceStatusText(item, state)}</span>
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
            <span className="stats-mono">{formatDurationSamples(item)}</span>
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
          <SourceTime value={item.dataThrough} />
        </p>
        <p>
          <strong>最近成功：</strong>
          <SourceTime value={item.lastSucceededAt} />
        </p>
        <p>
          <strong>查询时间：</strong>
          <SourceTime value={item.queriedAt} />
        </p>
        {isAlert && (
          <Button
            variant="secondary"
            aria-label={`重试读取${meta.title}`}
            data-testid={`stats-retry-${item.source}`}
            busy={busy}
            busyLabel="重试中…"
            onClick={onRetry}
          >
            重试
          </Button>
        )}
      </div>
    </article>
  );
}
