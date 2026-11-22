import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx.ts';
import { Kbd } from './Kbd.tsx';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = ink-filled (one per view), secondary = hairline, ghost = text only. */
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  /** Keyboard shortcut hint shown inside the button, e.g. "⌘↵". */
  shortcut?: string;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', shortcut, icon, className, children, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={cx('sf-btn', className)} data-variant={variant} data-size={size} {...rest}>
      {icon}
      {children}
      {shortcut ? <Kbd aria-hidden>{shortcut}</Kbd> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Required accessible name; also shown as the native tooltip. */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, type = 'button', ...rest }, ref) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cx('sf-btn', 'sf-icon-btn', className)} data-variant={variant} data-size={size} {...rest}>
      {children}
    </button>
  );
});
