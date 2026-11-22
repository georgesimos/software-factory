import type { HTMLAttributes } from 'react';
import { cx } from './cx.ts';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** ghost = transparent background, for secondary content (tracked runs). */
  variant?: 'solid' | 'ghost';
  padding?: 'sm' | 'md' | 'lg';
}

export function Card({ variant = 'solid', padding = 'md', className, ...rest }: CardProps) {
  return <div className={cx('sf-card', className)} data-variant={variant} data-padding={padding} {...rest} />;
}
