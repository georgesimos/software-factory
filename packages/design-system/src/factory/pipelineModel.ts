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

// ---- a run drawn on its pipeline ----
export type StepStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'running' | 'stopped';
export const STEP_STATUS: Record<StepStatus, string> = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', pending: 'Not reached', running: 'Running', stopped: 'Stopped' };
/** One step's latest result in a run. `review`: a review axis's verdict, with findings outranking the status word as in F. */
export interface StepResult { status: StepStatus; note?: string; tokens?: number; ms?: number; review?: { verdict: 'passed' | 'failed'; findings: number; blocking: number; dismissed: number } }
/** The few event fields the overlay reads (core's FactoryEvent): nothing else of an event reaches the page. */
export interface StepEvent { ts?: string; stage?: string; status?: string; axis?: string; axes?: string[]; role?: string; next?: string; tokens?: number; findings?: { severity?: string; dismissed?: unknown }[] }
/** Steps by node id, the forward edges the run took (`from>to`), and how often the gate looped back to each step. */
export interface RunOverlay { steps: Record<string, StepResult>; taken: string[]; loops: Record<string, number> }

const OUTCOME_NODE: Record<string, string> = { split: 'children', 'needs-info': 'ask', rejected: 'close' };
const WAITING: Record<string, string> = { 'awaiting-approval': 'waiting for approval', decided: 'approved by a person', 'needs-info': 'waiting for answers' };
/** Only `passed` is passed: a failure or a refusal is failed, and anything else F records leaves the step running, named. */
const recorded = (status: string): [StepStatus, Omit<StepResult, 'status'>] =>
  status === 'passed' ? ['passed', {}] : ['failed', 'rejected', 'closed'].includes(status) ? ['failed', status === 'failed' ? {} : { note: status }] : ['running', { note: status }];
const ENDED = new Set(['merged', 'escalated', 'rejected', 'closed', 'split']);
const blocks = (f: { severity?: string; dismissed?: unknown }) => (f.severity === 'high' || f.severity === 'medium') && !f.dismissed;

/**
 * Each step's status in one run, from its events alone. A step shows its latest attempt: `build started` begins an
 * iteration and resets every step after build, and a gate loop-back puts its target back to running. The path and the
 * loop counts cover the whole run.
 */
export function runOverlay({ nodes, edges }: { nodes: PipelineNode[]; edges: PipelineEdge[] }, events: StepEvent[]): RunOverlay {
  const ids = new Set(nodes.map((n) => n.id)), steps: Record<string, StepResult> = {}, reached = new Set<string>(), loops: Record<string, number> = {};
  const after = new Set(nodes.filter((n) => n.col > (nodes.find((x) => x.id === 'build')?.col ?? Infinity)).map((n) => n.id));
  const since: Record<string, { ts?: string; tokens: number }> = {}; // the current attempt of each step: its start and its tokens so far
  const put = (id: string, status: StepStatus, x: Omit<StepResult, 'status'> = {}) => {
    if (!ids.has(id)) return;
    steps[id] = { status, ...x };
    if (status !== 'pending' && status !== 'skipped') reached.add(id);
  };
  const begin = (id: string, e: StepEvent) => { since[id] = { ts: e.ts, tokens: e.tokens ?? 0 }; put(id, 'running'); };
  const end = (id: string, e: StepEvent, status: StepStatus, x: Omit<StepResult, 'status'> = {}) => {
    const a = (since[id] ??= { tokens: 0 }); // a step may record twice (build's checks, then its PR): time and tokens run to the last
    a.tokens += e.tokens ?? 0;
    const ms = a.ts && e.ts ? Date.parse(e.ts) - Date.parse(a.ts) : NaN;
    put(id, status, { ...(a.tokens && { tokens: a.tokens }), ...(Number.isFinite(ms) && { ms }), ...x });
  };
  const reset = (xs: Iterable<string>) => { for (const id of xs) { delete steps[id]; delete since[id]; } };
  let ended = false, blocking = 0; // blocking: this iteration's undismissed high and medium findings, so the verifier had work
  for (const e of events) {
    const { stage, status = '' } = e;
    if (!['intake', 'spec', 'build', 'review', 'gate', 'approve'].includes(stage ?? '')) continue; // notes, deploys, rules: not steps
    if (!steps.ready) put('ready', 'passed');
    ended = ENDED.has(status) || (ended && !(stage === 'intake' && status === 'started'));
    if (stage === 'intake' || stage === 'spec') {
      if (status === 'started') begin(stage, e);
      else if (WAITING[status]) put(stage, 'running', { note: WAITING[status] });
      else if (status === 'split') end(stage, e, 'passed', { note: status }); // intake's own decision: the child issues carry the work
      else end(stage, e, ...recorded(status));
      if (OUTCOME_NODE[status]) put(OUTCOME_NODE[status]!, 'passed');
    } else if (stage === 'build') {
      if (status === 'started') { reset(after); blocking = 0; begin('build', e); }
      else if (status === 'opened') end('build', e, 'running', { note: 'change request open, CI pending' });
      else end('build', e, ...recorded(status));
    } else if (stage === 'review' && e.role === 'verifier') {
      if (status === 'started') begin('verifier', e); else end('verifier', e, ...recorded(status));
    } else if (stage === 'review' && status === 'started') {
      for (const n of nodes) if (n.kind === 'review') (e.axes ?? []).includes(n.id.slice(7)) ? begin(n.id, e) : put(n.id, 'skipped');
    } else if (stage === 'review' && e.axis) {
      const fs = e.findings ?? [], n = fs.filter(blocks).length, verdict = n ? 'failed' : 'passed';
      blocking += n;
      end(`review.${e.axis}`, e, verdict, { review: { verdict, findings: fs.length, blocking: n, dismissed: fs.filter((f) => f.dismissed).length } });
    } else if (stage === 'gate') {
      if (!steps.verifier && ids.has('verifier')) { put('verifier', 'skipped', { note: blocking ? 'no record' : 'nothing blocking to verify' }); reached.add('verifier'); } // the run went through it
      const back = e.next === 'spec' || e.next === 'build' ? e.next : '';
      put('gate', status === 'passed' ? 'passed' : 'failed', status === 'passed' ? {} : { note: back ? `back to ${back}` : 'to you' });
      if (back === 'spec') reset([...after, 'build']); // back before build: build and everything after it run again
      if (back) { loops[back] = (loops[back] ?? 0) + 1; put(back, 'running', { note: 'sent back by the gate' }); delete since[back]; }
    } else if (stage === 'approve') {
      if (status === 'reverted') put('watch', 'failed', { note: 'reverted' });
      else if (status === 'merged') put('merge', 'passed');
      else if (status === 'escalated' || status === 'closed') put('merge', 'failed', { note: status === 'escalated' ? 'escalated to you' : 'closed' });
      else if (status === 'decided') put('merge', 'running');
    }
  }
  for (const n of nodes) {
    const s = steps[n.id];
    if (!s) steps[n.id] = { status: 'pending' };
    else if (ended && s.status === 'running') steps[n.id] = { ...s, status: 'stopped' }; // the run ended while it waited: say where it stopped, never "not reached"
  }
  return { steps, taken: edges.filter((x) => !x.loop && reached.has(x.from) && reached.has(x.to)).map((x) => `${x.from}>${x.to}`), loops };
}
