import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx.ts';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, indeterminate, className, ...rest }, ref) {
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current!);
  useEffect(() => { if (inner.current) inner.current.indeterminate = !!indeterminate; }, [indeterminate]);
  const box = <input ref={inner} type="checkbox" className="sf-checkbox" {...rest} />;
  if (!label) return <span className={cx('sf-check', className)}>{box}</span>;
  return (
    <label className={cx('sf-check', className)}>
      {box}
      <span className="sf-check-text">
        <span className="sf-check-label">{label}</span>
        {description ? <span className="sf-check-desc">{description}</span> : null}
      </span>
    </label>
  );
});
