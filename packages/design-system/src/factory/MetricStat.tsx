import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../components/cx.ts';

export interface MetricStatProps {
  label: string;
  /** null renders an em dash in muted ink. */
  value: ReactNode | null;
  unit?: string;
  /** Unit before the value, e.g. "$". */
  prefix?: string;
  sub?: ReactNode;
  size?: 'lg' | 'sm';
  /** 0–1 fill for a hairline meter under the value (cost vs cap). Over 1 turns it red. */
  meter?: number;
}

export function MetricStat({ label, value, unit, prefix, sub, size = 'lg', meter }: MetricStatProps) {
  const none = value == null || value === '';
  return (
    <div className="sf-metric" data-size={size}>
      <div className="sf-label">{label}</div>
      <div className={cx('sf-metric-v', none && 'sf-metric-none')}>
        {none ? '—' : <>{prefix ? <small className="sf-metric-pre">{prefix}</small> : null}{value}{unit ? <small>{unit}</small> : null}</>}
      </div>
      {meter != null ? (
        <div className="sf-meter" data-over={meter > 1 || undefined} aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, meter * 100))}%` }} /></div>
      ) : null}
      {sub ? <div className="sf-metric-s">{sub}</div> : null}
    </div>
  );
}

/** Row of large metrics divided by hairlines. Reflows to 3, then 2 columns. */
export function MetricStrip({ children, label = 'Metrics' }: { children: ReactNode; label?: string }) {
  const n = Array.isArray(children) ? children.filter(Boolean).length : 1;
  return <section className="sf-metrics" aria-label={label} style={{ '--n': n } as CSSProperties}>{children}</section>;
}
