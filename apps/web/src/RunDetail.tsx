import {
  ArrowUpRightIcon, Badge, Dot, MetricStat, OutcomePill, ReviewMatrix, SessionList, SourceChip, StageTrack, Timeline,
  formatAgo, formatClock, formatDuration, formatMoney, formatTokens, outcomeOf, type Run,
} from '@software-factory/design-system';
import type { ReactNode } from 'react';

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="web-sec"><h3 className="sf-label">{title}</h3>{children}</section>
);

/** Measured burn wins over reported numbers, as gate.ts spent() does. `burn` is set by core's derive() but not typed in the model. */
export const spent = (r: Run & { burn?: { total?: { costUsd?: number | null; tokens?: number } } }) =>
  r.burn?.total ?? { costUsd: r.costUsd, tokens: r.tokens };

function Decision({ run: r }: { run: Run }) {
  const o = outcomeOf(r);
  const last = (s: string) => (r.events ?? []).filter((e) => e.status === s).pop();
  const rejected = last('rejected');
  const decided = r.decision?.reasons;
  const [tone, head, reasons] =
    o === 'rejected' ? ['bad', 'Rejected at intake', rejected?.reason ? [rejected.reason] : rejected?.reasons]
    : o === 'needs-info' ? ['warn', 'Waiting on the reporter', last('needs-info')?.questions]
    : o === 'awaiting-approval' ? ['warn', 'Spec awaiting human approval', last('awaiting-approval')?.reasons]
    : o === 'split' ? ['idle', `Split into ${r.children?.length || 'several'} runs`, last('split')?.reasons]
    : o === 'merged' ? ['ok', 'Merged', decided]
    : o === 'escalated' ? ['warn', 'Escalated to a human', decided]
    : o === 'closed' ? ['idle', 'Closed', decided]
    : r.imported ? ['idle', 'Tracked, not driven', ['The factory will not build or merge it.']]
    : r.decision ? (r.decision.action === 'merge' ? ['run', 'Merging', decided] : ['warn', 'Escalating', decided])
    : [null, 'No decision yet', []];
  if (!tone) return <p className="sf-muted">{head}.</p>;
  const list = (reasons ?? []).filter(Boolean);
  return (
    <>
      <div className="web-verdict"><Dot tone={tone as 'ok'} />{head}</div>
      {list.length ? <ul className="web-reasons">{list.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
      {r.reverted ? (
        <div className="web-callout">
          <b>Reverted</b>{r.reverted.reason ? ` · ${r.reverted.reason}` : null}
          {r.reverted.pr ? <> · <a href={r.reverted.pr} target="_blank" rel="noreferrer">revert PR</a></> : null}
        </div>
      ) : null}
    </>
  );
}

export function RunDetail({ run: r, cap, costCap, now }: { run: Run; cap: number; costCap: number; now?: number }) {
  const d = formatDuration(r.durationMs ?? Date.parse(r.updated ?? '') - Date.parse(r.started ?? ''));
  const { costUsd, tokens } = spent(r);
  return (
    <article className="web-detail">
      <div className="web-d-bar">
        <OutcomePill outcome={outcomeOf(r)} reverted={!!r.reverted} />
        {r.imported ? <SourceChip source={r.source ?? 'none'} prefix="Tracked" /> : <SourceChip source="factory" />}
      </div>
      <h2 className="web-d-title">{r.title || r.id}</h2>
      {r.spec ? <p className="web-d-spec">{r.spec}</p> : null}
      <div className="web-d-meta">
        {r.author ? <span>{r.author}{r.association ? ` · ${r.association.toLowerCase()}` : ''}</span> : null}
        {r.branch ? <span>⎇ {r.branch}</span> : null}
        {r.updated ? <span>updated {formatAgo(r.updated, now)}</span> : null}
      </div>
      <div className="web-links">
        {r.url ? <a href={r.url} target="_blank" rel="noreferrer">Issue <ArrowUpRightIcon /></a> : null}
        {r.pr ? <a href={r.pr} target="_blank" rel="noreferrer">Pull request <ArrowUpRightIcon /></a> : null}
        {r.children?.length ? <Badge quiet>{r.children.length} runs</Badge> : null}
      </div>
      <Section title="Pipeline"><StageTrack run={r} /></Section>
      {r.sessions?.length ? <Section title="Sessions"><SessionList sessions={r.sessions} now={now} /></Section> : null}
      <Section title="Review"><ReviewMatrix run={r} /></Section>
      <Section title="Decision"><Decision run={r} /></Section>
      <Section title="Run">
        <div className="web-facts">
          <MetricStat size="sm" label="Iterations" value={`${r.iteration ?? 0} / ${cap}`} sub={r.loopbacks?.length ? `${r.loopbacks.length} loop-back${r.loopbacks.length > 1 ? 's' : ''}` : 'no loop-backs'} />
          {costUsd != null ? <MetricStat size="sm" label="Cost" value={formatMoney(costUsd)} {...(costCap > 0 ? { sub: `of ${formatMoney(costCap)} cap`, meter: costUsd / costCap } : {})} /> : null}
          {tokens != null ? <MetricStat size="sm" label="Tokens" value={formatTokens(tokens)} /> : null}
          {d ? <MetricStat size="sm" label="Duration" value={d.join('')} sub={r.started ? `since ${formatClock(r.started, now)}` : undefined} /> : null}
        </div>
      </Section>
      <Section title="Timeline"><Timeline events={r.events ?? []} archived={r.archived} now={now} /></Section>
    </article>
  );
}
