// The Pipelines graph, generated from F's pipeline (packages/core/src/skills.ts pipeline()): F owns the steps, their order,
// what is locked, intake's outcomes and the gate's loop-backs; this file only names them and lays them out. The shapes are
// declared here, so the design system imports nothing from core or the dashboard.

/** A step's runner in skills.json (core's checkRunner). Extra axes add `axis` and `when`. */
export interface StepRunner { use?: string; name?: string; path?: string; harness?: string; model?: string; effort?: string; fallback?: string[]; axis?: string; when?: string[] }
/** A pipeline as F resolves it (core's skills.ts pipeline()): the graph draws only this. */
export interface Pipeline {
  host: string | null; tracker: string | null; locked: string[]; optional: string[]; steps: string[]; intake: string[]; loops: string[];
  axes: { axis: string; when: string | string[] }[]; off: string[]; custom: Record<string, StepRunner[]>; warnings: string[];
  /** The user's own steps, each slot run before its built-in stage. Provisional: core has no `F pipelines set` yet. */
  beforeSpec?: StepSlot; beforeBuild?: StepSlot; beforeReview?: StepSlot; beforeMerge?: StepSlot;
}
/** One of the user's steps: a subagent step, a shell check or a person's approval. `next` maps each outcome to another step
 *  in the slot, the slot's own stage (go on), spec or build before it (a loop-back, under the gate's cap) or `escalate`. */
export interface UserStep { id: string; kind: UserStepKind; label?: string; run?: string; next: Record<string, string> }
export type UserStepKind = 'step' | 'check' | 'human';
export interface StepSlot { first: string; steps: UserStep[] }
export const SLOTS = { beforeSpec: 'spec', beforeBuild: 'build', beforeReview: 'review', beforeMerge: 'merge' } as const;
export type SlotName = keyof typeof SLOTS;
/** The outcomes each kind of step ends with; every one needs a `next`. */
export const STEP_OUTCOMES: Record<UserStepKind, string[]> = { step: ['passed', 'failed'], check: ['passed', 'failed'], human: ['approved', 'rejected'] };
export const USER_KIND: Record<UserStepKind, string> = { step: 'subagent step', check: 'shell check', human: 'your approval' };
const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const userNode = (id: string) => `user:${id}`;
/** Where a slot's step may send the run, in the order the editor offers them. */
export function slotTargets(p: Pipeline, slot: SlotName) {
  const stage = SLOTS[slot], at = p.steps.indexOf(stage);
  return { stage, back: ['spec', 'build'].filter((s) => s !== stage && p.steps.indexOf(s) >= 0 && p.steps.indexOf(s) < at) };
}
/** What is wrong with the user's steps, as messages; none means the graph and F agree on every branch. */
export function slotProblems(p: Pipeline): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const slot of Object.keys(SLOTS) as SlotName[]) {
    const sl = p[slot];
    if (!sl) continue;
    const name = slotLabel(slot), ids = new Set(sl.steps.map((x) => x.id)), { stage, back } = slotTargets(p, slot);
    if (!p.steps.includes(stage)) out.push(`${name}: this pipeline has no ${stage} step`);
    if (!ids.has(sl.first)) out.push(`${name}: the first step “${sl.first}” isn’t one of its steps`);
    for (const st of sl.steps) {
      if (!USER_ID.test(st.id)) out.push(`${name}: “${st.id}” must be lowercase letters, digits and dashes`);
      if (seen.has(st.id)) out.push(`${name}: “${st.id}” is used twice`);
      seen.add(st.id);
      if (st.kind === 'check' && !st.run?.trim()) out.push(`${name}: the check “${st.id}” has no command`);
      for (const o of STEP_OUTCOMES[st.kind] ?? []) {
        const t = st.next[o];
        if (!t) out.push(`${name}: “${st.id}” has nowhere to go when ${o}`);
        else if (t !== stage && t !== 'escalate' && !back.includes(t) && !ids.has(t)) out.push(`${name}: “${st.id}” can’t go to “${t}” when ${o}`);
      }
    }
    // Steps in a slot only go forward: a retry loops back to spec or build, where the gate's cap counts it.
    const state: Record<string, 1 | 2> = {}, by = new Map(sl.steps.map((x) => [x.id, x]));
    const visit = (id: string): boolean => {
      if (state[id] === 2) return false;
      if (state[id] === 1) return true;
      state[id] = 1;
      const cyc = Object.values(by.get(id)?.next ?? {}).some((t) => ids.has(t) && visit(t));
      state[id] = 2;
      return cyc;
    };
    if (sl.steps.some((x) => visit(x.id))) out.push(`${name}: its steps go round in a circle; loop back to spec or build instead`);
  }
  return out;
}
export const slotLabel = (slot: SlotName) => `Before ${SLOTS[slot]}`;
export interface PipelineNode { id: string; label: string; sub?: string; locked: boolean; runner?: StepRunner; col: number; row: number; kind: 'step' | 'outcome' | 'review' | 'start' | 'user'; step?: UserStep; slot?: SlotName }
export interface PipelineEdge { from: string; to: string; label?: string; loop?: boolean }

