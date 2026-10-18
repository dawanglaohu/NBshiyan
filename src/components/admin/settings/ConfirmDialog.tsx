'use client';
import { useEffect, useRef } from 'react';
import { SETTINGS_TEXT as T } from '@/lib/admin/site-settings';

/** 站点设置共用的确认框（role=alertdialog，Esc / 取消退出，打开时焦点在「取消」）。about 和组织信息共用，原来在 AboutSettings.tsx 里 */
export default function ConfirmDialog({ title, children, confirmLabel, danger, onCancel, onConfirm }: { title: string; children: React.ReactNode; confirmLabel: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('keydown', k); prev?.focus(); };
  }, [onCancel]);
  return (
    <div className="st-mask">
      <div className="st-dialog" role="alertdialog" aria-modal="true" aria-labelledby="st-dlg-h" aria-describedby="st-dlg-b">
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
