import type { HTMLAttributes } from 'react';
import { cx } from './cx.ts';

export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={cx('sf-kbd', className)} {...rest} />;
}