const LABEL: Record<string, string> = { review: 'Review', intake: 'Intake', spec: 'Spec', build: 'Build', verifier: 'Verifier', postmerge: 'Post-merge', gate: 'Gate', merge: 'Merge', watch: 'Watch main' };
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

const SLOT_OF = Object.fromEntries(Object.entries(SLOTS).map(([k, v]) => [v, k as SlotName])) as Record<string, SlotName | undefined>;

export function pipelineGraph(p: Pipeline, plan: Record<string, StepRunner> = {}) {
  const nodes: Omit<PipelineNode, 'col' | 'row'>[] = [], edges: PipelineEdge[] = [], locked = new Set(p.locked);
  const add = (id: string, label: string, kind: PipelineNode["kind"], sub?: string, step = id) => nodes.push({ id, label, kind, locked: locked.has(step), ...(sub && { sub }), ...(plan[step] && { runner: plan[step] }) });
  add('ready', 'Issue ready', 'start', trackerName(p.tracker) ?? 'no tracker yet');
  let prev: { from: string; label?: string }[] = [{ from: 'ready' }]; // what leads into the next step, and on which outcome
  const into = (to: string[]) => { for (const t of to) for (const f of prev) edges.push({ from: f.from, to: t, ...(f.label && { label: f.label }) }); };
  for (const s of p.steps) {
    const slot = SLOT_OF[s], sl = slot && p[slot];
    if (slot && sl) { // the user's steps before this stage: each outcome goes to a step, on to the stage, back, or to a person
      const ids = new Set(sl.steps.map((x) => x.id)), { back } = slotTargets(p, slot), out: typeof prev = [];
      for (const st of sl.steps) { add(userNode(st.id), st.label || st.id, 'user', USER_KIND[st.kind] ?? st.kind); Object.assign(nodes.at(-1)!, { step: st, slot }); }
      if (ids.has(sl.first)) into([userNode(sl.first)]);
      for (const st of sl.steps) {
        const to = new Map<string, string[]>(), from = userNode(st.id);
        for (const [o, t] of Object.entries(st.next)) to.set(t, [...(to.get(t) ?? []), o]); // two outcomes to one place: one edge
        for (const [t, os] of to) {
          const label = os.join(', ');
          if (t === s) out.push({ from, label });
          else if (ids.has(t)) edges.push({ from, to: userNode(t), label });
          else if (t === 'escalate') { if (!nodes.some((n) => n.id === 'escalate')) add('escalate', 'Escalate to you', 'outcome'); edges.push({ from, to: 'escalate', label }); }
          else if (back.includes(t)) edges.push({ from, to: t, label, loop: true });
        }
      }
      prev = out;
    }
    if (s === 'review') {
      const axes = p.axes.filter((a) => !p.off.includes(`review.${a.axis}`));
      for (const a of axes) add(`review.${a.axis}`, nodeLabel(`review.${a.axis}`), 'review', whenText(a.when));
      into(axes.map((a) => `review.${a.axis}`));
      prev = axes.map((a) => ({ from: `review.${a.axis}` }));
      continue;
    }
    add(s, nodeLabel(s), 'step', SUB[s]);
    into([s]);
    prev = [{ from: s, ...(s === 'intake' && { label: 'pass' }) }];
    if (s === 'intake') for (const o of p.intake.filter((x) => x !== 'pass')) {
      const [id, label] = OUTCOME[o] ?? [o, o];
      add(id, label, 'outcome');
      edges.push({ from: 'intake', to: id, label: o });
    }
  }
  const watch = nodes.find((n) => n.id === 'watch'); // the watch step's own extra check: the postmerge runner, when one is set
  if (watch && plan.postmerge && plan.postmerge.use && plan.postmerge.use !== 'default') watch.runner = plan.postmerge;
  for (const to of p.loops) edges.push({ from: 'gate', to, loop: true });
  // Columns by longest path from the start, loop-backs ignored. A user step may point at one declared after it, so repeat
  // until nothing moves (bounded: slotProblems refuses a circle, and a bad pipeline still draws).
  const col: Record<string, number> = { ready: 0 };
  for (let i = 0, moved = true; moved && i <= nodes.length; i++) {
    moved = false;
    for (const e of edges) if (!e.loop && (col[e.from] ?? 0) + 1 > (col[e.to] ?? 0)) { col[e.to] = (col[e.from] ?? 0) + 1; moved = true; }
  }
  const rows: Record<number, number> = {};
  const placed: PipelineNode[] = nodes.map((n) => { const c = col[n.id] ?? 0; return { ...n, col: c, row: (rows[c] = (rows[c] ?? -1) + 1) }; });
  return { nodes: placed, edges };
}

