/**
 * #347 一次性绑定链接面板的离开提醒（UX v1.0.6）：面板显示中、还没点「我已复制」时才装上，点了就卸掉。
 * - 刷新 / 关闭 / 地址栏跳转：原生 beforeunload（浏览器自己的提示文案）。
 * - 后台内跳转（侧栏 next/link 和任何站内 <a href>）：document 捕获阶段拦下点击（在 React / next/link 的处理之前），
 *   交给 onIntercept 弹确认框；确认后 proceed()：先卸掉监听，再重新点一次原链接，让 next/link 照常客户端跳转。
 * 不读、不保存、不记录绑定链接本身；只看被点的 <a> 的 href。
 */
export type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
type AnchorLike = { href: string; target?: string; hasAttribute: (n: string) => boolean; click: () => void };
type ClickLike = {
  defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean;
  target: unknown; preventDefault: () => void; stopPropagation: () => void;
};

/** 被点的元素往上找 <a href>；没有 closest（文本节点等）时用 parentElement */
function anchorOf(t: unknown): AnchorLike | null {
  const el = t as { closest?: (s: string) => unknown; parentElement?: unknown } | null;
  if (!el) return null;
  if (typeof el.closest === 'function') return (el.closest('a[href]') as AnchorLike | null) ?? null;
  return el.parentElement ? anchorOf(el.parentElement) : null;
}

/** 站内跳转才拦：同源、同窗口、不是下载、不是只改 hash；外站链接是整页跳转，交给 beforeunload */
export function isInSiteNavigation(e: ClickLike, here: string): AnchorLike | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = anchorOf(e.target);
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
  let to: URL, from: URL;
  try { to = new URL(a.href, here); from = new URL(here); } catch { return null; }
  if (to.origin !== from.origin) return null;
  if (to.pathname === from.pathname && to.search === from.search) return null;
  return a;
}

export function installLeaveGuard(o: {
  win: EventTargetLike; doc: EventTargetLike; here: () => string; message: string;
  onIntercept: (proceed: () => void) => void;
}): () => void {
  let on = true;
  const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = o.message; return o.message; };
  const click = (e: MouseEvent) => {
    const a = isInSiteNavigation(e as unknown as ClickLike, o.here());
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    o.onIntercept(() => { uninstall(); a.click(); });
  };
  const uninstall = () => {
    if (!on) return;
    on = false;
    o.win.removeEventListener('beforeunload', beforeUnload as EventListener);
    o.doc.removeEventListener('click', click as EventListener, true);
  };
  o.win.addEventListener('beforeunload', beforeUnload as EventListener);
  o.doc.addEventListener('click', click as EventListener, true);
  return uninstall;
}
