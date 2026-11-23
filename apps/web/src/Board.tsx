import {
  EmptyState, MetricStat, MetricStrip, RunCard, STAGES, formatDuration, formatMoney, formatPercent, formatTokens,
  isDone, repoOf, stageOf, type Run,
} from '@software-factory/design-system';
import { useState, type CSSProperties } from 'react';
import { CAP, COST_CAP, type FactoryData } from './data.ts';
import { IdeaPanel } from './Idea.tsx';
import { RuleLog } from './Rules.tsx';
import { store } from './store.ts';

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
export const DONE_MAX = 20;
export const runHref = (id: string) => '#' + encodeURIComponent(id);

function Metrics({ data, project, runs }: { data: FactoryData; project: string; runs: Run[] }) {
  if (!data.metrics) return null; // GET /api/runs-only data carries none
  const M = (project ? data.metrics.byProject[project] : data.metrics.all) ?? {};
  const X = M as typeof M & { tokens?: number; tokensPerMerge?: number; measuredRuns?: number; stageShare?: Record<string, number> };
  const pct = formatPercent(M.mergeRate), cyc = formatDuration(M.medianCycleMs), rev = formatPercent(M.revertRate);
  const maxIter = data.cap ?? CAP, costCap = data.costCap ?? COST_CAP;
  const t = X.tokensPerMerge, top = Object.entries(X.stageShare ?? {}).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1])[0];
  return (
    <MetricStrip>
      <MetricStat label="In progress" value={String(M.inProgress ?? runs.filter((r) => (r.outcome ?? 'in-progress') === 'in-progress').length)} sub={M.awaitingApproval ? `${M.awaitingApproval} awaiting approval` : `${runs.length} runs total`} />
      <MetricStat label="Merge rate" value={pct?.[0] ?? null} unit={pct?.[1]} sub={M.merged != null ? `${M.merged} merged · ${M.escalated ?? 0} escalated` : 'merged ÷ decided'} />
      <MetricStat label="Avg iterations" value={M.avgIterations != null ? M.avgIterations.toFixed(1) : null} sub={`cap ${maxIter}`} />
      <MetricStat label="Median cycle" value={cyc?.[0] ?? null} unit={cyc?.[1]} sub="first event → decision" />
      <MetricStat label="Revert rate" value={rev?.[0] ?? null} unit={rev?.[1]} sub={M.reverts != null ? `${M.reverts} reverted` : 'of merged runs'} />
      {M.costUsd ? <MetricStat label="Spend" prefix="$" value={M.costUsd >= 1000 ? Math.round(M.costUsd).toLocaleString() : M.costUsd.toFixed(2)} sub={M.costPerMergeUsd != null ? `${formatMoney(M.costPerMergeUsd)} per merge` : costCap > 0 ? `cap ${formatMoney(costCap)} / run` : undefined} /> : null}
      {X.tokens ? <MetricStat label="Tokens / merge" value={t == null ? null : t >= 1e6 ? (t / 1e6).toFixed(1) : String(Math.round(t / 1e3))} unit={t == null ? undefined : t >= 1e6 ? 'M' : 'k'}
        sub={[`${formatTokens(X.tokens)} total`, top ? `${top[0]} ${Math.round(top[1] * 100)}%` : null, `${X.measuredRuns ?? 0} measured`].filter(Boolean).join(' · ')} /> : null}
    </MetricStrip>
  );
}

export function Board({ data, project, selected }: { data: FactoryData; project: string; selected?: string }) {
  const [doneOpen, setDoneOpen] = useState(() => store('sf.doneOpen') !== '0');
  const maxIter = data.cap ?? CAP;
  const runs = data.runs.filter((r) => !project || repoOf(r.id) === project);
  const ids = new Set(data.runs.map((r) => r.id));
  const ideas = Object.entries(data.ideas ?? {}).filter(([repo]) => !project || repo === project).map(([repo, p]) => <IdeaPanel key={repo} idea={{ ...p, repo }} has={(id) => ids.has(id)} href={runHref} />);
  if (!runs.length) return <>{ideas}<EmptyState title={project ? `No runs for ${project}` : 'No runs yet'}>Start one with <code>/software-factory &lt;issue&gt;</code>, start from an idea with <code>/software-factory new: &lt;idea&gt;</code>, or attach a repo to import work in flight.</EmptyState></>;
  const done = runs.filter(isDone);
  const cols = STAGES.map((s, i) => ({ key: s, name: cap(s), idx: `0${i + 1}`, list: runs.filter((r) => !isDone(r) && stageOf(r) === s) }));
  const toggle = () => { store('sf.doneOpen', doneOpen ? '0' : '1'); setDoneOpen(!doneOpen); };
  const cards = (list: Run[]) => list.length
    ? list.map((r) => <RunCard key={r.id} run={r} cap={maxIter} showRepo={!project} selected={selected === r.id} href={runHref(r.id)} />)
    : <div className="web-empty-col" aria-hidden="true" />;
  return (
    <>
      {ideas}
      <Metrics data={data} project={project} runs={runs} />
      <div className="web-board-wrap">
        <div className="web-board" data-shut={!doneOpen || undefined} style={{ '--cols': cols.length + 1 } as CSSProperties}>
          {cols.map((c) => (
            <section key={c.key} className="web-col" aria-label={`${c.name}, ${c.list.length} runs`}>
              <div className="web-col-h"><span className="web-idx">{c.idx}</span><h3 className="sf-label">{c.name}</h3><span className="web-count">{c.list.length}</span></div>
              <div className="web-cards">{cards(c.list)}</div>
            </section>
          ))}
          <section className="web-col web-done" aria-label={`Done, ${done.length} runs`}>
            <div className="web-col-h">
              <h3 className="sf-label"><button type="button" className="web-toggle" aria-expanded={doneOpen} aria-controls={doneOpen ? 'done-cards' : undefined} onClick={toggle}>
                <span className="web-chev" aria-hidden="true" />Done</button></h3>
              <span className="web-count">{done.length}</span>
            </div>
            {doneOpen ? (
              <div className="web-cards" id="done-cards">
                {cards(done.slice(0, DONE_MAX))}
                {done.length > DONE_MAX ? <div className="web-more">Showing latest {DONE_MAX} of {done.length}</div> : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <RuleLog data={data} project={project} />
    </>
  );
}
