import { FOCUSABLE_SELECTOR, nextTrapFocus } from '../../lib/admin/focus-trap';

/** Opens a native modal. Dispose on close or unmount to restore its connected opener. */
export function activateDialog(dialog: HTMLDialogElement, initial: HTMLElement, requestClose: () => void): () => void {
  const doc = dialog.ownerDocument;
  const opener = doc.activeElement as HTMLElement | null;
  // summary is an implicit native tab stop; a single query preserves DOM order.
  const available = () => [...dialog.querySelectorAll<HTMLElement>(`${FOCUSABLE_SELECTOR},summary`)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert], [hidden], [aria-hidden="true"]') && !el.matches(':disabled'),
  );
  let disposed = false;
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = available();
    const target = nextTrapFocus(items, doc.activeElement as HTMLElement | null, event.shiftKey);
    if (target || !items.length) {
      event.preventDefault();
      (target ?? initial).focus({ preventScroll: true });
    }
  };
  const focusin = (event: FocusEvent) => {
    if (!dialog.contains(event.target as Node)) initial.focus({ preventScroll: true });
  };
  const cancel = (event: Event) => { event.preventDefault(); requestClose(); };
  // Native close events are queued; a previous disposal can deliver one after reopening.
  const closed = () => { if (!dialog.open) requestClose(); };
  dialog.showModal();
  initial.focus({ preventScroll: true });
  doc.addEventListener('keydown', keydown);
  doc.addEventListener('focusin', focusin);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', closed);
  return () => {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener('keydown', keydown);
    doc.removeEventListener('focusin', focusin);
    dialog.removeEventListener('cancel', cancel);
    dialog.removeEventListener('close', closed);
    if (dialog.open) dialog.close();
    if (opener?.isConnected && !opener.closest('[inert], [hidden]') && !opener.matches(':disabled') && opener.getClientRects().length) {
      opener.focus({ preventScroll: true });
    }
  };
}
