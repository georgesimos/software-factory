import { COST_CAP, FINDING_KEYS, OUTCOMES, REVIEW_KEYS, SEVERITIES, TOKEN_CAP, USAGE_KEYS, blocking, costOf } from './constants.ts';
import { PROJECT_EVENTS } from './project.ts';
import { read, readArchive } from './log.ts';
import { withMeasured } from './burn.ts';
import type { Burn, BurnCell, Deploy, FactoryEvent, Outcome, Run, Session } from './types.ts';

// A run while derive() builds it: deploys keyed by connector/env until the end, and the clock fields set by its first event.
type Draft = Omit<Run, 'deploys' | 'stage' | 'status' | 'started' | 'updated' | 'durationMs'> & Partial<Pick<Run, 'stage' | 'status' | 'started' | 'updated' | 'durationMs'>> & { deploys?: Record<string, Deploy> | Deploy[] };

// Token numbers come from model-typed payloads: only non-negative numbers and a short model id get stored. `tokens` becomes the usage sum.
export function validateUsage<P extends Partial<FactoryEvent>>(p: P): P {
  const u: unknown = p.usage;
  if (u !== undefined) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) throw new Error('usage must be an object');
    const bad = Object.keys(u).filter((k) => !USAGE_KEYS.includes(k));
    if (bad.length) throw new Error(`usage has unknown fields: ${bad.join(', ')} (${USAGE_KEYS.join('|')})`);
    for (const [k, v] of Object.entries(u)) if (!Number.isSafeInteger(v) || (v as number) < 0) throw new Error(`usage.${k} must be a non-negative integer`);
  }
  if (p.model !== undefined && !(typeof p.model === 'string' && /^[\w.:[\]-]{1,64}$/.test(p.model))) throw new Error('model must be a short model id');
  for (const k of ['tokens', 'costUsd']) if (p[k] !== undefined && !(typeof p[k] === 'number' && Number.isFinite(p[k]) && (p[k] as number) >= 0)) throw new Error(`${k} must be a non-negative number`);
  return u ? { ...p, tokens: Object.values(u as Record<string, number>).reduce((s, n) => s + n, 0) } : p;
}
// Burn cells: tokens, dollars where the model is priced, cache reads (cheap; left out of the token cap) and unpriced tokens.
// models: tokens per model id without cache reads, i.e. what served the step; subModels: the same from subagent rows only
export const cell = (): BurnCell & { costUsd: number } => ({ tokens: 0, costUsd: 0, cacheRead: 0, unpriced: 0, models: {}, subModels: {} });
export const burnOf = (): Burn => ({ measured: false, total: cell(), byStage: {}, byIteration: {}, byAxis: {} });
export function addBurn(b: Burn, { stage, iteration, axis }: { stage: string; iteration: number; axis?: string | null }, tokens: number, usd: number | null, cacheRead = 0, model: string | null | undefined = null, sub = false) {
  const served = Math.max(0, tokens - cacheRead);
  for (const c of [b.total, (b.byStage[stage] ??= cell()), (b.byIteration[iteration] ??= cell()), axis ? (b.byAxis[axis] ??= cell()) : null]) {
    if (!c) continue;
    c.tokens += tokens; c.cacheRead += cacheRead;
    if (model) for (const m of sub ? [c.models, c.subModels] : [c.models]) m[model] = (m[model] || 0) + served;
    if (usd == null) c.unpriced += tokens; else (c.costUsd as number) += usd; // a number until finishBurn()
  }
}
const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
const served = (m: Record<string, number>) => Object.values(m).reduce((s, n) => s + n, 0);
export const finishBurn = (b: Burn) => {
  for (const c of [b.total, ...[b.byStage, b.byIteration, b.byAxis].flatMap(Object.values)]) {
    c.costUsd = c.unpriced && !c.costUsd ? null : +(c.costUsd as number).toFixed(4);
    // The model that served the step: its subagent's when subagents did most of the work (a step run in one), else the
    // top model overall, so a small helper subagent in a session-run step doesn't count as the step's model.
    c.used = top(served(c.subModels) * 2 > served(c.models) ? c.subModels : c.models);
  }
  return b;
};
// A recorded verdict is final: only F's own "invalid" placeholder can be replaced, and nothing once the iteration is gated.
export const INVALID = 'reviewer output invalid: ';
export function assertReviewOpen(r: Run, axis: string) {
  if (r.events.findLast((e) => e.stage === 'gate' || (e.stage === 'build' && e.status === 'started'))?.stage === 'gate') throw new Error(`iteration ${r.iteration} is already gated; its reviews are frozen`);
  const prev = r.reviews[r.iteration]?.[axis];
  if (prev && !prev.findings.some((f) => f.issue?.startsWith(INVALID))) throw new Error(`a ${prev.verdict} "${axis}" review is already recorded for iteration ${r.iteration}; only an invalid one can be replaced`);
}
// Reviewer output is untrusted model text: reject anything outside the contract instead of storing it.
export function validateReview(run: string, p: Partial<FactoryEvent>, status: string) {
  const extra = Object.keys(p).filter((k) => !REVIEW_KEYS.includes(k));
  if (extra.length) throw new Error(`review payload has unknown fields: ${extra.join(', ')}`);
  const r = derive(read())[run];
  const axes = r?.axes?.[r.iteration] || [];
  if (!axes.includes(p.axis as string)) throw new Error(`axis "${p.axis}" is not one of this iteration's axes (${axes.join(', ') || 'none recorded'})`);
  assertReviewOpen(r as Run, p.axis as string); // axes.includes(): both are set
  if (!Array.isArray(p.findings || [])) throw new Error('findings must be an array');
  for (const f of p.findings || []) {
    const bad = Object.keys(f).filter((k) => !FINDING_KEYS.includes(k));
    if (bad.length) throw new Error(`finding has unknown fields: ${bad.join(', ')}`);
    if (!SEVERITIES.includes(f.severity)) throw new Error(`finding severity must be ${SEVERITIES.join('|')}`);
    if (!['spec', 'build'].includes(f.route as string)) throw new Error('finding route must be spec|build');
    if (typeof f.issue !== 'string' || !f.issue) throw new Error('finding needs an issue sentence');
  }
  if (status === 'failed' && !(p.findings || []).some(blocking)) throw new Error('a failed review needs at least one undismissed high or medium finding (record "passed" if the verifier dismissed them all)');
}
export function derive(events: FactoryEvent[]): Record<string, Run> {
  const runs: Record<string, Draft> = {};
  for (const e of events) {
    if (e.stage === 'rules' || PROJECT_EVENTS[e.stage]) continue; // rule changes (an audit trail) and idea-to-app project events: not runs
    if (e.stage === 'ship') { // deploy state, typed by a connector: the latest per connector and env. Never moves the run's stage, url, clock or outcome.
      const r = runs[e.run];
      if (r) ((r.deploys ??= {}) as Record<string, Deploy>)[`${e.connector}/${e.env}`] = { connector: e.connector, kind: e.kind, env: e.env, state: e.state, status: e.status, url: e.url, sha: e.sha, at: e.at, detail: e.detail, creator: e.creator, ts: e.ts };
      continue;
    }
    if (e.stage === 'note') { // the user's one-shot instruction for a step ("F note" / "F notes"): on the timeline, never moves the run's stage, clock or outcome
      const r = Object.hasOwn(runs, e.run) ? runs[e.run] : undefined; // a hand-edited "__proto__" note can't break derive()
      if (r) r.events.push(e);
      if (r && e.status === 'pending') (r.notes ??= []).push({ id: e.id, step: e.step, text: e.text, by: e.by, ...(e.via && { via: e.via }), ts: e.ts, state: 'pending' });
      if (r && e.status === 'applied') for (const n of r.notes || []) if (e.notes?.includes(n.id as string) && n.state === 'pending') Object.assign(n, { state: 'applied', appliedTo: n.step === 'next' ? e.steps : [n.step], appliedAt: e.ts, claim: e.claim }); // the first claim in the log wins
      continue;
    }
    const r = (runs[e.run] ??= { id: e.run, iteration: 0, reviews: {}, loopbacks: [], events: [], outcome: 'in-progress' });
    r.events.push(e);
    Object.assign(r, { stage: e.stage, status: e.status, updated: e.ts });
    r.started ??= e.ts;
    if (e.stage === 'intake' && e.status === 'started' && (r.reverted || r.outcome === 'merged' || r.outcome === 'closed')) { delete r.pr; delete r.branch; } // a new run: never the old, finished change request
    for (const k of ['title', 'url', ...(e.status === 'reverted' ? [] : ['pr']), 'branch', 'spec', 'issues', 'children']) if (e[k]) (r as Record<string, unknown>)[k] = e[k];
    if (e.stage === 'intake' && e.status === 'started') for (const k of ['author', 'association', 'source', 'imported', 'origin', 'originAssociation']) if (e[k]) (r as Record<string, unknown>)[k] = e[k];
    if (e.sessionId && !(r.sessions ||= []).some((x) => x.id === e.sessionId)) r.sessions.push({ agent: e.harness, id: e.sessionId, cwd: e.cwd, last: e.ts, ...(e.hostSessionId && { hostId: e.hostSessionId }) });
    else if (e.sessionId) { // found: pushed above when new
      const x = (r.sessions as Session[]).find((y) => y.id === e.sessionId) as Session;
      x.last = e.ts; if (e.hostSessionId) x.hostId = e.hostSessionId;
    }
    if (e.costUsd) r.costUsd = +((r.costUsd || 0) + e.costUsd).toFixed(4);
    if (e.tokens) r.tokens = (r.tokens || 0) + e.tokens;
    if (e.stage === 'intake' && e.status === 'started') { r.outcome = 'in-progress'; delete r.humanMerge; delete r.reverted; } // resume after needs-info, or a new run after a revert
    if (r.outcome === 'awaiting-approval' && e.stage === 'spec' && e.status === 'passed') r.outcome = 'in-progress'; // only the spec passing ends the wait
    if (e.status === 'reverted') r.reverted = { pr: e.pr, reason: e.reason };
    if (e.stage === 'build' && e.status === 'started') r.iteration++;
    if (e.tokens || e.costUsd) { // reported: what the orchestrator copied from a subagent result
      const u = e.usage || {};
      const usd = e.costUsd ?? (e.usage ? costOf(e.model, [u.input || 0, u.output || 0, u.cacheRead || 0, 0, u.cacheWrite || 0]) : null); // shortcut: reported cache writes priced at the 1h rate Claude Code uses
      addBurn((r.burn ??= burnOf()), { stage: e.stage, iteration: r.iteration, axis: e.axis || e.role }, e.tokens || 0, usd, u.cacheRead || 0, e.model, true); // a subagent's result
    }
    if (e.stage === 'build' && e.localChecks) r.localChecks = e.localChecks; // only "F checks" records it
    if (e.stage === 'review' && e.status === 'started') { r.axes = { ...r.axes, [r.iteration]: e.axes as string[] }; if (e.sha) r.reviewedSha = e.sha; }
    if (e.stage === 'review' && e.axis) {
      const findings = e.findings || [];
      const verdict = findings.some(blocking) ? 'failed' : 'passed'; // findings outrank the verdict word
      (r.reviews[r.iteration] ??= {})[e.axis] = { verdict, findings, ...(e.runner && { runner: e.runner }) };
    }
    if (e.stage !== 'review' && (e.runner || r.runners?.[e.stage])) (r.runners ??= {})[e.stage] = e.runner; // latest event of the stage wins
    if (e.stage === 'gate' && ['spec', 'build'].includes(e.next as string)) r.loopbacks.push({ iteration: r.iteration, route: e.next, reasons: e.reasons, ts: e.ts });
    if (e.stage === 'approve' && e.status === 'decided') r.decision = { action: e.action, reasons: e.reasons };
    if (e.stage === 'approve' && e.status === 'merged' && e.by === 'human') r.humanMerge = { by: e.mergedBy, sha: e.sha, ts: e.ts }; // only sync records it
    if (OUTCOMES.includes(e.status)) r.outcome = e.status as Outcome;
  }
  for (const r of Object.values(runs)) {
    r.durationMs = Date.parse(r.updated as string) - Date.parse(r.started as string); // set by every run's first event
    if (r.burn) finishBurn(r.burn);
    if (r.deploys) r.deploys = Object.values(r.deploys);
    for (const c of r.children || []) if (runs[c]) (runs[c] as Draft).parent = r.id;
  }
  return runs as Record<string, Run>; // every draft now has its clock fields and a deploys list
}
// Live runs (with measured burn) over archived summaries, by id.
export const allRuns = (events = read()): Record<string, Run> => ({ ...Object.fromEntries(readArchive().map((a) => [a.id, a])), ...withMeasured(derive(events), events) });
export const getRun = (run: string): Run => {
  const events = read();
  const r = withMeasured(derive(events), events)[run] || readArchive().find((a) => a.id === run);
  if (!r) throw new Error(`no run ${run}`);
  return r;
};
// Measured dollars, when known, are the whole budget; otherwise the old rule on reported dollars and non-cache-read tokens.
export function budget(r: Run, cap = COST_CAP) { // cap: the run.budgetUsd rule's, when lower (gate.ts)
  const m = r.burn?.measured ? r.burn.total : null;
  const priced = m?.costUsd != null;
  const usd = priced ? ((m as BurnCell).costUsd as number) : r.costUsd || 0; // priced: m is set and its costUsd a number
  const tokens = m ? m.tokens - m.cacheRead : r.tokens || 0;
  return { over: usd > cap || (!priced && tokens > TOKEN_CAP), usd: +usd.toFixed(2), tokens, source: m ? 'measured' : 'reported' };
}
export const budgetWhy = (b: { usd: number; tokens: number; source: string }) => `($${b.usd}, ${b.tokens} tokens, ${b.source})`;
