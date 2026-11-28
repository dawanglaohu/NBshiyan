'use client';

import React from 'react';
import { Button, Input, Select } from '@/components/ui';

export type StatsProductOption = {
  slug: string;
  label: string;
};

export type StatsScopeMode = 'all' | 'ops';

export type StatsFiltersProps = {
  from: string;
  to: string;
  productSlug: string;
  products: readonly StatsProductOption[];
  isAdmin: boolean;
  scopeMode: StatsScopeMode;
  busy: boolean;
  fromError?: string;
  toError?: string;
  timezone: string | null;
  timezoneRevision: number | null;
  appliedFrom: string | null;
  appliedTo: string | null;
  watermark: string | null;
  recomputableFrom: string | null;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onProductChange: (value: string) => void;
  onScopeModeChange: (mode: StatsScopeMode) => void;
  onApply: () => void;
  onRefresh: () => void;
};

/**
 * 看板顶部筛选与站点时区/水位摘要组件（纯展示，不直接发请求、不读本地时区算今日）。
 * 日期、产品与刷新控件均使用 M1 原生 UI 包装组件，保持桌面 36px / 触屏 44px 与 2px 纯黑框。
 */
export default function StatsFilters({
  from,
  to,
  productSlug,
  products,
  isAdmin,
  scopeMode,
  busy,
  fromError,
  toError,
  timezone,
  timezoneRevision,
  appliedFrom,
  appliedTo,
  watermark,
  recomputableFrom,
  onFromChange,
  onToChange,
  onProductChange,
  onScopeModeChange,
  onApply,
  onRefresh,
}: StatsFiltersProps) {
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onApply();
  };

  return (
    <section className="stats-filters-card" aria-label="统计筛选与口径信息" data-testid="stats-filters">
      <form className="stats-filters-form" onSubmit={handleSubmit} noValidate>
        <div className="stats-filter-item">
          <Input
            id="stats-from"
            type="date"
            data-testid="stats-filter-from"
            label="开始日期（站点日）"
            value={from}
            error={fromError}
            onChange={(event) => onFromChange(event.target.value)}
          />
        </div>
        <div className="stats-filter-item">
          <Input
            id="stats-to"
            type="date"
            data-testid="stats-filter-to"
            label="结束日期（站点日）"
            value={to}
            error={toError}
            onChange={(event) => onToChange(event.target.value)}
          />
        </div>
        <div className="stats-filter-item stats-filter-item-wide">
          <Select
            id="stats-product"
            data-testid="stats-filter-product"
            label="产品筛选"
            value={productSlug}
            onChange={(event) => onProductChange(event.target.value)}
          >
            <option value="">全部产品（全站汇总）</option>
            {products.map((product) => (
              <option key={product.slug} value={product.slug}>
                {product.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="stats-filter-actions">
          <Button
            type="submit"
            variant="primary"
            data-testid="stats-apply"
            busy={busy}
            busyLabel="查询中…"
          >
            查询
          </Button>
          <Button
            type="button"
            variant="secondary"
            data-testid="stats-refresh"
            busy={busy}
            busyLabel="刷新中…"
            onClick={onRefresh}
          >
            刷新
          </Button>
        </div>
      </form>

      {isAdmin && (
        <div className="stats-scope-bar" role="group" aria-label="指标来源范围">
          <span className="stats-scope-label">查看范围：</span>
          <Button
            type="button"
            variant={scopeMode === 'all' ? 'primary' : 'secondary'}
            aria-pressed={scopeMode === 'all'}
            data-testid="stats-scope-all"
            onClick={() => onScopeModeChange('all')}
          >
            全部授权来源
          </Button>
          <Button
            type="button"
            variant={scopeMode === 'ops' ? 'primary' : 'secondary'}
            aria-pressed={scopeMode === 'ops'}
            data-testid="stats-scope-ops"
            onClick={() => onScopeModeChange('ops')}
          >
            仅系统运维
          </Button>
        </div>
      )}

      <div className="stats-meta-bar" aria-live="polite">
        <span className="stats-meta-tag" data-testid="stats-timezone">
          <strong>站点时区：</strong>
          <span className="stats-mono">
            {timezone ? `${timezone} (rev ${timezoneRevision ?? 1})` : '读取中…'}
          </span>
        </span>
        <span className="stats-meta-tag" data-testid="stats-date-range">
          <strong>统计区间：</strong>
          <span className="stats-mono">
            {appliedFrom && appliedTo ? `${appliedFrom} → ${appliedTo}` : '默认站点今日'}
          </span>
        </span>
        <span className="stats-meta-tag" data-testid="stats-watermark">
          <strong>数据截止（dataThrough）：</strong>
          <span className="stats-mono">{watermark ?? '尚无聚合水位'}</span>
        </span>
        <span className="stats-meta-tag" data-testid="stats-recomputable">
          <strong>时区重算范围：</strong>
          <span>
            {recomputableFrom
              ? `Only part of this period can be recalculated（自 ${recomputableFrom} 起可重算；更早历史保留原时区标签）`
              : '当前无待处理重算'}
          </span>
        </span>
      </div>
    </section>
  );
}
