import { adminLoginHref } from './safe-callback';

/** 与服务端 session.activityThrottleMs 相同：15 分钟内只上报一次。 */
export const ADMIN_ACTIVITY_THROTTLE_MS = 15 * 60 * 1000;

type FetchLike = (input: string, init: RequestInit) => Promise<{ status: number }>;

/**
 * 后台真实操作的续期上报。同一时间只有一个请求在途。
 * 只有 401 跳登录页并带上当前路径。503 和网络错误静默结束，不重试、不跳转。
 */
export function createActivityReporter(deps: {
  fetch: FetchLike;
  assign: (url: string) => void;
  path: () => string;
  now: () => number;
  throttleMs?: number;
}) {
  const throttleMs = deps.throttleMs ?? ADMIN_ACTIVITY_THROTTLE_MS;
  let inFlight = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  return {
    report(): void {
      const now = deps.now();
      if (inFlight || now - lastStartedAt < throttleMs) return;
      inFlight = true;
      lastStartedAt = now;
      deps.fetch('/api/admin/account/session/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      }).then((response) => {
        if (response.status === 401) deps.assign(adminLoginHref(deps.path()));
      }).catch(() => undefined).finally(() => {
        inFlight = false;
      });
    },
  };
}

let singleton: ReturnType<typeof createActivityReporter> | undefined;

/** 浏览器里共用一个节流状态。只在客户端效果里调用，不在服务端渲染时碰 window。 */
export function reportAdminActivity(): void {
  singleton ??= createActivityReporter({
    fetch: (input, init) => fetch(input, init),
    assign: (url) => window.location.assign(url),
    path: () => window.location.pathname + window.location.search,
    now: () => Date.now(),
  });
  singleton.report();
}
