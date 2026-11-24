import { Badge, Button, Dialog, EmptyState, repoOf } from '@software-factory/design-system';
import { useRef, useState } from 'react';
import { CAP, COST_CAP, type FactoryData, type Pipeline, type SkillsData, type StepRunner } from './data.ts';
import { nodeLabel, pipelineGraph, trackerName, type Edge, type Node } from './pipelineModel.ts';
import { runnerName } from './skillsModel.ts';

// The steps each issue goes through, per project, drawn from F's own `pipeline` (F skills). Read-only for now
// (docs/plans/pipelines.md, slice 1): who runs a step changes in Skills, and nothing here writes.
const W = 156, H = 76, GX = 64, GY = 10;
interface Props { open: boolean; onClose: () => void; data: FactoryData; project?: string }

export const pipelinesOf = (S?: SkillsData) => Object.entries(S?.plans ?? {}).filter(([, p]) => p.pipeline?.host).map(([scope]) => scope);

export function PipelinesSheet({ open, onClose, data, project }: Props) {
  const scopes = pipelinesOf(data.skills);
  const [picked, setPicked] = useState(project && scopes.includes(project) ? project : scopes[0] ?? '');
  const scope = scopes.includes(picked) ? picked : scopes[0] ?? '', at = data.skills?.plans?.[scope];
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Pipelines" className="web-pl" description="The steps each issue goes through.">
      {!at?.pipeline ? <EmptyState title="No project attached">Attach a project with F sync to see its pipeline.</EmptyState> : (
        <div className="web-pl-cols">
          <nav aria-label="Pipelines" className="web-pl-list">
            {scopes.map((s) => {
              const p = data.skills!.plans![s]!.pipeline!, n = data.runs.filter((r) => repoOf(r.id) === s).length;
              return (
                <button key={s} type="button" aria-current={s === scope || undefined} onClick={() => setPicked(s)}>
                  <span className="web-pl-name">{s}</span>
                  <span className="web-pl-meta">{n} run{n === 1 ? '' : 's'}</span>
                  <span className="web-pl-strip" aria-hidden="true">{p.steps.map((x) => <i key={x} data-locked={p.locked.includes(x) || undefined} />)}</span>
                </button>
              );
            })}
          </nav>
          <Graph scope={scope} p={at.pipeline} plan={{ ...at.plan, ...Object.fromEntries((at.extra ?? []).map((x) => [`review.${x.axis}`, x])) }} S={data.skills!} cap={data.cap ?? CAP} costCap={data.costCap ?? COST_CAP} />
        </div>
      )}
    </Dialog>
  );
}

function Graph({ scope, p, plan, S, cap, costCap }: { scope: string; p: Pipeline; plan: Record<string, StepRunner>; S: SkillsData; cap: number; costCap: number }) {
  const { nodes, edges } = pipelineGraph(p, plan);
  const cols = Math.max(...nodes.map((n) => n.col)) + 1, per = (c: number) => nodes.filter((n) => n.col === c).length;
  const rows = Math.max(...nodes.map((n) => per(n.col)));
  const pos = (n: Node) => ({ x: n.col * (W + GX), y: ((rows - per(n.col)) / 2 + n.row) * (H + GY) + 28 }); // 28: room for the loop-backs
  const at = new Map(nodes.map((n) => [n.id, pos(n)]));
  const who = (r: StepRunner) => [r.use === 'brief' ? (r.path ?? '').split(/[\\/]/).pop() : runnerName(S, scope, r), r.model].filter(Boolean).join(' · ');
  const w = cols * (W + GX) - GX, h = rows * (H + GY) + 28;
  const warn = p.warnings.length, [zoom, setZoom] = useState(1), main = useRef<HTMLDivElement>(null);
  const z = (x: number) => setZoom(Math.min(1.5, Math.max(0.3, Math.round(x * 100) / 100)));
  return (
    <>
      <div className="web-pl-main">
        <div className="web-pl-zoom" role="group" aria-label="Zoom">
          <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => z(zoom - 0.1)}>−</Button>
          <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => z(zoom + 0.1)}>+</Button>
          <Button size="sm" variant="ghost" onClick={() => z((main.current?.clientWidth ?? w) / (w + 32))}>Fit</Button>
        </div>
        <div className="web-pl-scroll" ref={main}><div style={{ width: w * zoom + 32, height: h * zoom + 32 }}>
        <div className="web-pl-canvas" style={{ width: w, height: h, transform: `scale(${zoom})` }}>
          <svg width={w} height={h} aria-hidden="true">{edges.map((e, i) => <Path key={i} e={e} at={at} />)}</svg>
          <ol aria-label={`${scope} pipeline`}>
            {nodes.map((n) => {
              const { x, y } = at.get(n.id)!;
              return (
                <li key={n.id} aria-label={n.label} data-kind={n.kind} data-locked={n.locked || undefined} style={{ left: x, top: y, width: W, height: H }}>
                  <span className="web-pl-t">{n.label}{n.locked ? <Badge quiet>Locked</Badge> : null}</span>
                  {n.sub ? <span className="web-pl-sub">{n.sub}</span> : null}
                  {n.runner ? <span className="web-pl-who">{who(n.runner)}</span> : null}
                </li>
              );
            })}
          </ol>
        </div></div></div>
        <p className="web-pl-foot"><span>{warn ? `${warn} warning${warn === 1 ? '' : 's'}` : 'Valid'} · {nodes.length} steps · {edges.length} connections</span><span>loops ≤ {cap} · ${costCap} / run</span></p>
      </div>
      <aside className="web-pl-side" aria-label="About this pipeline">
        <h3>{scope}</h3>
        <p>On host {p.host}{p.tracker ? `, tracker ${p.tracker}` : ', no tracker yet'}. Every issue goes through these steps; F checks the result, never this page.</p>
        <p className="sf-label">Checks</p>
        <ul className="web-pl-checks">
          <li>Locked: {p.locked.map(nodeLabel).join(', ')}</li>
          <li>Review axes: {p.axes.length - p.axes.filter((a) => Array.isArray(a.when)).length} built-in, {p.axes.filter((a) => Array.isArray(a.when)).length} yours</li>
          <li>The gate loops back to {p.loops.join(' and ')}, at most {cap} times, ${costCap} per run</li>
          <li>Steps off: {p.off.length ? p.off.join(', ') : 'none'}</li>
          <li>Custom steps: {Object.values(p.custom).flat().length || 'none'}</li>
          {p.warnings.map((x) => <li key={x} data-bad>{x}</li>)}
        </ul>
        <p className="web-pl-note">Who runs a step changes in Skills. Issues labelled factory:ready{p.tracker ? ` in ${trackerName(p.tracker)}` : ''} start here.</p>
        <details><summary>pipeline.json</summary><pre>{JSON.stringify(p, null, 2)}</pre></details>
      </aside>
    </>
  );
}

function Path({ e, at }: { e: Edge; at: Map<string, { x: number; y: number }> }) {
  const a = at.get(e.from), b = at.get(e.to);
  if (!a || !b) return null;
  if (e.loop) { // over the top, from the gate back to an earlier step
    const x1 = a.x + W / 2, x2 = b.x + W / 2, top = Math.min(a.y, b.y) - 20 - (x1 - x2) / 40;
    return <path d={`M${x1},${a.y} C${x1},${top} ${x2},${top} ${x2},${b.y}`} data-loop />;
  }
  const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, m = (x1 + x2) / 2;
  return (
    <g>
      <path d={`M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`} />
      {e.label ? <text x={x2 - 6} y={y2 - 5} textAnchor="end">{e.label}</text> : null}
    </g>
  );
}
