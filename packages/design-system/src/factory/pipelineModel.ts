// The Pipelines graph, generated from F's pipeline (packages/core/src/skills.ts pipeline()): F owns the steps, their order,
// what is locked, intake's outcomes and the gate's loop-backs; this file only names them and lays them out. The shapes are
// declared here, so the design system imports nothing from core or the dashboard.

/** A step's runner in skills.json (core's checkRunner). Extra axes add `axis` and `when`. */
export interface StepRunner { use?: string; name?: string; path?: string; harness?: string; model?: string; effort?: string; fallback?: string[]; axis?: string; when?: string[] }
/** A pipeline as F resolves it (core's skills.ts pipeline()): the graph draws only this. */
export interface Pipeline {
  host: string | null; tracker: string | null; locked: string[]; optional: string[]; steps: string[]; intake: string[]; loops: string[];
  axes: { axis: string; when: string | string[] }[]; off: string[]; custom: Record<string, StepRunner[]>; warnings: string[];
}
export interface PipelineNode { id: string; label: string; sub?: string; locked: boolean; runner?: StepRunner; col: number; row: number; kind: 'step' | 'outcome' | 'review' | 'start' }
export interface PipelineEdge { from: string; to: string; label?: string; loop?: boolean }

const LABEL: Record<string, string> = { intake: 'Intake', spec: 'Spec', build: 'Build', verifier: 'Verifier', postmerge: 'Post-merge', gate: 'Gate', merge: 'Merge', watch: 'Watch main' };
const OUTCOME: Record<string, [id: string, label: string]> = { split: ['children', 'Child issues'], 'needs-info': ['ask', 'Ask questions'], reject: ['close', 'Comment & close'] };
const WHEN: Record<string, string> = { always: 'every change', ui: 'when UI files change', seo: 'when SEO files change', docs: 'when docs change' };
const SUB: Record<string, string> = { spec: 'risky specs wait for approval', gate: 'loops back on blocking findings', merge: 'or escalates to you', watch: 'main’s CI after the merge' };
const UPPER = new Set(['ux', 'ui', 'seo']);
/** A step key as the graph names it: review.ui → "UI review", gate → "Gate". */
export const nodeLabel = (k: string) => k.startsWith('review.')
  ? `${UPPER.has(k.slice(7)) ? k.slice(7).toUpperCase() : k[7]!.toUpperCase() + k.slice(8)} review` : LABEL[k] ?? k;
export const whenText = (w: string | string[]) => (Array.isArray(w) ? `when ${w.join(', ')} change` : WHEN[w] ?? w);
/** A tracker id as people say it: github-issues → GitHub Issues. */
export const trackerName = (t: string | null) => (t ? t.split('-').map((x) => (x === 'github' ? 'GitHub' : x[0]!.toUpperCase() + x.slice(1))).join(' ') : null);

export function pipelineGraph(p: Pipeline, plan: Record<string, StepRunner> = {}) {
  const nodes: Omit<PipelineNode, 'col' | 'row'>[] = [], edges: PipelineEdge[] = [], locked = new Set(p.locked);
  const add = (id: string, label: string, kind: PipelineNode["kind"], sub?: string, step = id) => nodes.push({ id, label, kind, locked: locked.has(step), ...(sub && { sub }), ...(plan[step] && { runner: plan[step] }) });
  add('ready', 'Issue ready', 'start', trackerName(p.tracker) ?? 'no tracker yet');
  edges.push({ from: 'ready', to: p.steps[0]! });
  let prev: string[] = [];
  for (const s of p.steps) {
    if (s === 'review') {
      const axes = p.axes.filter((a) => !p.off.includes(`review.${a.axis}`));
      for (const a of axes) add(`review.${a.axis}`, nodeLabel(`review.${a.axis}`), 'review', whenText(a.when));
      for (const a of axes) for (const f of prev) edges.push({ from: f, to: `review.${a.axis}` });
      prev = axes.map((a) => `review.${a.axis}`);
      continue;
    }
    add(s, nodeLabel(s), 'step', SUB[s]);
    for (const f of prev) edges.push({ from: f, to: s, ...(f === 'intake' && { label: 'pass' }) });
    prev = [s];
    if (s === 'intake') for (const o of p.intake.filter((x) => x !== 'pass')) {
      const [id, label] = OUTCOME[o] ?? [o, o];
      add(id, label, 'outcome');
      edges.push({ from: 'intake', to: id, label: o });
    }
  }
  const watch = nodes.find((n) => n.id === 'watch'); // the watch step's own extra check: the postmerge runner, when one is set
  if (watch && plan.postmerge && plan.postmerge.use && plan.postmerge.use !== 'default') watch.runner = plan.postmerge;
  for (const to of p.loops) edges.push({ from: 'gate', to, loop: true });
  // Columns by longest path from the start, loop-backs ignored. Forward edges are pushed in step order, so one pass does.
  const col: Record<string, number> = { ready: 0 };
  for (const e of edges) if (!e.loop) col[e.to] = Math.max(col[e.to] ?? 0, (col[e.from] ?? 0) + 1);
  const rows: Record<number, number> = {};
  const placed: PipelineNode[] = nodes.map((n) => { const c = col[n.id] ?? 0; return { ...n, col: c, row: (rows[c] = (rows[c] ?? -1) + 1) }; });
  return { nodes: placed, edges };
}
