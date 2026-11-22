import { useId } from 'react';
import { Badge } from '../components/Badge.tsx';
import { Dot } from '../components/Dot.tsx';

export type IngestStatus = 'queued' | 'syncing' | 'done' | 'failed';
export interface IngestItem {
  repo: string;
  status: IngestStatus;
  /** Open PRs imported (see syncCounts). */
  prs?: number;
  /** Agent sessions imported or matched to a PR. */
  sessions?: number;
  /** Runs closed because their work ended outside the factory. */
  closed?: number;
  error?: string;
}

const STATUS = { queued: ['idle', 'Queued'], syncing: ['run', 'Importing'], done: ['ok', 'Done'], failed: ['bad', 'Failed'] } as const;
const n = (x: number | undefined, one: string) => (x == null ? null : `${x} ${one}${x === 1 ? '' : 's'}`);

/** Step 2 of onboarding: one row per project as it is synced, with import counts. */
export function IngestProgress({ items, onRetry }: { items: IngestItem[]; onRetry?: (repo: string) => void }) {
  const titleId = useId();
  const finished = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const total = (k: 'prs' | 'sessions') => items.reduce((s, i) => s + (i[k] ?? 0), 0);
  return (
    <section className="sf-ingest" aria-labelledby={titleId}>
      <header className="sf-ingest-head">
        <h2 id={titleId} className="sf-picker-title">{finished < items.length ? 'Importing work in flight' : 'Projects attached'}</h2>
        <p className="sf-picker-sub" aria-live="polite">{finished} of {items.length} projects · {n(total('prs'), 'PR')} · {n(total('sessions'), 'session')}</p>
        <progress className="sf-ingest-bar" max={items.length || 1} value={finished} aria-label="Projects imported" />
      </header>
      <ol className="sf-ingest-list">
        {items.map((it) => {
          const [tone, label] = STATUS[it.status];
          const [owner, name] = it.repo.split('/');
          return (
            <li key={it.repo} className="sf-ingest-row" data-status={it.status}>
              <Dot tone={tone} live={it.status === 'syncing'} />
              <span className="sf-ingest-repo"><span className="sf-picker-owner">{owner}/</span>{name}</span>
              <span className="sf-ingest-counts">
                {it.status === 'failed' ? <span className="sf-ingest-err">{it.error || 'Sync failed'}</span>
                  : it.status === 'queued' ? null
                  : [n(it.prs, 'PR'), n(it.sessions, 'session'), it.closed ? `${it.closed} closed` : null].filter(Boolean).join(' · ') || '…'}
              </span>
              {it.status === 'failed' && onRetry ? (
                <button type="button" className="sf-ingest-retry" onClick={() => onRetry(it.repo)}>Retry</button>
              ) : <Badge tone={tone}>{label}</Badge>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
