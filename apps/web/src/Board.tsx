import {
  EmptyState, MetricStat, MetricStrip, RunCard, STAGES, Sheet, Tabs, formatDuration, formatMoney, formatPercent,
  isDone, repoOf, stageOf, type Run,
} from '@software-factory/design-system';
import { useState } from 'react';
import { CAP, COST_CAP, projectsOf, type FactoryData } from './data.ts';
import { RunDetail } from './RunDetail.tsx';

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function Board({ data }: { data: FactoryData }) {
  const [project, setProject] = useState('');
  const [selected, setSelected] = useState<Run | null>(null);
  const maxIter = data.cap ?? CAP, costCap = data.costCap ?? COST_CAP;
  const runs = data.runs.filter((r) => !project || repoOf(r.id) === project);
  // GET /api/runs carries no metrics; the strip shows only for injected data.
  const M = data.metrics ? (project ? data.metrics.byProject[project] : data.metrics.all) ?? {} : null;
  const pct = formatPercent(M?.mergeRate), cyc = formatDuration(M?.medianCycleMs), rev = formatPercent(M?.revertRate);
  const cols = [...STAGES.map((s, i) => ({ key: s, name: cap(s), idx: `0${i + 1}`, list: runs.filter((r) => !isDone(r) && stageOf(r) === s) })),
    { key: 'done', name: 'Done', idx: '', list: runs.filter(isDone) }];
  return (
    <>
      <Tabs label="Project" value={project} onChange={setProject} className="web-tabs"
        items={[{ id: '', label: 'All', count: data.runs.length }, ...projectsOf(data).map((p) => ({ id: p, prefix: p.split('/')[0] + '/', label: p.split('/')[1]! }))]}>
        {runs.length ? (
          <>
            {M ? (
              <MetricStrip>
                <MetricStat label="In progress" value={String(M.inProgress ?? 0)} sub={M.awaitingApproval ? `${M.awaitingApproval} awaiting approval` : `${runs.length} runs total`} />
                <MetricStat label="Merge rate" value={pct?.[0] ?? null} unit={pct?.[1]} sub={`${M.merged ?? 0} merged · ${M.escalated ?? 0} escalated`} />
                <MetricStat label="Avg iterations" value={M.avgIterations != null ? M.avgIterations.toFixed(1) : null} sub={`cap ${maxIter}`} />
                <MetricStat label="Median cycle" value={cyc?.[0] ?? null} unit={cyc?.[1]} sub="first event → decision" />
                <MetricStat label="Revert rate" value={rev?.[0] ?? null} unit={rev?.[1]} sub={`${M.reverts ?? 0} reverted`} />
                <MetricStat label="Spend" prefix="$" value={M.costUsd ? M.costUsd.toFixed(2) : null} sub={M.costPerMergeUsd ? `${formatMoney(M.costPerMergeUsd)} per merge` : `cap ${formatMoney(costCap)} / run`} />
              </MetricStrip>
            ) : null}
            <div className="web-board-wrap">
              <div className="web-board">
                {cols.map((c) => (
                  <section key={c.key} className="web-col" aria-label={`${c.name}, ${c.list.length} runs`}>
                    <div className="web-col-h">{c.idx ? <span className="web-idx">{c.idx}</span> : null}<h3 className="sf-label">{c.name}</h3><span className="web-count">{c.list.length}</span></div>
                    <div className="web-cards">
                      {c.list.length ? c.list.map((r) => (
                        <RunCard key={r.id} run={r} cap={maxIter} showRepo={!project} selected={selected?.id === r.id} onSelect={setSelected} />
                      )) : <div className="web-empty-col" aria-hidden="true" />}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </>
        ) : <EmptyState title="No runs yet" />}
      </Tabs>
      <Sheet open={!!selected} onClose={() => setSelected(null)} title={selected?.id ?? 'Run'}>
        {selected ? <RunDetail run={selected} cap={maxIter} costCap={costCap} /> : null}
      </Sheet>
    </>
  );
}