// ---- a run drawn on its pipeline ----
export type StepStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'running';
export const STEP_STATUS: Record<StepStatus, string> = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', pending: 'Not reached', running: 'Running' };
/** One step's latest result in a run. `review`: a review axis's verdict, with findings outranking the status word as in F. */
export interface StepResult { status: StepStatus; note?: string; tokens?: number; ms?: number; review?: { verdict: 'passed' | 'failed'; findings: number; blocking: number; dismissed: number } }
/** The few event fields the overlay reads (core's FactoryEvent): nothing else of an event reaches the page. */
export interface StepEvent { ts?: string; stage?: string; status?: string; axis?: string; axes?: string[]; role?: string; next?: string; step?: string; tokens?: number; findings?: { severity?: string; dismissed?: unknown }[] }
/** Steps by node id, the forward edges the run took (`from>to`), how often the run looped back to each step, and along
 *  which loop-back edge (`from>to`: the gate's, or a user step's). */
export interface RunOverlay { steps: Record<string, StepResult>; taken: string[]; loops: Record<string, number>; back: Record<string, number> }

const OUTCOME_NODE: Record<string, string> = { split: 'children', 'needs-info': 'ask', rejected: 'close' };
const BAD = new Set(['failed', 'rejected']);
const ENDED = new Set(['merged', 'escalated', 'rejected', 'closed', 'split']);
const blocks = (f: { severity?: string; dismissed?: unknown }) => (f.severity === 'high' || f.severity === 'medium') && !f.dismissed;

/**
 * Each step's status in one run, from its events alone. A step shows its latest attempt: `build started` begins an
 * iteration and resets every step after build, and a gate loop-back puts its target back to running. The path and the
 * loop counts cover the whole run.
 */
