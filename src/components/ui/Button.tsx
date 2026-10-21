'use client';

import React, { Children, forwardRef, isValidElement, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';

type BusyProps = { busy?: false; busyLabel?: string } | { busy: boolean; busyLabel: string };

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-busy'> & BusyProps & {
  variant?: 'primary' | 'secondary';
  context?: 'admin' | 'public';
  disabledReason?: string;
};

function hasContent(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (typeof child === 'string') return child.trim().length > 0;
    if (typeof child === 'number') return true;
    if (!isValidElement<{ children?: ReactNode; 'aria-label'?: string; 'aria-hidden'?: boolean | 'true' | 'false'; alt?: string; hidden?: boolean }>(child)) return false;
    if (child.props.hidden || child.props['aria-hidden'] === true || child.props['aria-hidden'] === 'true') return false;
    // Custom components own their rendered label; inspecting their props cannot establish emptiness.
    if (typeof child.type !== 'string' && child.type !== React.Fragment) return true;
    return Boolean(child.props['aria-label']?.trim() || child.props.alt?.trim()) || hasContent(child.props.children);
  });
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children, variant = 'primary', context = 'admin', busy = false, busyLabel,
  disabled = false, disabledReason, type = 'button', className, 'aria-describedby': describedBy,
  ...props
}, ref) {
  const feedbackId = useId();
  const busyId = `${feedbackId}-busy`;
  const reasonId = `${feedbackId}-reason`;
  const descriptionIds = [describedBy, busy && busyLabel ? busyId : undefined, disabled && disabledReason ? reasonId : undefined].filter(Boolean).join(' ') || undefined;
  const hasName = props['aria-label']?.trim() || props['aria-labelledby']?.trim() || hasContent(children);

  if (!hasName) return null;

  return (
    <span className="pj-button-field" data-busy={busy || undefined}>
      <button
        {...props}
        ref={ref}
        type={type}
        className={['pj-button', className].filter(Boolean).join(' ')}
        data-variant={variant}
        data-context={context}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        aria-describedby={descriptionIds}
      >
        <span className="pj-control-content">{children}</span>
      </button>
      {busyLabel && <span id={busyId} className="pj-feedback pj-busy-label" aria-hidden={!busy}>{busyLabel}</span>}
      {disabled && disabledReason && <span id={reasonId} className="pj-feedback">{disabledReason}</span>}
    </span>
  );
});
