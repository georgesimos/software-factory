import type { MouseEvent } from 'react';
import { Badge } from '../components/Badge.tsx';
import { Dot } from '../components/Dot.tsx';
import { cx } from '../components/cx.ts';
import { OutcomePill } from './OutcomePill.tsx';
import { SessionsChip } from './Sessions.tsx';
import { SourceChip } from './SourceChip.tsx';
import { burnText, formatAgo, formatClock, formatTokens, isDone, outcomeOf, previewOf, repoOf, reviewFailed, runTone, shortId, stageOf, type Run } from './model.ts';

export interface RunCardProps {
  run: Run;
  /** Renders as a link when set; otherwise a button. */
  href?: string;
  onSelect?: (run: Run, e: MouseEvent) => void;
  selected?: boolean;
  /** Show "repo" before "#42" (the all-projects view). */
  showRepo?: boolean;
  /** Iteration cap; the dots turn warn when a run hits it. */
  cap?: number;
  now?: number;
}

function IterDots({ n, cap, capped }: { n: number; cap: number; capped: boolean }) {
  return (
    <span className="sf-iters" data-capped={capped || undefined} role="img" aria-label={`Iteration ${n} of ${cap}`}>
      {Array.from({ length: Math.max(cap, n) }, (_, i) => <i key={i} data-on={i < n || undefined} />)}
    </span>
  );
}

function AxesBar({ run }: { run: Run }) {
  const it = String(run.iteration ?? 0), axes = run.axes?.[it] ?? [], rev = run.reviews?.[it] ?? {};
  if (!axes.length) return null;
  const done = axes.filter((a) => rev[a]).length;
  return (
    <span className="sf-axes" title={`Review axes for iteration ${it}`}>
      <span aria-hidden="true">{axes.map((a) => <i key={a} data-v={!rev[a] ? undefined : reviewFailed(rev[a]!) ? 'bad' : 'ok'} />)}</span>
      {done < axes.length ? `${axes.length - done} pending` : `${done}/${axes.length}`}
    </span>
  );
}

/** One run on the board. Imported runs render quieter ("tracked, not driven"). */
export function RunCard({ run: r, href, onSelect, selected, showRepo, cap = 3, now }: RunCardProps) {
  const done = isDone(r), o = outcomeOf(r), { tone, live } = runTone(r);
  const repo = repoOf(r.id), iteration = r.iteration ?? 0;
  // A plain chip: the card is itself a link, so the real preview link is in the run's Deploy section.
  const bad = r.deploys?.find((d) => d.status === 'failed'), preview = previewOf(r);
  const foot = (
    <>
      {done ? <OutcomePill outcome={o} reverted={!!r.reverted} /> : o !== 'in-progress' ? <OutcomePill outcome={o} /> : null}
      {!r.imported && iteration > 0 ? <IterDots n={iteration} cap={cap} capped={iteration >= cap && o !== 'merged'} /> : null}
      {!done && stageOf(r) === 'review' ? <AxesBar run={r} /> : null}
      {!done && r.loopbacks?.length ? <span className="sf-loops" title="Loop-backs">↺{r.loopbacks.length}</span> : null}
      {r.imported ? <SourceChip source={r.source ?? 'none'} title="Tracked: imported, not driven by the factory" /> : null}
      {r.sessions?.length ? <SessionsChip sessions={r.sessions} /> : null}
      {r.children?.length ? <Badge quiet>{r.children.length} runs</Badge> : null}
      {bad ? <Badge tone="bad" title={`${bad.connector} · ${bad.env}: ${bad.state}${bad.detail ? ` · ${bad.detail}` : ''}`}>Deploy failed</Badge>
        : preview ? <Badge tone="ok" title={`Preview ready: ${preview.url}`}>Preview ↗</Badge> : null}
      {r.burn?.total.tokens ? <Badge quiet title={`${r.burn.measured ? 'Measured' : 'Reported'}: ${burnText(r.burn.total)}`}>{formatTokens(r.burn.total.tokens)} tok</Badge> : null}
      {r.archived ? <Badge quiet>Archived</Badge> : null}
    </>
  );
  const body = (
    <>
      <span className="sf-rc-top">
        <Dot tone={tone} live={live} />
        <span className="sf-rc-id" title={r.id}>
          {showRepo ? <span className="sf-rc-repo">{shortId(repo)}</span> : null}
          <span className="sf-rc-num">{r.id.slice(repo.length)}</span>
        </span>
        {r.updated ? <time dateTime={r.updated} title={formatClock(r.updated, now)}>{formatAgo(r.updated, now)}</time> : null}
      </span>
      <span className="sf-rc-title">{r.title || r.branch || shortId(r.id)}</span>
      <span className="sf-rc-foot">{foot}</span>
    </>
  );
  const props = {
    className: cx('sf-card', 'sf-run-card'),
    'data-tracked': r.imported || undefined,
    'data-done': done || undefined,
    'aria-current': selected ? ('true' as const) : undefined,
    onClick: onSelect ? (e: MouseEvent) => onSelect(r, e) : undefined,
  };
  return href ? <a href={href} {...props}>{body}</a> : <button type="button" {...props}>{body}</button>;
}
