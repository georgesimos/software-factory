import { useEffect, useRef, useState, type PointerEvent as PE, type ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { LockIcon } from '../components/icons.tsx';
import { Select } from '../components/Input.tsx';
import { OUTCOME_LABEL, formatMoney, outcomeOf, type Run } from './model.ts';
import { STEP_STATUS, nodeLabel, pipelineGraph, runOverlay, trackerName, type Pipeline, type PipelineEdge, type PipelineNode, type RunOverlay, type StepRunner } from './pipelineModel.ts';
import { PipelineStepPanel, type StepEditing } from './PipelineStepPanel.tsx';

// One pipeline as a node graph, with its checks beside it. Presentational: it takes F's pipeline as props and draws only that.
// The canvas borrows n8n's patterns, in this design system: drag the background to pan, a map of the whole graph, a step
// opens its panel in the side column, and "Show a run…" draws one run's events on the graph.
const W = 172, H = 76, GX = 64, GY = 12, MAP_W = 168, MAP_H = 96;
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
  /** Changing who runs a step from its panel; without it the panel only shows the step. */
  edit?: StepEditing;
  /** This pipeline's runs, for "Show a run…". */
  runs?: Run[];
}
const runName = (id: string) => id.replace(/^[^#:]*/, '') || id; // #7: the project is the page's
const ownName = (r: StepRunner) => (!r.use || r.use === 'default' ? 'Factory default' : r.name ?? r.use);

export function PipelineGraph({ name, pipeline: p, plan = {}, runnerName = ownName, cap, costCap, edit, runs = [] }: PipelineGraphProps) {
  const g = pipelineGraph(p, plan), { nodes, edges } = g;
  const [picked, setPicked] = useState(''), [open, setOpen] = useState(''), buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const run = runs.find((r) => r.id === picked), o = run ? runOverlay(g, run.events ?? []) : null, sel = nodes.find((n) => n.id === open);
  const head = useRef<HTMLHeadingElement>(null), close = () => { setOpen(''); buttons.current[open]?.focus(); };
  useEffect(() => { if (open) head.current?.focus(); }, [open]); // into the panel; on a phone that scrolls it into view under the graph
  const cols = Math.max(...nodes.map((n) => n.col)) + 1, per = (c: number) => nodes.filter((n) => n.col === c).length;
  const rows = Math.max(...nodes.map((n) => per(n.col)));
  const pos = (n: PipelineNode) => ({ x: n.col * (W + GX), y: ((rows - per(n.col)) / 2 + n.row) * (H + GY) + 36 }); // 36: room for the loop-backs
  const at = new Map(nodes.map((n) => [n.id, pos(n)]));
  // The built-in brief shows only its model; anything else its name (a brief only by its file), then the model.
  const who = (r: StepRunner) => [!r.use || r.use === 'default' ? '' : r.use === 'brief' ? (r.path ?? '').split(/[\\/]/).pop() : runnerName(r), r.model].filter(Boolean).join(' · ') || runnerName(r);
  const w = cols * (W + GX) - GX, h = rows * (H + GY) + 36;
  const warn = p.warnings.length, [zoom, setZoom] = useState(1), main = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const z = (x: number) => setZoom(Math.min(1.5, Math.max(0.3, Math.round(x * 100) / 100)));
  // What part of the graph is in view, in graph units, for the map. The canvas sits `pad` into the scroll area, then scales.
  const [view, setView] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const sync = () => {
    const s = main.current, pad = canvas.current?.offsetLeft ?? 0;
    if (s) setView({ x: (s.scrollLeft - pad) / zoom, y: (s.scrollTop - pad) / zoom, w: s.clientWidth / zoom, h: s.clientHeight / zoom });
  };
  useEffect(() => { // open on the start, vertically: the tall review column would otherwise fill a phone's window with nothing
    const s = main.current, start = at.get('ready');
    if (s && start) { s.scrollTop = start.y + (canvas.current?.offsetTop ?? 0) + H / 2 - s.clientHeight / 2; sync(); }
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    sync();
    if (typeof ResizeObserver === 'undefined' || !main.current) return;
    const r = new ResizeObserver(sync); r.observe(main.current);
    return () => r.disconnect();
  }, [zoom, w, h]); // eslint-disable-line react-hooks/exhaustive-deps
  const centre = (gx: number, gy: number) => {
    const s = main.current, pad = canvas.current?.offsetLeft ?? 0;
    if (s) { s.scrollLeft = gx * zoom + pad - s.clientWidth / 2; s.scrollTop = gy * zoom + pad - s.clientHeight / 2; sync(); }
  };
  // Drag the background to pan, with a mouse or pen; a touch scrolls natively, and a drag from a step or control is theirs.
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null), [grabbing, setGrabbing] = useState(false);
  const down = (e: PE<HTMLDivElement>) => {
    const s = main.current;
    if (!s || e.button !== 0 || e.pointerType === 'touch' || (e.target as Element).closest('button, select, a, input')) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: s.scrollLeft, top: s.scrollTop };
    s.setPointerCapture?.(e.pointerId);
    setGrabbing(true);
  };
  const move = (e: PE<HTMLDivElement>) => {
    const d = drag.current, s = main.current;
    if (!d || !s || d.id !== e.pointerId) return;
    s.scrollLeft = d.left - (e.clientX - d.x); s.scrollTop = d.top - (e.clientY - d.y);
    sync();
  };
  const up = () => { drag.current = null; setGrabbing(false); };
  return (
    <>
      <div className="sf-pl-main">
        <div className="sf-pl-stage">
        {runs.length ? (
          <Select className="sf-pl-run" aria-label="Show a run" value={run ? picked : ''} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Show a run…</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{[runName(r.id), r.title, OUTCOME_LABEL[outcomeOf(r)]].filter(Boolean).join(' · ')}</option>)}
          </Select>
        ) : null}
        <div className="sf-pl-scroll" ref={main} data-grabbing={grabbing || undefined} onScroll={sync}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}><div className="sf-pl-size" style={{ width: w * zoom + 32, height: h * zoom + 32 }}>
        <div className="sf-pl-canvas" ref={canvas} style={{ width: w, height: h, transform: `scale(${zoom})` }}>
          <svg width={w} height={h} aria-hidden="true" data-overlay={o ? true : undefined}>
            <defs>
              <marker id="sf-pl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" /></marker>
              <marker id="sf-pl-arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" data-on /></marker>
            </defs>
            {edges.map((e, i) => <Path key={i} e={e} at={at} o={o} />)}
          </svg>
          <ol aria-label={`${name} pipeline`}>
            {nodes.map((n) => {
              const { x, y } = at.get(n.id)!, st = o?.steps[n.id];
              const body: ReactNode = <>
                <span className="sf-pl-t"><span className="sf-pl-label">{n.label}</span>{n.locked ? <span className="sf-pl-lock" title="Locked: every run has it"><LockIcon aria-hidden="true" /><span className="sf-sr-only">Locked</span></span> : null}</span>
                {st ? <span className="sf-pl-st"><span className="sf-pl-dot" data-status={st.status} aria-hidden="true" />{STEP_STATUS[st.status]}{st.note ? ` · ${st.note}` : ''}</span>
                  : n.sub ? <span className="sf-pl-sub">{n.sub}</span> : null}
                {n.runner ? <span className="sf-pl-who">{who(n.runner)}</span> : null}
              </>;
              return (
                <li key={n.id} aria-label={n.label} data-kind={n.kind} data-locked={n.locked || undefined} data-status={st?.status} data-open={open === n.id || undefined}
                  style={{ left: x, top: y, width: W, height: H }}>
                  {n.kind === 'step' || n.kind === 'review' ? (
                    <button type="button" className="sf-pl-node" aria-label={n.label} aria-expanded={open === n.id} aria-controls={open === n.id ? 'sf-pl-panel' : undefined}
                      ref={(b) => { buttons.current[n.id] = b; }} onClick={() => setOpen(open === n.id ? '' : n.id)}>{body}</button>
                  ) : <div className="sf-pl-node">{body}</div>}
                </li>
              );
            })}
          </ol>
        </div></div></div>
        <div className="sf-pl-zoom" role="group" aria-label="Zoom">
          <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => z(zoom - 0.1)}>−</Button>
          <span className="sf-pl-pct" aria-hidden="true">{Math.round(zoom * 100)}%</span>
          <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => z(zoom + 0.1)}>+</Button>
          <Button size="sm" variant="ghost" onClick={() => z(Math.min((main.current?.clientWidth ?? w) / (w + 32), (main.current?.clientHeight ?? h) / (h + 32)))}>Fit</Button>
        </div>
        <MiniMap nodes={nodes} at={at} w={w} h={h} view={view} o={o} open={open} onMove={centre} />
        </div>
        <p className="sf-pl-foot"><span>{warn ? `${warn} warning${warn === 1 ? '' : 's'}` : 'Valid'} · {nodes.length} steps · {edges.length} connections</span>
          <span>{run && o ? runFoot(run, o, cap, costCap) : `loops ≤ ${cap} · $${costCap} / run`}</span></p>
      </div>
      {sel ? <PipelineStepPanel key={sel.id} ref={head} node={sel} runnerName={runnerName} edit={edit} result={o?.steps[sel.id]} runLabel={run && runName(run.id)} onClose={close} />
        : <About name={name} p={p} cap={cap} costCap={costCap} />}
    </>
  );
}

