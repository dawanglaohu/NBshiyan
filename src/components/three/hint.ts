/**
 * 卡片角标文案（#172 第 3、10 点）。
 * - 3D 还没开始加载（未交互的延迟加载期，或卡片不在视口）时不显示“加载中”：那时什么都没在加载，
 *   之前这里一直显示“加载中”，看起来像卡死；
 * - 只有画布已挂载、卡片在视口、模型还没就绪时才显示“加载中”；
 * - 就绪后按指针类型选文案：触屏（pointer: coarse / hover: none）显示“点击旋转”，鼠标显示“拖动旋转”。
 */
export type HintState = { failed: boolean; started: boolean; ready: boolean; interacting: boolean; coarse: boolean };
export type HintLabels = { tap: string; drag: string; loading: string };
export function hintText(s: HintState, l: HintLabels): string | null {
  if (s.failed) return null;
  if (s.ready) return s.interacting ? '↻' : s.coarse ? l.tap : l.drag;
  return s.started ? l.loading : null;
}
/** 触屏判断：只要是粗指针或不支持悬停，就按触屏文案 */
export const COARSE_QUERY = '(pointer: coarse), (hover: none)';
