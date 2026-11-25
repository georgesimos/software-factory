import { useRef, useState } from 'react';
import { Badge } from '../components/Badge.tsx';
import { Button } from '../components/Button.tsx';
import { nodeLabel, pipelineGraph, trackerName, type Pipeline, type PipelineEdge, type PipelineNode, type StepRunner } from './pipelineModel.ts';

// One pipeline as a node graph, with its checks beside it. Presentational: it takes F's pipeline as props and draws only that.
const W = 156, H = 76, GX = 64, GY = 10;
export interface PipelineGraphProps {
  /** What the pipeline is called: the project, or a named pipeline. */
  name: string;
  pipeline: Pipeline;
  /** Who runs each step, by step key (review.<axis> for an axis). */
  plan?: Record<string, StepRunner>;
  /** A runner's display name; the dashboard names catalog entries. Defaults to the runner's own name. */
  runnerName?: (r: StepRunner) => string;
  /** The loop cap and the per-run budget in dollars. */
  cap: number;
  costCap: number;
}
const ownName = (r: StepRunner) => (!r.use || r.use === 'default' ? 'Factory default' : r.name ?? r.use);

export function PipelineGraph({ name, pipeline: p, plan = {}, runnerName = ownName, cap, costCap }: PipelineGraphProps) {
  const { nodes, edges } = pipelineGraph(p, plan);
  const cols = Math.max(...nodes.map((n) => n.col)) + 1, per = (c: number) => nodes.filter((n) => n.col === c).length;
  const rows = Math.max(...nodes.map((n) => per(n.col)));
  const pos = (n: PipelineNode) => ({ x: n.col * (W + GX), y: ((rows - per(n.col)) / 2 + n.row) * (H + GY) + 28 }); // 28: room for the loop-backs
  const at = new Map(nodes.map((n) => [n.id, pos(n)]));
  const who = (r: StepRunner) => [r.use === 'brief' ? (r.path ?? '').split(/[\\/]/).pop() : runnerName(r), r.model].filter(Boolean).join(' · ');
  const w = cols * (W + GX) - GX, h = rows * (H + GY) + 28;
  const warn = p.warnings.length, [zoom, setZoom] = useState(1), main = useRef<HTMLDivElement>(null);
  const z = (x: number) => setZoom(Math.min(1.5, Math.max(0.3, Math.round(x * 100) / 100)));
  return (
    <>
      <div className="sf-pl-main">
        <div className="sf-pl-zoom" role="group" aria-label="Zoom">
          <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => z(zoom - 0.1)}>−</Button>
          <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => z(zoom + 0.1)}>+</Button>
          <Button size="sm" variant="ghost" onClick={() => z((main.current?.clientWidth ?? w) / (w + 32))}>Fit</Button>
        </div>
        <div className="sf-pl-scroll" ref={main}><div style={{ width: w * zoom + 32, height: h * zoom + 32 }}>
        <div className="sf-pl-canvas" style={{ width: w, height: h, transform: `scale(${zoom})` }}>
          <svg width={w} height={h} aria-hidden="true">{edges.map((e, i) => <Path key={i} e={e} at={at} />)}</svg>
          <ol aria-label={`${name} pipeline`}>
            {nodes.map((n) => {
              const { x, y } = at.get(n.id)!;
              return (
                <li key={n.id} aria-label={n.label} data-kind={n.kind} data-locked={n.locked || undefined} style={{ left: x, top: y, width: W, height: H }}>
                  <span className="sf-pl-t">{n.label}{n.locked ? <Badge quiet>Locked</Badge> : null}</span>
                  {n.sub ? <span className="sf-pl-sub">{n.sub}</span> : null}
                  {n.runner ? <span className="sf-pl-who">{who(n.runner)}</span> : null}
                </li>
              );
            })}
          </ol>
        </div></div></div>
        <p className="sf-pl-foot"><span>{warn ? `${warn} warning${warn === 1 ? '' : 's'}` : 'Valid'} · {nodes.length} steps · {edges.length} connections</span><span>loops ≤ {cap} · ${costCap} / run</span></p>
      </div>
      <aside className="sf-pl-side" aria-label="About this pipeline">
        <h3>{name}</h3>
        <p>On host {p.host}{p.tracker ? `, tracker ${p.tracker}` : ', no tracker yet'}. Every issue goes through these steps; F checks the result, never this page.</p>
        <p className="sf-label">Checks</p>
        <ul className="sf-pl-checks">
          <li>Locked: {p.locked.map(nodeLabel).join(', ')}</li>
          <li>Review axes: {p.axes.length - p.axes.filter((a) => Array.isArray(a.when)).length} built-in, {p.axes.filter((a) => Array.isArray(a.when)).length} yours</li>
          <li>The gate loops back to {p.loops.join(' and ')}, at most {cap} times, ${costCap} per run</li>
          <li>Steps off: {p.off.length ? p.off.join(', ') : 'none'}</li>
          <li>Custom steps: {Object.values(p.custom).flat().length || 'none'}</li>
          {p.warnings.map((x) => <li key={x} data-bad>{x}</li>)}
        </ul>
        <p className="sf-pl-note">Who runs a step changes in Skills. Issues labelled factory:ready{p.tracker ? ` in ${trackerName(p.tracker)}` : ''} start here.</p>
        <details><summary>pipeline.json</summary><pre>{JSON.stringify(p, null, 2)}</pre></details>
      </aside>
    </>
  );
}

function Path({ e, at }: { e: PipelineEdge; at: Map<string, { x: number; y: number }> }) {
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

export interface PipelineListItem { id: string; name: string; meta?: string; pipeline: Pipeline }
/** The pipelines to pick from, each with a strip of its steps (locked ones darker). Goes in the first column of `sf-pl-cols`. */
export function PipelineList({ items, current, onPick }: { items: PipelineListItem[]; current: string; onPick: (id: string) => void }) {
  return (
    <nav aria-label="Pipelines" className="sf-pl-list">
      {items.map((it) => (
        <button key={it.id} type="button" aria-current={it.id === current || undefined} onClick={() => onPick(it.id)}>
          <span className="sf-pl-name">{it.name}</span>
          {it.meta ? <span className="sf-pl-meta">{it.meta}</span> : null}
          <span className="sf-pl-strip" aria-hidden="true">{it.pipeline.steps.map((x) => <i key={x} data-locked={it.pipeline.locked.includes(x) || undefined} />)}</span>
        </button>
      ))}
    </nav>
  );
}
