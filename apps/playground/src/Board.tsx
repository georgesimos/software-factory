import {
  Dot, EmptyState, MetricStat, MetricStrip, RunCard, STAGES, Sheet, Tabs, formatDuration, formatMoney, formatPercent,
  isDone, repoOf, stageOf, type Run,
} from '@software-factory/design-system';
import { useState } from 'react';
import { CAP, METRICS, PROJECTS, RUNS } from './fixtures/index.ts';
import { RunDetail } from './RunDetail.tsx';

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function Board({ selected, onSelect }: { selected: Run | null; onSelect: (r: Run | null) => void }) {
  const [project, setProject] = useState('');
  const runs = RUNS.filter((r) => !project || repoOf(r.id) === project);
  const M = METRICS[project] ?? {};
  const pct = formatPercent(M.mergeRate), cyc = formatDuration(M.medianCycleMs), rev = formatPercent(M.revertRate);
  const cols = [...STAGES.map((s, i) => ({ key: s, name: cap(s), idx: `0${i + 1}`, list: runs.filter((r) => !isDone(r) && stageOf(r) === s) })),
    { key: 'done', name: 'Done', idx: '', list: runs.filter(isDone) }];
  return (
    <div className="pg-app">
      <header className="pg-app-top">
        <span className="pg-brand"><span className="sf-mark" aria-hidden="true" />Software Factory</span>
        <span className="pg-updated"><Dot tone="ok" />Updated just now</span>
      </header>
      <Tabs label="Project" value={project} onChange={setProject} className="pg-app-tabs"
        items={[{ id: '', label: 'All', count: RUNS.length }, ...PROJECTS.map((p) => ({ id: p, prefix: p.split('/')[0] + '/', label: p.split('/')[1]! }))]}>
        {runs.length ? (
          <>
            <MetricStrip>
              <MetricStat label="In progress" value={String(M.inProgress ?? 0)} sub={M.awaitingApproval ? `${M.awaitingApproval} awaiting approval` : `${runs.length} runs total`} />
              <MetricStat label="Merge rate" value={pct?.[0] ?? null} unit={pct?.[1]} sub={`${M.merged ?? 0} merged · ${M.escalated ?? 0} escalated`} />
              <MetricStat label="Avg iterations" value={M.avgIterations != null ? M.avgIterations.toFixed(1) : null} sub={`cap ${CAP}`} />
              <MetricStat label="Median cycle" value={cyc?.[0] ?? null} unit={cyc?.[1]} sub="first event → decision" />
              <MetricStat label="Revert rate" value={rev?.[0] ?? null} unit={rev?.[1]} sub={`${M.reverts ?? 0} reverted`} />
              <MetricStat label="Spend" prefix="$" value={M.costUsd ? M.costUsd.toFixed(2) : null} sub={M.costPerMergeUsd ? `${formatMoney(M.costPerMergeUsd)} per merge` : 'cap $5.00 / run'} />
            </MetricStrip>
            <div className="pg-board-wrap">
              <div className="pg-board">
                {cols.map((c) => (
                  <section key={c.key} className="pg-col" aria-label={`${c.name}, ${c.list.length} runs`}>
                    <div className="pg-col-h">{c.idx ? <span className="pg-idx">{c.idx}</span> : null}<h3 className="sf-label">{c.name}</h3><span className="pg-count">{c.list.length}</span></div>
                    <div className="pg-cards">
                      {c.list.length ? c.list.map((r) => (
                        <RunCard key={r.id} run={r} cap={CAP} showRepo={!project} selected={selected?.id === r.id} onSelect={(run) => onSelect(run)} />
                      )) : <div className="pg-empty-col" aria-hidden="true" />}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </>
        ) : <EmptyState title="No runs yet" />}
      </Tabs>
      <Sheet open={!!selected} onClose={() => onSelect(null)} title={selected?.id ?? 'Run'}>
        {selected ? <RunDetail run={selected} hideId /> : null}
      </Sheet>
    </div>
  );
}
