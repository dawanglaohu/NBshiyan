// #74：进入后台时问一次服务端邮件开关（GET /api/admin/mail/config，#315 §15 补充）。
// 404 = 开关关闭（mailSwitchGate）：一开始就隐藏所有发信入口，不等发信失败才发现。
import type { MailConfig } from './types';

export type MailGate = { state: 'loading' } | { state: 'off' } | { state: 'on'; sendingEnabled: boolean };
export const MAIL_CONFIG_PATH = '/api/admin/mail/config';
export const MAIL_OFF_TEXT = '邮件功能未开启';

/**
 * 状态码 + 响应体 → 开关状态（纯函数）。
 * - 404 → off
 * - 200 { sendingEnabled: boolean } → on
 * - 其他（401 / 5xx / 网络错误 / 响应体不对）→ on + sendingEnabled:true：不在前端提前隐藏，真正发信时由服务端判定（409 sending_disabled 等）
 */
export function mailGateFrom(status: number, body: unknown): MailGate {
  if (status === 404) return { state: 'off' };
  const b = body as Partial<MailConfig> | null;
  if (status === 200 && b && typeof b.sendingEnabled === 'boolean') return { state: 'on', sendingEnabled: b.sendingEnabled };
  return { state: 'on', sendingEnabled: true };
}

export async function fetchMailGate(fetchFn: (url: string, init?: RequestInit) => Promise<{ status: number; json(): Promise<unknown> }> = fetch): Promise<MailGate> {
  try {
    const res = await fetchFn(MAIL_CONFIG_PATH, { credentials: 'same-origin', cache: 'no-store' });
    return mailGateFrom(res.status, res.status === 200 ? await res.json().catch(() => null) : null);
  } catch {
    return mailGateFrom(0, null);
  }
}

/** 发信入口是否显示：只有确认开关打开才显示（加载中也不显示，避免先出现再消失） */
export const showSendEntry = (g: MailGate) => g.state === 'on';
