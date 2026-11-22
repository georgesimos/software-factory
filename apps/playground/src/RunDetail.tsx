import {
  ArrowUpRightIcon, Badge, Dot, MetricStat, OutcomePill, ReviewMatrix, SourceChip, StageTrack, Timeline,
  formatAgo, formatClock, formatDuration, formatMoney, formatTokens, outcomeOf, type Run,
} from '@software-factory/design-system';
import type { ReactNode } from 'react';
import { CAP, COST_CAP } from './fixtures/index.ts';

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="pg-sec"><h3 className="sf-label">{title}</h3>{children}</section>
);

function Decision({ run: r }: { run: Run }) {
  const o = outcomeOf(r);
  const last = (s: string) => (r.events ?? []).filter((e) => e.status === s).pop();
  const [tone, head, reasons] =
    o === 'rejected' ? ['bad', 'Rejected at intake', [last('rejected')?.reason]]
    : o === 'needs-info' ? ['warn', 'Waiting on the reporter', last('needs-info')?.questions]
    : o === 'awaiting-approval' ? ['warn', 'Spec awaiting human approval', last('awaiting-approval')?.reasons]
    : o === 'split' ? ['idle', `Split into ${r.children?.length ?? 'several'} runs`, []]
    : r.decision ? [o === 'merged' ? 'ok' : 'warn', o === 'merged' ? 'Merged' : o === 'escalated' ? 'Escalated to a human' : 'Deciding', r.decision.reasons]
    : r.imported ? ['idle', 'Tracked, not driven', ['The factory will not build or merge it.']]
    : [null, 'No decision yet', []];
  if (!tone) return <p className="sf-muted">{head}.</p>;
  return (
    <>
      <div className="pg-verdict"><Dot tone={tone as 'ok'} />{head}</div>
      {reasons?.filter(Boolean).length ? <ul className="pg-reasons">{reasons.filter(Boolean).map((x) => <li key={x}>{x}</li>)}</ul> : null}
      {r.reverted ? <div className="pg-callout"><b>Reverted</b> · {r.reverted.reason}</div> : null}
    </>
  );
}

export function RunDetail({ run: r, now, hideId }: { run: Run; now?: number; /** The sheet header already shows the id. */ hideId?: boolean }) {
  const d = formatDuration(r.durationMs ?? Date.parse(r.updated ?? '') - Date.parse(r.started ?? ''));
  return (
    <article className="pg-detail">
      <div className="pg-d-bar">
        {hideId ? null : <span className="sf-mono pg-d-id">{r.id}</span>}
        <OutcomePill outcome={outcomeOf(r)} reverted={!!r.reverted} />
        {r.imported ? <SourceChip source={r.source ?? 'none'} prefix="Tracked" /> : <SourceChip source="factory" />}
      </div>
      <h2 className="pg-d-title">{r.title || r.id}</h2>
      {r.spec ? <p className="pg-d-spec">{r.spec}</p> : null}
      <div className="pg-d-meta">
        {r.author ? <span>{r.author}{r.association ? ` · ${r.association.toLowerCase()}` : ''}</span> : null}
        {r.branch ? <span>⎇ {r.branch}</span> : null}
        {r.updated ? <span>updated {formatAgo(r.updated, now)}</span> : null}
      </div>
      <div className="pg-links">
        {r.url ? <a href={r.url} target="_blank" rel="noreferrer">Issue <ArrowUpRightIcon /></a> : null}
        {r.pr ? <a href={r.pr} target="_blank" rel="noreferrer">Pull request <ArrowUpRightIcon /></a> : null}
        {r.children?.length ? <Badge quiet>{r.children.length} runs</Badge> : null}
      </div>
      <Section title="Pipeline"><StageTrack run={r} /></Section>
      <Section title="Review"><ReviewMatrix run={r} /></Section>
      <Section title="Decision"><Decision run={r} /></Section>
      <Section title="Run">
        <div className="pg-facts">
          <MetricStat size="sm" label="Iterations" value={`${r.iteration ?? 0} / ${CAP}`} sub={r.loopbacks?.length ? `${r.loopbacks.length} loop-back${r.loopbacks.length > 1 ? 's' : ''}` : 'no loop-backs'} />
          {r.costUsd != null ? <MetricStat size="sm" label="Cost" value={formatMoney(r.costUsd)} sub={`of ${formatMoney(COST_CAP)} cap`} meter={r.costUsd / COST_CAP} /> : null}
          {r.tokens != null ? <MetricStat size="sm" label="Tokens" value={formatTokens(r.tokens)} /> : null}
          {d ? <MetricStat size="sm" label="Duration" value={d.join('')} sub={r.started ? `since ${formatClock(r.started, now)}` : undefined} /> : null}
        </div>
      </Section>
      <Section title="Timeline"><Timeline events={r.events ?? []} archived={r.archived} now={now} /></Section>
    </article>
  );
}