/**
 * The whole graph, small, with the part in view outlined: click or drag on it to move the view there. A pointer aid only
 * (aria-hidden): the canvas scrolls with the keyboard, and every step is a button in the list.
 */
function MiniMap({ nodes, at, w, h, view, o, open, onMove }: { nodes: PipelineNode[]; at: Map<string, { x: number; y: number }>; w: number; h: number;
  view: { x: number; y: number; w: number; h: number }; o: RunOverlay | null; open: string; onMove: (gx: number, gy: number) => void }) {
  const s = Math.min(MAP_W / w, MAP_H / h), mw = Math.round(w * s), mh = Math.round(h * s), held = useRef<number | null>(null);
  const to = (e: PE<SVGSVGElement>) => { const r = e.currentTarget.getBoundingClientRect(); onMove(((e.clientX - r.left) / (r.width || mw)) * w, ((e.clientY - r.top) / (r.height || mh)) * h); };
  return (
    <div className="sf-pl-mapbox"><svg className="sf-pl-map" aria-hidden="true" width={mw} height={mh} viewBox={`0 0 ${w} ${h}`}
      onPointerDown={(e) => { held.current = e.pointerId; e.currentTarget.setPointerCapture?.(e.pointerId); to(e); }}
      onPointerMove={(e) => { if (held.current === e.pointerId) to(e); }} onPointerUp={() => { held.current = null; }} onPointerCancel={() => { held.current = null; }}>
      {nodes.map((n) => { const { x, y } = at.get(n.id)!; return <rect key={n.id} data-node={n.id} data-status={o?.steps[n.id]?.status} data-open={open === n.id || undefined} x={x} y={y} width={W} height={H} rx={10} />; })}
      {view.w ? <rect className="sf-pl-map-view" x={view.x} y={view.y} width={view.w} height={view.h} rx={8} /> : null}
    </svg></div>
  );
}

