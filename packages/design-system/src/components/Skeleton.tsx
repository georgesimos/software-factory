import type { CSSProperties } from 'react';
import { cx } from './cx.ts';

/** Loading placeholder. Decorative: mark the loading region with aria-busy and give it a text status. */
export function Skeleton({ width, height = 12, className, style }: { width?: CSSProperties['width']; height?: CSSProperties['height']; className?: string; style?: CSSProperties }) {
  return <span className={cx('sf-skeleton', className)} style={{ width, height, ...style }} aria-hidden="true" />;
}
