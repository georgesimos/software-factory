import type { CSSProperties } from 'react';
import type { Tone } from '../tokens.ts';
import { cx } from './cx.ts';

/** 6px status dot. `live` pulses (respecting reduced motion). Decorative: pair it with text. */
export function Dot({ tone = 'idle', live, className }: { tone?: Tone; live?: boolean; className?: string }) {
  return <span className={cx('sf-dot', className)} data-live={live || undefined} style={{ '--sf-dot': `var(--sf-tone-${tone})` } as CSSProperties} aria-hidden="true" />;
}