/** Spend as the run panel counts it (measured burn over reported numbers), against the per-run cap. */
function runFoot(r: Run, o: RunOverlay, cap: number, costCap: number) {
  const usd = r.burn?.total.costUsd ?? r.costUsd ?? 0, loops = Object.values(o.loops).reduce((a, b) => a + b, 0);
  return `${runName(r.id)} · ${OUTCOME_LABEL[outcomeOf(r)]} · ${formatMoney(usd)} of $${costCap} · ${loops} of ${cap} loops`;
}

function About({ name, p, cap, costCap }: { name: string; p: Pipeline; cap: number; costCap: number }) {
  return (
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
      <p className="sf-pl-note">Click a step to see who runs it, and to change that. Issues labelled factory:ready{p.tracker ? ` in ${trackerName(p.tracker)}` : ''} start here.</p>
      <details><summary>pipeline.json</summary><pre>{JSON.stringify(p, null, 2)}</pre></details>
    </aside>
  );
}

function Path({ e, at, o }: { e: PipelineEdge; at: Map<string, { x: number; y: number }>; o: RunOverlay | null }) {
  const a = at.get(e.from), b = at.get(e.to);
  if (!a || !b) return null;
  if (e.loop) { // over the top, from the gate back to an earlier step; with a run shown, how often it went back
    const x1 = a.x + W / 2, x2 = b.x + W / 2, top = Math.min(a.y, b.y) - 20 - (x1 - x2) / 40, n = o?.loops[e.to] ?? 0;
    return (
      <g>
        <path d={`M${x1},${a.y} C${x1},${top} ${x2},${top} ${x2},${b.y}`} data-loop data-on={n ? true : undefined} markerEnd={`url(#sf-pl-arrow${n ? '-on' : ''})`} />
        {n ? <g className="sf-pl-pill"><rect x={x2 + 6} y={b.y - 26} width={28} height={18} rx={9} /><text x={x2 + 20} y={b.y - 13} textAnchor="middle">×{n}</text></g> : null /* beside the step it went back to, clear of the nodes */}
      </g>
    );
  }
  const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, m = (x1 + x2) / 2, on = !!o?.taken.includes(`${e.from}>${e.to}`);
  return (
    <g>
      <path d={`M${x1},${y1} C${m},${y1} ${m},${y2} ${x2 - 2},${y2}`} data-on={on || undefined} markerEnd={`url(#sf-pl-arrow${on ? '-on' : ''})`} />
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
