/**
 * 模态框的焦点循环（UX #379 P2：共用 ConfirmDialog 按两次 Tab 会跳到遮罩后面的页面）。
 * 纯函数，方便单测：给出框内可聚焦元素（按 DOM 顺序）、当前焦点、是否 Shift，返回要手动聚焦的元素；
 * 返回 null 表示交给浏览器默认的 Tab 顺序（焦点还在框内中间位置时）。
 * - Tab 在最后一个 → 第一个；Shift+Tab 在第一个 → 最后一个
 * - 焦点不在框内（例如被点到了框外）→ Tab 去第一个，Shift+Tab 去最后一个
 */
export function nextTrapFocus<T>(items: readonly T[], active: T | null, shift: boolean): T | null {
  if (!items.length) return null;
  const i = active === null ? -1 : items.indexOf(active);
  if (shift) return i <= 0 ? items[items.length - 1] : null;
  return i === -1 || i === items.length - 1 ? items[0] : null;
}

/** 框内能用 Tab 到达的元素（不含禁用、tabindex=-1、隐藏的） */
export const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => el.tabIndex >= 0 && !el.hasAttribute('inert') && el.getClientRects().length > 0);
}
