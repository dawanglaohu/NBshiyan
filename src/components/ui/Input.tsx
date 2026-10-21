'use client';

import React, { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type FieldProps = {
  label: ReactNode;
  description?: string;
  error?: string;
  disabledReason?: string;
  context?: 'admin' | 'public';
};

export type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldProps;
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps;
export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & FieldProps;

function useField({ id, description, error, disabledReason, disabled, describedBy }: {
  id?: string; description?: string; error?: string; disabledReason?: string; disabled?: boolean; describedBy?: string;
}) {
  const generatedId = useId();
  const controlId = id || generatedId;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const reasonId = `${controlId}-reason`;
  return {
    controlId, descriptionId, errorId, reasonId,
    describedBy: [describedBy, description ? descriptionId : undefined, error ? errorId : undefined, disabled && disabledReason ? reasonId : undefined].filter(Boolean).join(' ') || undefined,
  };
}

function Field({ label, context = 'admin', description, error, disabledReason, disabled, field, children }: FieldProps & {
  disabled?: boolean;
  field: ReturnType<typeof useField>;
  children: ReactNode;
}) {
  return (
    <div className="pj-field" data-context={context}>
      <label className="pj-label" htmlFor={field.controlId}>{label}</label>
      {children}
      <div className="pj-feedback">
        {description && <span id={field.descriptionId}>{description}</span>}
        {error && <span id={field.errorId} className="pj-field-error">{error}</span>}
        {disabled && disabledReason && <span id={field.reasonId}>{disabledReason}</span>}
      </div>
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  label, description, error, disabledReason, context = 'admin', disabled, id, className,
  'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, ...props
}, ref) {
  const field = useField({ id, description, error, disabledReason, disabled, describedBy });
  return (
    <Field {...{ label, description, error, disabledReason, context, disabled, field }}>
      <input {...props} ref={ref} id={field.controlId} className={['pj-input', className].filter(Boolean).join(' ')} data-context={context} disabled={disabled} aria-describedby={field.describedBy} aria-invalid={error ? true : ariaInvalid} />
    </Field>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({
  label, description, error, disabledReason, context = 'admin', disabled, id, className, rows = 3,
  'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, ...props
}, ref) {
  const field = useField({ id, description, error, disabledReason, disabled, describedBy });
  return (
    <Field {...{ label, description, error, disabledReason, context, disabled, field }}>
      <textarea {...props} ref={ref} id={field.controlId} rows={Math.max(3, rows)} className={['pj-input', className].filter(Boolean).join(' ')} data-context={context} disabled={disabled} aria-describedby={field.describedBy} aria-invalid={error ? true : ariaInvalid} />
    </Field>
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({
  label, description, error, disabledReason, context = 'admin', disabled, id, className,
  'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, ...props
}, ref) {
  const field = useField({ id, description, error, disabledReason, disabled, describedBy });
  return (
    <Field {...{ label, description, error, disabledReason, context, disabled, field }}>
      <select {...props} ref={ref} id={field.controlId} className={['pj-input', className].filter(Boolean).join(' ')} data-context={context} disabled={disabled} aria-describedby={field.describedBy} aria-invalid={error ? true : ariaInvalid} />
    </Field>
  );
});
