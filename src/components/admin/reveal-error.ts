'use client';
import { flushSync } from 'react-dom';

/** 错误条提交进 DOM 后再滚到视野中间并聚焦。同一句文案再失败一次也会再滚一次。 */
export function commitAndReveal(ref: { current: HTMLElement | null }, commit: () => void): void {
  flushSync(commit);
  const el = ref.current;
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
}