export function runOverlay({ nodes, edges }: { nodes: PipelineNode[]; edges: PipelineEdge[] }, events: StepEvent[]): RunOverlay {
  const byId = new Map(nodes.map((n) => [n.id, n])), ids = new Set(byId.keys()), chose = new Set<string>(), back: Record<string, number> = {}, steps: Record<string, StepResult> = {}, reached = new Set<string>(), loops: Record<string, number> = {};
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
  let ended = false, blocking = 0; // blocking: this iteration's undismissed high and medium findings, so the verifier had work
  for (const e of events) {
    const { stage, status = '' } = e;
    if (!['intake', 'spec', 'build', 'review', 'gate', 'approve', 'step'].includes(stage ?? '')) continue; // notes, deploys, rules: not steps
    if (!steps.ready) put('ready', 'passed');
    ended = (stage !== 'step' && ENDED.has(status)) || (ended && !(stage === 'intake' && status === 'started')); // a person's step may end "rejected"
    const loop = (from: string, to: string, by: string) => {
      loops[to] = (loops[to] ?? 0) + 1; back[`${from}>${to}`] = (back[`${from}>${to}`] ?? 0) + 1;
      put(to, 'running', { note: `sent back by ${by}` }); delete since[to];
    };
    if (stage === 'intake' || stage === 'spec') {
      if (status === 'started') begin(stage, e);
      else if (status === 'awaiting-approval') put(stage, 'running', { note: 'waiting for approval' });
      else end(stage, e, status === 'failed' ? 'failed' : 'passed', OUTCOME_NODE[status] || status === 'closed' ? { note: status } : {});
      if (OUTCOME_NODE[status]) put(OUTCOME_NODE[status]!, 'passed');
    } else if (stage === 'build') {
      if (status === 'started') { for (const id of after) { delete steps[id]; delete since[id]; } blocking = 0; begin('build', e); }
      else end('build', e, status === 'failed' ? 'failed' : 'passed');
    } else if (stage === 'step' && e.step) { // provisional: a user step's events are {stage: 'step', step: id, status: started | its outcome}
      const id = userNode(e.step), n = byId.get(id), t = n?.step?.next[status];
      if (status === 'started') { begin(id, e); continue; }
      end(id, e, BAD.has(status) ? 'failed' : 'passed', status === 'passed' || status === 'failed' ? {} : { note: status });
      if (!n?.slot || !t) continue;
      if (t === 'escalate') { put('escalate', 'passed'); chose.add(`${id}>escalate`); }
      else if (t === SLOTS[n.slot]) for (const x of edges) { if (x.from === id && !x.loop && byId.get(x.to)?.kind !== 'user' && x.to !== 'escalate') chose.add(`${id}>${x.to}`); }
      else if (byId.has(userNode(t))) chose.add(`${id}>${userNode(t)}`);
      else if (t === 'spec' || t === 'build') loop(id, t, n.label);
    } else if (stage === 'review' && status === 'started') {
      for (const n of nodes) if (n.kind === 'review') (e.axes ?? []).includes(n.id.slice(7)) ? begin(n.id, e) : put(n.id, 'skipped');
    } else if (stage === 'review' && e.axis) {
      const fs = e.findings ?? [], n = fs.filter(blocks).length, verdict = n ? 'failed' : 'passed';
      blocking += n;
      end(`review.${e.axis}`, e, verdict, { review: { verdict, findings: fs.length, blocking: n, dismissed: fs.filter((f) => f.dismissed).length } });
    } else if (stage === 'review' && e.role === 'verifier') end('verifier', e, 'passed');
    else if (stage === 'gate') {
      if (!steps.verifier && ids.has('verifier')) { put('verifier', 'skipped', { note: blocking ? 'no record' : 'nothing blocking to verify' }); reached.add('verifier'); } // the run went through it
      const to = e.next === 'spec' || e.next === 'build' ? e.next : '';
      put('gate', status === 'passed' ? 'passed' : 'failed', status === 'passed' ? {} : { note: to ? `back to ${to}` : 'to you' });
      if (to) loop('gate', to, 'the gate');
    } else if (stage === 'approve') {
      if (status === 'reverted') put('watch', 'failed', { note: 'reverted' });
      else if (status === 'merged') put('merge', 'passed');
      else if (status === 'escalated' && steps.escalate?.status === 'passed') continue; // a user step handed it over, not the merge
      else if (status === 'escalated' || status === 'closed') put('merge', 'failed', { note: status === 'escalated' ? 'escalated to you' : 'closed' });
      else if (status === 'decided') put('merge', 'running');
    }
  }
  for (const n of nodes) {
    const s = steps[n.id];
    if (!s || (ended && s.status === 'running')) steps[n.id] = { status: 'pending' }; // a finished run has nothing running
  }
  const took = (x: PipelineEdge) => !x.loop && reached.has(x.from) && reached.has(x.to) && (byId.get(x.from)?.kind !== 'user' || chose.has(`${x.from}>${x.to}`)); // a user step: only the branch its outcome took
  return { steps, taken: edges.filter(took).map((x) => `${x.from}>${x.to}`), loops, back };
}
