import React from 'react';
import type { StatsSourceDTO } from '@/lib/contracts';
import {
  formatCoverageText, formatDurationSamples, formatSourceValue, formatStateBadge,
  SOURCE_CATALOG, SourceTime, sourceDisplayState, sourceStatusText,
} from './SourceCard';

function StatsComparisonChart({
  sources,
  timezone,
  refreshFailed,
}: {
  sources: readonly StatsSourceDTO[];
  timezone: string;
  refreshFailed: boolean;
}) {
  const countSources = sources.filter((item) => SOURCE_CATALOG[item.source].unit === 'count');
  const partialSources = countSources.filter((item) => item.coverage === 'partial');
  const comparable = refreshFailed ? [] : countSources.filter(
    (item): item is StatsSourceDTO & { value: number } =>
      item.value !== null && (item.state === 'ok' || item.state === 'zero'),
  );
  const maxVal = Math.max(1, ...comparable.map((s) => s.value));
  const rowHeight = 28;
  const chartHeight = Math.max(48, comparable.length * rowHeight + 16);

  return (
    <section className="stats-panel" aria-labelledby="stats-chart-heading" data-testid="stats-chart-panel">
      <div className="stats-section-head">
        <h2 id="stats-chart-heading" className="stats-section-title">
          同源计数对比（单位：事件/业务记录数 · 站点时区 {timezone}）
        </h2>
        <span className="stats-section-note">
          比较本次可用的计数。旧值、不可用来源及其他单位见明细表。
        </span>
      </div>

      {partialSources.length > 0 && (
        <p className="stats-section-note" data-testid="stats-trend-coverage">
          部分覆盖（部分日期或接入范围）：{partialSources.map((item) => SOURCE_CATALOG[item.source].title).join('、')}
        </p>
      )}
      {comparable.length === 0 ? (
        <p className="stats-section-note" data-testid="stats-chart-empty">
          {refreshFailed ? '本次刷新失败，旧值见明细表。' : '当前区间没有可比较的计数。'}
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
              {comparable.map((item) => `${SOURCE_CATALOG[item.source].title}: ${item.value}`).join('；')}
            </desc>
            {comparable.map((item, idx) => {
              const y = 8 + idx * rowHeight;
              const val = item.value;
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

export default function StatsTrend({
  sources,
  timezone,
  timezoneRevision,
  refreshFailed,
}: {
  sources: readonly StatsSourceDTO[];
  timezone: string;
  timezoneRevision: number;
  refreshFailed: boolean;
}) {
  return (
    <>
      <StatsComparisonChart sources={sources} timezone={timezone} refreshFailed={refreshFailed} />
      <section className="stats-panel" aria-labelledby="stats-table-heading" data-testid="stats-table-panel">
        <div className="stats-section-head">
          <h2 id="stats-table-heading" className="stats-section-title">
            授权来源明细表（共 {sources.length} 项）
          </h2>
          <span className="stats-section-note">
            站点时区：{timezone}（rev {timezoneRevision}）
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
                <th scope="col">查询时间（queriedAt）</th>
                <th scope="col">站点时区</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((item) => {
                const meta = SOURCE_CATALOG[item.source];
                const state = sourceDisplayState(item, refreshFailed);
                const badge = formatStateBadge(state);
                return (
                  <tr key={item.source} data-testid={`stats-row-${item.source}`}>
                    <td>
                      <strong>{meta.title}</strong>{' '}
                      <span className="stats-mono">({item.source})</span>
                    </td>
                    <td>
                      <span aria-hidden="true">{badge.prefix}</span> {sourceStatusText(item, state)}
                    </td>
                    <td className="stats-col-num stats-mono">{formatSourceValue(item)}</td>
                    <td>
                      {item.source === 'mean_load_duration_ms'
                        ? `samples=${formatDurationSamples(item)} · ${formatCoverageText(item.coverage)}`
                        : formatCoverageText(item.coverage)}
                    </td>
                    <td><SourceTime value={item.dataThrough} /></td>
                    <td><SourceTime value={item.lastSucceededAt} /></td>
                    <td><SourceTime value={item.queriedAt} /></td>
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
  );
}
