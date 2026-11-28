'use client';

import { requestApi, type ClientApiResult } from './api';
import {
  AnalyticsSettingsDTOSchema,
  AnalyticsSettingsUpdateDTOSchema,
  StatsDTOSchema,
  type AnalyticsSettingsDTO,
  type AnalyticsSettingsUpdateDTO,
  type StatsDTO,
  type StatsQueryDTO,
} from '@/lib/contracts';

/**
 * 后台统计设置（M5-T10）与数据看板查询（M6-T4）的统一客户端请求入口。
 *
 * 与 account.ts 同一约定：只在这里追加方法，不重造 fetch/重试/错误适配；`requestApi`
 * 负责同源、截止时间、错误信封与 401 的 admin 语义。手动刷新始终只走安全 GET，
 * 不调用 /api/admin/cron/* 或 /api/internal/ops-report。
 */

export type AnalyticsSettingsResult = ClientApiResult<AnalyticsSettingsDTO>;
export type AnalyticsSettingsUpdateResult = ClientApiResult<AnalyticsSettingsUpdateDTO>;
export type StatsResult = ClientApiResult<StatsDTO>;

type RequestOptions = { signal?: AbortSignal; locale?: 'en' | 'ru' };

/** 读站点统计时区：GET /api/admin/settings/analytics（四字段 DTO，recomputableFrom 可为 null）。 */
export function getAnalyticsSettings(options: RequestOptions = {}): Promise<AnalyticsSettingsResult> {
  return requestApi({
    path: '/api/admin/settings/analytics',
    method: 'GET',
    schema: AnalyticsSettingsDTOSchema,
    audience: 'admin',
    signal: options.signal,
    locale: options.locale,
  });
}

/**
 * 改站点统计时区：PATCH /api/admin/settings/analytics，body 为 { timezone, expectedVersion }。
 * 版本 CAS 由服务端执行；这里不重试、不自动改 expectedVersion——409 由页面读取最新后由用户再提交。
 */
export function patchAnalyticsSettings(
  input: { timezone: string; expectedVersion: number },
  options: RequestOptions = {},
): Promise<AnalyticsSettingsUpdateResult> {
  return requestApi({
    path: '/api/admin/settings/analytics',
    method: 'PATCH',
    body: { timezone: input.timezone, expectedVersion: input.expectedVersion },
    schema: AnalyticsSettingsUpdateDTOSchema,
    audience: 'admin',
    signal: options.signal,
    locale: options.locale,
  });
}

/** 构造只读统计查询路径：仅序列化受控参数，sources 合并为单个逗号分隔项。 */
export function buildStatsApiPath(query: StatsQueryDTO = {}): string {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.productSlug) params.set('productSlug', query.productSlug);
  if (query.timezoneRevision !== undefined) params.set('timezoneRevision', String(query.timezoneRevision));
  if (query.sources && query.sources.length > 0) params.set('sources', query.sources.join(','));
  const qs = params.toString();
  return qs ? `/api/admin/stats?${qs}` : '/api/admin/stats';
}

/**
 * 读看板统计：GET /api/admin/stats（M6-T4）。
 * 服务端在查询前按当前后台会话角色裁剪来源，显式越权返回 403；手动刷新仅触发此只读 GET。
 */
export function getStats(query: StatsQueryDTO = {}, options: RequestOptions = {}): Promise<StatsResult> {
  return requestApi({
    path: buildStatsApiPath(query),
    method: 'GET',
    schema: StatsDTOSchema,
    audience: 'admin',
    signal: options.signal,
    locale: options.locale,
  });
}
