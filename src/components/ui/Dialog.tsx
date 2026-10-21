'use client';

import React, { forwardRef, useEffect, useId, useImperativeHandle, useRef } from 'react';
import type { DialogHTMLAttributes, ReactNode } from 'react';
import { activateDialog } from './dialog-focus';

export type DialogProps = Omit<DialogHTMLAttributes<HTMLDialogElement>, 'open' | 'title' | 'onClose' | 'onCancel'> & {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  closeLabel: string;
  onClose: () => void;
};

/** Controlled modal; onClose requests cancellation without claiming server work was undone. */
export const Dialog = forwardRef<HTMLDialogElement, DialogProps>(function Dialog({
  open, title, description, closeLabel, onClose, children, className, 'aria-describedby': describedBy, ...props
}, ref) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useImperativeHandle(ref, () => dialogRef.current!, []);
  useEffect(() => {
    if (!open || !dialogRef.current || !titleRef.current) return;
    return activateDialog(dialogRef.current, titleRef.current, () => closeRef.current());
  }, [open]);

  return (
    <dialog {...props} ref={dialogRef} className={['pj-dialog', className].filter(Boolean).join(' ')}
      aria-labelledby={`${id}-title`} aria-describedby={[describedBy, description ? `${id}-description` : null].filter(Boolean).join(' ') || undefined}>
      <h2 className="pj-dialog-title" ref={titleRef} id={`${id}-title`} tabIndex={-1}>{title}</h2>
      {description && <p id={`${id}-description`}>{description}</p>}
      {children}
      <button type="button" className="pj-button pj-dialog-close" data-variant="secondary" onClick={onClose}>{closeLabel}</button>
    </dialog>
  );
});
