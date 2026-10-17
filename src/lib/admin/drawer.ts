// #291 后台手机版侧栏抽屉：纯逻辑（可单测），AdminShell 只负责接线

/** 抽屉断点：和前台一致，<768px 时侧栏改成抽屉（390 手机） */
export const DRAWER_MQ = '(max-width: 767px)';

export type DrawerKey = { key: string; shiftKey?: boolean };
/**
 * 抽屉打开时的键盘处理：
 * - Esc → 'close'（关闭并把焦点还给菜单按钮）
 * - Tab / Shift+Tab 在第一个、最后一个可聚焦元素上 → 'wrap-first' / 'wrap-last'（焦点循环，不跑出抽屉）
 * - 其他 → null（交给浏览器）
 * index：当前焦点在可聚焦元素里的下标，不在抽屉里时为 -1。
 */
export function drawerKeyAction(e: DrawerKey, index: number, count: number): 'close' | 'wrap-first' | 'wrap-last' | null {
  if (e.key === 'Escape') return 'close';
  if (e.key !== 'Tab' || count === 0) return null;
  if (e.shiftKey && index <= 0) return 'wrap-last';
  if (!e.shiftKey && (index === count - 1 || index === -1)) return 'wrap-first';
  return null;
}

/** 抽屉里可聚焦元素（排除「待开发」的禁用入口） */
export const DRAWER_FOCUSABLE = 'a[href]:not([aria-disabled="true"]), button:not([disabled])';
