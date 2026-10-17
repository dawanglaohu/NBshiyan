// #307 焦点管理：纯逻辑（可单测），组件只负责接线

type Focusable = { focus: (opts?: FocusOptions) => void };
type MainEl = Focusable & { hasAttribute: (n: string) => boolean; setAttribute: (n: string, v: string) => void };

export type ConsentCloseSource = 'banner' | 'dialog';
export type ConsentFocusLookup = {
  /** 打开设置面板的按钮（已不在文档里或不可见时传 null） */
  opener: Focusable | null;
  main: () => MainEl | null;
  bannerSettings: () => Focusable | null;
  footerLink: () => Focusable | null;
};

/**
 * Cookie 同意关闭后把焦点放到哪里。
 * - 从横幅上点接受/拒绝：横幅已卸载，不能再落到页脚的「Cookie settings」（会把页面滚到底，#307）。
 *   改成把焦点放到 <main>（补 tabindex=-1），并要求 preventScroll，页面不滚动；没有 <main> 时不移动焦点。
 * - 从设置面板关闭：保留原逻辑：先还给打开它的按钮，再找横幅上的「设置」，最后回到页脚链接。
 */
export function consentFocusTarget(source: ConsentCloseSource, q: ConsentFocusLookup): { el: Focusable | null; preventScroll: boolean } {
  if (source === 'banner') {
    const main = q.main();
    if (main && !main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    return { el: main, preventScroll: true };
  }
  return { el: q.opener ?? q.bannerSettings() ?? q.footerLink(), preventScroll: false };
}

export type ConsentCloseAction = 'banner-choice' | 'dialog-save' | 'dialog-close';

/**
 * 关闭同意界面时按哪条规则还原焦点（#307 P2）。
 * - 横幅上直接接受/拒绝 → 'banner'（焦点到 <main>，不滚动）。
 * - 首访从横幅打开设置面板再「保存」：保存后横幅和打开面板的按钮都没了 → 同样 'banner'，不再落到页脚链接把页面滚到底。
 * - 从横幅打开再关闭（✕ / Esc / 点遮罩）：还没做选择，横幅会重新出现 → 'dialog'，焦点回到横幅上的「设置」。
 * - 从页脚「Cookie settings」或提示条打开：一律 'dialog'，焦点还给打开它的按钮。
 */
export function consentCloseSource(action: ConsentCloseAction, openedFromBanner: boolean): ConsentCloseSource {
  if (action === 'banner-choice') return 'banner';
  if (action === 'dialog-save' && openedFromBanner) return 'banner';
  return 'dialog';
}

/** 开了「减少动态效果」时不平滑滚动 */
export function scrollBehaviorFor(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}

type Revealable = Focusable & { scrollIntoView: (opts?: ScrollIntoViewOptions) => void };

/**
 * 把提示滚进可视区并把焦点移过去（#307 询盘成功卡片）。
 * 先 focus({ preventScroll }) 再 scrollIntoView，避免浏览器为聚焦再滚一次；元素需自带 tabIndex=-1。
 */
export function revealAndFocus(el: Revealable | null, reducedMotion: boolean): void {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'start', behavior: scrollBehaviorFor(reducedMotion) });
}

export function prefersReducedMotion(win?: { matchMedia?: (q: string) => { matches: boolean } }): boolean {
  try { return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}
