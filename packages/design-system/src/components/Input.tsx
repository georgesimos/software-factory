import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cx } from './cx.ts';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Leading icon, e.g. a search glyph. Decorative. */
  icon?: ReactNode;
}

/** Text input. Give it a visible <label> or an aria-label. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, icon, className, ...rest }, ref) {
  const input = <input ref={ref} className={cx('sf-input', !icon && className)} aria-invalid={invalid || undefined} {...rest} />;
  if (!icon) return input;
  return <span className={cx('sf-input-wrap', className)}><span className="sf-input-icon" aria-hidden="true">{icon}</span>{input}</span>;
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> { invalid?: boolean }

/** Native <select>, styled: keeps the platform's keyboard and screen-reader behaviour. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, className, ...rest }, ref) {
  return <select ref={ref} className={cx('sf-input', 'sf-select', className)} aria-invalid={invalid || undefined} {...rest} />;
});
