import type { AnalyticsSettingsResult } from '@/lib/client/ops';
import type { AnalyticsSettingsDTO } from '@/lib/contracts/analytics';

export type AnalyticsSettingsNotice = { kind: 'ok' | 'err'; text: string } | null;

export type AnalyticsSettingsLoadTransition = {
  saved: AnalyticsSettingsDTO | null;
  timezone: string | null;
  loadErr: string | null;
};

export type AnalyticsSettingsReloadTransition = {
  saved: AnalyticsSettingsDTO | null;
  timezone: string | null;
  conflict: boolean;
  loadErr: string | null;
  notice: AnalyticsSettingsNotice;
};

/** 首次 GET /api/admin/settings/analytics 的状态转移；401 不静默留在加载中。 */
export function applyInitialAnalyticsLoad(result: AnalyticsSettingsResult): AnalyticsSettingsLoadTransition {
  if (result.ok) {
    return { saved: result.data, timezone: result.data.timezone, loadErr: null };
  }
  if (result.action === 'login') {
    return { saved: null, timezone: null, loadErr: result.text || '登录会话已失效，请重新登录。' };
  }
  return { saved: null, timezone: null, loadErr: result.text || '读取站点时区失败。' };
}

/**
 * 显式重读：
 * - 首次加载失败后的重试（currentSaved === null）：成功时同步填入服务端 timezone、清 loadErr；失败时更新 loadErr。
 * - 409 冲突后的读取最新（currentSaved !== null）：保留用户当前输入（timezone: null 表示不覆写输入框），更新 saved 与提示。
 */
export function applyAnalyticsReload(
  currentSaved: AnalyticsSettingsDTO | null,
  result: AnalyticsSettingsResult,
): AnalyticsSettingsReloadTransition {
  if (currentSaved === null) {
    if (result.ok) {
      return {
        saved: result.data,
        timezone: result.data.timezone,
        conflict: false,
        loadErr: null,
        notice: null,
      };
    }
    const text = result.action === 'login'
      ? (result.text || '登录会话已失效，请重新登录。')
      : (result.text || '读取站点时区失败。');
    return { saved: null, timezone: null, conflict: false, loadErr: text, notice: null };
  }
  if (result.ok) {
    return {
      saved: result.data,
      timezone: null,
      conflict: false,
      loadErr: null,
      notice: { kind: 'ok', text: `已读取最新配置（version ${result.data.version}）；你的输入保留。` },
    };
  }
  return {
    saved: currentSaved,
    timezone: null,
    conflict: true,
    loadErr: null,
    notice: { kind: 'err', text: result.text || '读取最新配置失败。' },
  };
}
