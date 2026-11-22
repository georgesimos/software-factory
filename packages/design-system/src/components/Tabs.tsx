import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx.ts';

export interface TabItem { id: string; label: ReactNode; /** Dimmed prefix, e.g. the owner in "owner/repo". */ prefix?: ReactNode; count?: number }
export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** The panel for the selected tab. */
  children: ReactNode;
  className?: string;
}

/** Segmented tabs (the project switcher). Arrow keys / Home / End move and select; only the selected tab is in the tab order. */
export function Tabs({ items, value, onChange, label, children, className }: TabsProps) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === value);
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault();
    const next = items[(n + items.length) % items.length];
    if (!next) return;
    onChange(next.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus();
  };
  return (
    <div className={className}>
      <div ref={list} role="tablist" aria-label={label} className="sf-tabs" onKeyDown={onKey}>
        {items.map((t) => {
          const on = t.id === value;
          return (
            <button key={t.id} type="button" role="tab" id={`${base}-${t.id}`} data-tab={t.id} aria-selected={on} aria-controls={`${base}-panel`}
              tabIndex={on ? 0 : -1} className="sf-tab" onClick={() => onChange(t.id)}>
              {t.prefix ? <span className="sf-tab-prefix">{t.prefix}</span> : null}
              {t.label}
              {t.count != null ? <span className="sf-tab-count">{t.count}</span> : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${value}`} className={cx('sf-tabpanel')}>{children}</div>
    </div>
  );
}
