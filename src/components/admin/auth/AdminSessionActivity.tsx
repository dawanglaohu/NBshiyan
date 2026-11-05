'use client';

import { useEffect, useRef } from 'react';
import { postSessionActivity } from '@/lib/client/account';
import { adminLoginHref } from '@/lib/admin/safe-callback';

/** 与服务端 session.activityThrottleMs 相同：15 分钟内只上报一次。 */
export const ADMIN_ACTIVITY_THROTTLE_MS = 15 * 60 * 1000;

type ReportResult = { ok: true } | { ok: false; action?: string; status?: number };

/**
 * 纯逻辑：只在真实操作后上报一次活动，15 分钟至多一次、同一时刻只有一个在途。
 *
 * - 隐藏页 / 失焦页（isVisible() / hasFocus()）一律丢弃，不发 activity。
 * - 首次渲染、定时器、轮询、无参 session 读取都不调用 report()；调用方只在
 *   pointerdown / keydown / submit / 路由变化时才调。
 * - 401（撤销、禁用、凭证版本变化）不重试：触发 onUnauthorized 让壳清内容，
 *   abort 在途并停止后续上报，避免撤销后还拿旧 cookie 打接口（E-03 / E-68 / E-70）。
 * - 503 / 网络错误 / 超时静默结束，节流仍按本次发起时间生效，不补发。
 */
export function createAdminActivityReporter(deps: {
  send: (signal: AbortSignal) => Promise<ReportResult>;
  onUnauthorized: () => void;
  assign: (url: string) => void;
  path: () => string;
  now: () => number;
  isVisible: () => boolean;
  hasFocus: () => boolean;
  throttleMs?: number;
}) {
  const throttleMs = deps.throttleMs ?? ADMIN_ACTIVITY_THROTTLE_MS;
  let inFlight: AbortController | null = null;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let stopped = false;

  const stop = () => {
    stopped = true;
    inFlight?.abort();
    inFlight = null;
  };
  const report = (): void => {
    if (stopped || inFlight) return;
    if (!deps.isVisible() || !deps.hasFocus()) return;
    const now = deps.now();
    if (now - lastStartedAt < throttleMs) return;
    const controller = new AbortController();
    inFlight = controller;
    lastStartedAt = now;
    void deps.send(controller.signal).then((result) => {
      if (inFlight === controller) inFlight = null;
      if (result.ok) return;
      if (result.action === 'login' || result.status === 401) {
        stop();
        deps.onUnauthorized();
        deps.assign(adminLoginHref(deps.path()));
      }
    }).catch(() => {
      if (inFlight === controller) inFlight = null;
    });
  };
  return { report, stop, dispose: stop };
}

type Reporter = ReturnType<typeof createAdminActivityReporter>;
let singleton: Reporter | null = null;
let unauthorizedHandler: (() => void) | null = null;

/**
 * 浏览器里共用一个节流状态。AdminShell 的三个真实事件监听与路由 effect 都调它，
 * 因此不会出现两套上报互相踩 id 的情况。只在客户端效果里调用。
 */
export function reportAdminActivity(): void {
  singleton ??= createAdminActivityReporter({
    send: async (signal) => {
      const result = await postSessionActivity({ signal });
      return result.ok ? { ok: true } : { ok: false, action: result.action, status: result.status };
    },
    onUnauthorized: () => unauthorizedHandler?.(),
    assign: (url) => window.location.assign(url),
    path: () => window.location.pathname + window.location.search,
    now: () => Date.now(),
    isVisible: () => typeof document !== 'undefined' && document.visibilityState === 'visible',
    hasFocus: () => typeof document === 'undefined' || document.hasFocus(),
  });
  singleton.report();
}

/** 供测试或壳重置用：丢弃单例与其节流状态。 */
export function resetAdminActivityReporter(): void {
  singleton?.dispose();
  singleton = null;
  unauthorizedHandler = null;
}

/**
 * 壳内挂载点：不注册 DOM 监听（那三个监听留在 AdminShell 里，只上报一次），
 * 只负责把「401 清内容」的回调接进单例，并处理失焦 / 卸载的取消语义。
 *
 * 失焦：window blur 时 stop() 丢弃在途并暂停上报；恢复焦点不自动补发，
 * 下一次真实操作才重新进入节流判定（重建单例清掉 stopped 标记）。
 * 卸载：cleanup 摘除监听并 dispose 单例。
 * 隐藏页不发已由 reporter 的 isVisible() 在分发时判定，无需监听 visibilitychange。
 */
export default function AdminSessionActivity({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const handlerRef = useRef(onUnauthorized);
  handlerRef.current = onUnauthorized;
  useEffect(() => {
    unauthorizedHandler = () => handlerRef.current?.();
    const onBlur = () => singleton?.stop();
    const onFocus = () => {
      singleton?.dispose();
      singleton = null;
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      unauthorizedHandler = null;
      singleton?.dispose();
      singleton = null;
    };
  }, []);
  return null;
}
