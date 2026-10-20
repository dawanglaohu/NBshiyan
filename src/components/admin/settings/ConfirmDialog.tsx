'use client';
import { useEffect, useRef } from 'react';
import { SETTINGS_TEXT as T } from '@/lib/admin/site-settings';
import { focusablesIn, nextTrapFocus } from '@/lib/admin/focus-trap';

/**
 * 站点设置共用的确认框（role=alertdialog，Esc / 取消退出，打开时焦点在「取消」，关闭后焦点回到打开它的按钮）。about 和组织信息共用，原来在 AboutSettings.tsx 里。
 * UX #379 P2：焦点锁在框内——Tab / Shift+Tab 在框内循环；焦点被移到框外（点到遮罩外的元素等）时拉回「取消」。
 * 没用原生 <dialog>.showModal()：Chrome 里 Tab 会从最后一个按钮跳到浏览器地址栏，循环行为不一致；这里自己管更可控，也好测。
 * onCancel 用 ref 保存最新值，effect 只在挂载时跑一次：调用方传内联函数（例如 () => step('cancel')）时，重渲染不会把焦点拉回「取消」。
 */
export default function ConfirmDialog({ title, children, confirmLabel, danger, onCancel, onConfirm }: { title: string; children: React.ReactNode; confirmLabel: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dlgRef = useRef<HTMLDivElement>(null);
  const cancelCb = useRef(onCancel);
  useEffect(() => { cancelCb.current = onCancel; }, [onCancel]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelCb.current(); return; }
      const dlg = dlgRef.current;
      if (e.key !== 'Tab' || !dlg) return;
      const active = document.activeElement instanceof HTMLElement && dlg.contains(document.activeElement) ? document.activeElement : null;
      const to = nextTrapFocus(focusablesIn(dlg), active, e.shiftKey);
      if (to) { e.preventDefault(); to.focus(); }
    };
    const fin = (e: FocusEvent) => {
      const dlg = dlgRef.current;
      if (dlg && e.target instanceof Node && !dlg.contains(e.target)) (cancelRef.current ?? dlg).focus();
    };
    document.addEventListener('keydown', k);
    document.addEventListener('focusin', fin);
    return () => { document.removeEventListener('keydown', k); document.removeEventListener('focusin', fin); prev?.focus(); };
  }, []);
  return (
    <div className="st-mask">
      <div ref={dlgRef} className="st-dialog" role="alertdialog" aria-modal="true" aria-labelledby="st-dlg-h" aria-describedby="st-dlg-b">
        <h2 id="st-dlg-h">{title}</h2>
        <div id="st-dlg-b">{children}</div>
        <div className="st-dlg-btns">
          <button ref={cancelRef} type="button" className="adm-btn" onClick={onCancel}>{T.cancel}</button>
          <button type="button" className={`adm-btn primary${danger ? ' danger' : ''}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
