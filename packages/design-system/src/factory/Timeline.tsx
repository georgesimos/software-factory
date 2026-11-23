import type { Tone } from '../tokens.ts';
import { Dot } from '../components/Dot.tsx';
import { formatClock, formatMoney, formatTokens, type RunEvent } from './model.ts';

const TONE: Record<string, Tone> = { started: 'run', passed: 'ok', merged: 'ok', failed: 'bad', rejected: 'bad', reverted: 'bad', escalated: 'warn', 'needs-info': 'warn', 'awaiting-approval': 'warn' };

/** A run's event log, newest first. */
export function Timeline({ events, archived, now }: { events: RunEvent[]; archived?: boolean; now?: number }) {
  if (!events.length) return <p className="sf-muted">No events recorded.</p>;
  return (
    <>
      <ol className="sf-tl">
        {events.slice().reverse().map((e, k) => (
          <li key={k}>
            <time dateTime={e.ts}>{formatClock(e.ts, now)}</time>
            <span className="sf-tl-rail"><Dot tone={TONE[e.status ?? ''] ?? 'idle'} /></span>
            <div className="sf-tl-body">
              <div className="sf-tl-what">
                <b>{e.stage || '?'}</b> · {e.status || '?'}{e.axis ? ` · ${e.axis}` : ''}{e.next ? ` → ${e.next}` : ''}
                {formatMoney(e.costUsd) ? ` · ${formatMoney(e.costUsd)}` : ''}{formatTokens(e.tokens) ? ` · ${formatTokens(e.tokens)} tok` : ''}
                {e.localChecks && typeof e.localChecks === 'object' ? ` · local checks ${(e.localChecks as { state?: string }).state ?? '?'}` : ''}
              </div>
              {e.summary || e.reason || e.spec ? <div className="sf-tl-txt">{e.summary || e.reason || e.spec}</div> : null}
              {(e.stage as string) === 'note' ? <div className="sf-tl-txt">{e.status === 'pending' ? `for ${String(e.step ?? '?')}: ${String(e.text ?? '')}` : `handed to ${(Array.isArray(e.steps) ? e.steps : []).join(', ')}`}</div> : null}
              {e.reasons?.length ? <div className="sf-tl-txt">{e.reasons.join(' · ')}</div> : null}
              {e.questions?.length ? <ul>{e.questions.map((q) => <li key={q}>{q}</li>)}</ul> : null}
            </div>
          </li>
        ))}
      </ol>
      {archived ? <p className="sf-muted">Older events were archived.</p> : null}
    </>
  );
}
