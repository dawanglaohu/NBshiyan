import React, { type HTMLAttributes, type ReactNode } from 'react';

export type StatusProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role' | 'aria-live' | 'aria-atomic' | 'prefix'> & {
  tone?: 'neutral' | 'loading' | 'empty' | 'warning' | 'error' | 'success';
  prefix: string;
  children: ReactNode;
  urgent?: boolean;
};

export function Status({ tone = 'neutral', prefix, children, urgent = false, className, ...props }: StatusProps) {
  const isAlert = urgent && tone === 'error';
  return (
    <div {...props} className={['pj-status', className].filter(Boolean).join(' ')} data-tone={tone} role={isAlert ? 'alert' : 'status'} aria-live={isAlert ? 'assertive' : 'polite'} aria-atomic="true">
      <span className="pj-status-prefix">{prefix}</span>{' '}{children}
    </div>
  );
}
