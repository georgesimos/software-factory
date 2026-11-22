import type { ReactNode } from 'react';
import { cx } from './cx.ts';

export interface EmptyStateProps { title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean; className?: string }

export function EmptyState({ title, children, action, compact, className }: EmptyStateProps) {
  return (
    <div className={cx('sf-empty', className)} data-compact={compact || undefined}>
      <span className="sf-mark" aria-hidden="true" />
      <h2 className="sf-empty-title">{title}</h2>
      {children ? <div className="sf-empty-body">{children}</div> : null}
      {action ? <div className="sf-empty-action">{action}</div> : null}
    </div>
  );
}
