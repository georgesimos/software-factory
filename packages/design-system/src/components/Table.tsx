import type { TableHTMLAttributes } from 'react';
import { cx } from './cx.ts';

/** Hairline data table. Wraps in a horizontal scroller so wide tables never widen the page. Use <td className="sf-num"> for numbers. */
export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return <div className="sf-table-wrap"><table className={cx('sf-table', className)} {...rest} /></div>;
}
