// #104 首屏视频：纯逻辑（可单测），组件只负责接线
export const HERO_SEEN_KEY = 'pj-hero-115-seen';

export type HeroEnv = {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  reducedMotion?: boolean;
  saveData?: boolean;
};

/** 只有首次访问、未开减少动效、未开省流量时才自动播放；其余情况只显示封面图 */
export function shouldAutoplay(env: HeroEnv): boolean {
  if (env.reducedMotion || env.saveData) return false;
  try {
    if (!env.storage) return false; // 读不到存储时保守：只显示封面
    return env.storage.getItem(HERO_SEEN_KEY) !== '1';
  } catch {
    return false;
  }
}

/** 一开始播放就记为已看过，下次访问只显示封面 */
export function markSeen(storage: HeroEnv['storage']): void {
  try { storage?.setItem(HERO_SEEN_KEY, '1'); } catch { /* 隐私模式等：忽略 */ }
}

export type HeroState = 'poster' | 'playing' | 'paused';
export type HeroEvent = 'play' | 'pause' | 'skip' | 'ended' | 'error';

/** 状态机：暂停可恢复；跳过/播完/出错都回到封面，不循环 */
export function heroReducer(state: HeroState, ev: HeroEvent): HeroState {
  if (ev === 'play') return 'playing';
  if (ev === 'pause') return state === 'playing' ? 'paused' : state;
  return 'poster';
}

/** 页面空闲后再加载视频，不拖慢首屏/LCP */
export function whenIdle(win: {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  setTimeout: (cb: () => void, ms: number) => unknown;
  document: { readyState: string };
  addEventListener: (t: string, cb: () => void, o?: { once: boolean }) => void;
}, cb: () => void): void {
  const idle = () => (win.requestIdleCallback ? win.requestIdleCallback(cb, { timeout: 3000 }) : win.setTimeout(cb, 200));
  if (win.document.readyState === 'complete') idle();
  else win.addEventListener('load', idle, { once: true });
}

export function readEnv(): HeroEnv {
  const w = window as Window & { navigator: Navigator & { connection?: { saveData?: boolean } } };
  let storage: Storage | null = null;
  try { storage = w.localStorage; } catch { storage = null; }
  return {
    storage,
    reducedMotion: w.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    saveData: w.navigator.connection?.saveData === true,
  };
}
