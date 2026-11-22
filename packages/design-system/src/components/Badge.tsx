import type { HTMLAttributes } from 'react';
import type { Tone } from '../tokens.ts';
import { cx } from './cx.ts';
import { Dot } from './Dot.tsx';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Leading status dot in the tone's colour. */
  dot?: boolean;
  live?: boolean;
  /** Dashed and muted: for metadata that is not a state (Tracked, Archived, 3 runs). */
  quiet?: boolean;
}

/** Small mono pill. Colour is never the only signal: the text always names the state. */
export function Badge({ tone = 'neutral', dot, live, quiet, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('sf-badge', className)} data-tone={tone} data-quiet={quiet || undefined} {...rest}>
      {dot ? <Dot tone={tone} live={live} /> : null}
      {children}
    </span>
  );
}
