// 8.3a 发送状态轮询：每 pollAfterMs（默认 5000）查一次；SENT / FAILED 停；从首次 202 起满 2 分钟停（「状态未确认」）。
// 页面隐藏时暂停，回到前台立即查一次（不重置 2 分钟）。不依赖 React，时钟 / 定时器 / 可见性可注入，便于测试。
import type { SendStatus } from './types';
import { DEFAULT_POLL_MS, POLL_MAX_MS } from './logic';
import { MailError } from './types';

export type PollEvent =
  | { type: 'update'; status: SendStatus }
  | { type: 'done'; status: SendStatus }
  | { type: 'timeout' }
  | { type: 'error'; error: MailError };

export type PollDeps = {
  fetchStatus: () => Promise<SendStatus>;
  onEvent: (e: PollEvent) => void;
  pollAfterMs?: number; maxMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void;
  isHidden?: () => boolean;
  /** 订阅可见性变化，返回取消订阅 */
  onVisibility?: (fn: () => void) => () => void;
};

export function startSendPoll(d: PollDeps): () => void {
  const now = d.now ?? Date.now;
  const set = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const hidden = d.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const every = d.pollAfterMs && d.pollAfterMs > 0 ? d.pollAfterMs : DEFAULT_POLL_MS;
  const deadline = now() + (d.maxMs ?? POLL_MAX_MS);
  let timer: unknown; let unsub: (() => void) | undefined = undefined; let stopped = false; let inflight = false; let pausedWhileHidden = false;

  const stop = () => { stopped = true; if (timer !== undefined) clear(timer); timer = undefined; unsub?.(); };
  const schedule = () => {
    if (stopped) return;
    const left = deadline - now();
    if (left <= 0) { d.onEvent({ type: 'timeout' }); stop(); return; }
    timer = set(tick, Math.min(every, left));
  };
  async function tick() {
    timer = undefined;
    if (stopped) return;
    if (now() >= deadline) { d.onEvent({ type: 'timeout' }); stop(); return; }
    if (hidden()) { pausedWhileHidden = true; return; } // 暂停：等可见性回调
    inflight = true;
    try {
      const s = await d.fetchStatus();
      if (stopped) return;
      if (s.status === 'SENT' || s.status === 'FAILED') { d.onEvent({ type: 'done', status: s }); stop(); return; }
      d.onEvent({ type: 'update', status: s });
    } catch (e) {
      if (stopped) return;
      const err = e instanceof MailError ? e : new MailError('unknown', 0);
      // 404 / 409 anonymized 等确定性错误：停止；网络抖动：继续到期限
      if (err.status === 404 || err.status === 409 || err.status === 401) { d.onEvent({ type: 'error', error: err }); stop(); return; }
    } finally { inflight = false; }
    schedule();
  }
  unsub = d.onVisibility?.(() => {
    if (stopped || hidden() || !pausedWhileHidden || inflight) return;
    pausedWhileHidden = false; void tick();
  });
  schedule();
  return stop;
}

/** 浏览器里的可见性订阅 */
export const browserVisibility = (fn: () => void) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn); };
