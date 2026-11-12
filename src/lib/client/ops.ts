'use client';

import { requestApi, type ClientApiResult } from './api';
import {
  AnalyticsSettingsDTOSchema,
  AnalyticsSettingsUpdateDTOSchema,
  type AnalyticsSettingsDTO,
  type AnalyticsSettingsUpdateDTO,
} from '@/lib/contracts/analytics';

/**
 * 后台统计设置（M5-T10）的客户端请求入口。
 *
 * 与 account.ts 同一约定：只在这里追加方法，不重造 fetch/重试/错误适配；`requestApi`
 * 负责同源、截止时间、错误信封与 401 的 admin 语义。M6 的 stats 查询在后续任务里
 * 追加到本文件，互不覆盖。
 */

export type AnalyticsSettingsResult = ClientApiResult<AnalyticsSettingsDTO>;
export type AnalyticsSettingsUpdateResult = ClientApiResult<AnalyticsSettingsUpdateDTO>;

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
