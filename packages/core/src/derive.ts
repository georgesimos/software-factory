// @ts-nocheck
import { COST_CAP, FINDING_KEYS, OUTCOMES, REVIEW_KEYS, SEVERITIES, TOKEN_CAP, USAGE_KEYS, blocking, costOf } from './constants.ts';
import { PROJECT_EVENTS } from './project.ts';
import { read, readArchive } from './log.ts';
import { withMeasured } from './burn.ts';

// Token numbers come from model-typed payloads: only non-negative numbers and a short model id get stored. `tokens` becomes the usage sum.
export function validateUsage(p) {
  const u = p.usage;
  if (u !== undefined) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) throw new Error('usage must be an object');
    const bad = Object.keys(u).filter((k) => !USAGE_KEYS.includes(k));
    if (bad.length) throw new Error(`usage has unknown fields: ${bad.join(', ')} (${USAGE_KEYS.join('|')})`);
    for (const [k, v] of Object.entries(u)) if (!Number.isSafeInteger(v) || v < 0) throw new Error(`usage.${k} must be a non-negative integer`);
  }
  if (p.model !== undefined && !(typeof p.model === 'string' && /^[\w.:[\]-]{1,64}$/.test(p.model))) throw new Error('model must be a short model id');
  for (const k of ['tokens', 'costUsd']) if (p[k] !== undefined && !(typeof p[k] === 'number' && Number.isFinite(p[k]) && p[k] >= 0)) throw new Error(`${k} must be a non-negative number`);
  return u ? { ...p, tokens: Object.values(u).reduce((s, n) => s + n, 0) } : p;
}
// Burn cells: tokens, dollars where the model is priced, cache reads (cheap; left out of the token cap) and unpriced tokens.
// models: tokens per model id without cache reads, i.e. what served the step; subModels: the same from subagent rows only
export const cell = () => ({ tokens: 0, costUsd: 0, cacheRead: 0, unpriced: 0, models: {}, subModels: {} });
export const burnOf = () => ({ measured: false, total: cell(), byStage: {}, byIteration: {}, byAxis: {} });
export function addBurn(b, { stage, iteration, axis }, tokens, usd, cacheRead = 0, model = null, sub = false) {
  const served = Math.max(0, tokens - cacheRead);
  for (const c of [b.total, (b.byStage[stage] ??= cell()), (b.byIteration[iteration] ??= cell()), axis ? (b.byAxis[axis] ??= cell()) : null]) {
    if (!c) continue;
    c.tokens += tokens; c.cacheRead += cacheRead;
    if (model) for (const m of sub ? [c.models, c.subModels] : [c.models]) m[model] = (m[model] || 0) + served;
    if (usd == null) c.unpriced += tokens; else c.costUsd += usd;
  }
}
export const finishBurn = (b) => {
  for (const c of [b.total, ...[b.byStage, b.byIteration, b.byAxis].flatMap(Object.values)]) c.costUsd = c.unpriced && !c.costUsd ? null : +c.costUsd.toFixed(4);
  return b;
};
// A recorded verdict is final: only F's own "invalid" placeholder can be replaced, and nothing once the iteration is gated.
export const INVALID = 'reviewer output invalid: ';
export function assertReviewOpen(r, axis) {
  if (r.events.findLast((e) => e.stage === 'gate' || (e.stage === 'build' && e.status === 'started'))?.stage === 'gate') throw new Error(`iteration ${r.iteration} is already gated; its reviews are frozen`);
  const prev = r.reviews[r.iteration]?.[axis];
  if (prev && !prev.findings.some((f) => f.issue?.startsWith(INVALID))) throw new Error(`a ${prev.verdict} "${axis}" review is already recorded for iteration ${r.iteration}; only an invalid one can be replaced`);
}
// Reviewer output is untrusted model text: reject anything outside the contract instead of storing it.
export function validateReview(run, p, status) {
  const extra = Object.keys(p).filter((k) => !REVIEW_KEYS.includes(k));
  if (extra.length) throw new Error(`review payload has unknown fields: ${extra.join(', ')}`);
  const r = derive(read())[run];
  const axes = r?.axes?.[r.iteration] || [];
  if (!axes.includes(p.axis)) throw new Error(`axis "${p.axis}" is not one of this iteration's axes (${axes.join(', ') || 'none recorded'})`);
  assertReviewOpen(r, p.axis);
  if (!Array.isArray(p.findings || [])) throw new Error('findings must be an array');
  for (const f of p.findings || []) {
    const bad = Object.keys(f).filter((k) => !FINDING_KEYS.includes(k));
    if (bad.length) throw new Error(`finding has unknown fields: ${bad.join(', ')}`);
    if (!SEVERITIES.includes(f.severity)) throw new Error(`finding severity must be ${SEVERITIES.join('|')}`);
    if (!['spec', 'build'].includes(f.route)) throw new Error('finding route must be spec|build');
    if (typeof f.issue !== 'string' || !f.issue) throw new Error('finding needs an issue sentence');
  }
  if (status === 'failed' && !(p.findings || []).some(blocking)) throw new Error('a failed review needs at least one undismissed high or medium finding (record "passed" if the verifier dismissed them all)');
}
export function derive(events) {
  const runs = {};
  for (const e of events) {
    if (e.stage === 'rules' || PROJECT_EVENTS[e.stage]) continue; // rule changes (an audit trail) and idea-to-app project events: not runs
    if (e.stage === 'ship') { // deploy state, typed by a connector: the latest per connector and env. Never moves the run's stage, url, clock or outcome.
      const r = runs[e.run];
      if (r) (r.deploys ??= {})[`${e.connector}/${e.env}`] = { connector: e.connector, kind: e.kind, env: e.env, state: e.state, status: e.status, url: e.url, sha: e.sha, at: e.at, detail: e.detail, creator: e.creator, ts: e.ts };
      continue;
    }
    const r = (runs[e.run] ??= { id: e.run, iteration: 0, reviews: {}, loopbacks: [], events: [], outcome: 'in-progress' });
    r.events.push(e);
    Object.assign(r, { stage: e.stage, status: e.status, updated: e.ts });
    r.started ??= e.ts;
    for (const k of ['title', 'url', ...(e.status === 'reverted' ? [] : ['pr']), 'branch', 'spec', 'issues', 'children']) if (e[k]) r[k] = e[k];
    if (e.stage === 'intake' && e.status === 'started') for (const k of ['author', 'association', 'source', 'imported', 'origin', 'originAssociation']) if (e[k]) r[k] = e[k];
    if (e.sessionId && !(r.sessions ||= []).some((x) => x.id === e.sessionId)) r.sessions.push({ agent: e.harness, id: e.sessionId, cwd: e.cwd, last: e.ts });
    else if (e.sessionId) r.sessions.find((x) => x.id === e.sessionId).last = e.ts;
    if (e.costUsd) r.costUsd = +((r.costUsd || 0) + e.costUsd).toFixed(4);
    if (e.tokens) r.tokens = (r.tokens || 0) + e.tokens;
    if (e.stage === 'intake' && e.status === 'started') r.outcome = 'in-progress'; // resume after needs-info
    if (r.outcome === 'awaiting-approval' && !OUTCOMES.includes(e.status)) r.outcome = 'in-progress'; // spec approved
    if (e.status === 'reverted') r.reverted = { pr: e.pr, reason: e.reason };
    if (e.stage === 'build' && e.status === 'started') r.iteration++;
    if (e.tokens || e.costUsd) { // reported: what the orchestrator copied from a subagent result
      const u = e.usage || {};
      const usd = e.costUsd ?? (e.usage ? costOf(e.model, [u.input || 0, u.output || 0, u.cacheRead || 0, 0, u.cacheWrite || 0]) : null); // shortcut: reported cache writes priced at the 1h rate Claude Code uses
      addBurn((r.burn ??= burnOf()), { stage: e.stage, iteration: r.iteration, axis: e.axis || e.role }, e.tokens || 0, usd, u.cacheRead || 0, e.model, true); // a subagent's result
    }
    if (e.stage === 'build' && e.localChecks) r.localChecks = e.localChecks; // only "F checks" records it
    if (e.stage === 'review' && e.status === 'started') { r.axes = { ...r.axes, [r.iteration]: e.axes }; if (e.sha) r.reviewedSha = e.sha; }
    if (e.stage === 'review' && e.axis) {
      const findings = e.findings || [];
      const verdict = findings.some(blocking) ? 'failed' : 'passed'; // findings outrank the verdict word
      (r.reviews[r.iteration] ??= {})[e.axis] = { verdict, findings, ...(e.runner && { runner: e.runner }) };
    }
    if (e.stage !== 'review' && (e.runner || r.runners?.[e.stage])) (r.runners ??= {})[e.stage] = e.runner; // latest event of the stage wins
    if (e.stage === 'gate' && ['spec', 'build'].includes(e.next)) r.loopbacks.push({ iteration: r.iteration, route: e.next, reasons: e.reasons, ts: e.ts });
    if (e.stage === 'approve' && e.status === 'decided') r.decision = { action: e.action, reasons: e.reasons };
    if (OUTCOMES.includes(e.status)) r.outcome = e.status;
  }
  for (const r of Object.values(runs)) {
    r.durationMs = Date.parse(r.updated) - Date.parse(r.started);
    if (r.burn) finishBurn(r.burn);
    if (r.deploys) r.deploys = Object.values(r.deploys);
    for (const c of r.children || []) if (runs[c]) runs[c].parent = r.id;
  }
  return runs;
}
// Live runs (with measured burn) over archived summaries, by id.
export const allRuns = (events = read()) => ({ ...Object.fromEntries(readArchive().map((a) => [a.id, a])), ...withMeasured(derive(events), events) });
export const getRun = (run) => {
  const events = read();
  const r = withMeasured(derive(events), events)[run] || readArchive().find((a) => a.id === run);
  if (!r) throw new Error(`no run ${run}`);
  return r;
};
// Measured dollars, when known, are the whole budget; otherwise the old rule on reported dollars and non-cache-read tokens.
export function budget(r) {
  const m = r.burn?.measured ? r.burn.total : null;
  const priced = m?.costUsd != null;
  const usd = priced ? m.costUsd : r.costUsd || 0;
  const tokens = m ? m.tokens - m.cacheRead : r.tokens || 0;
  return { over: usd > COST_CAP || (!priced && tokens > TOKEN_CAP), usd: +usd.toFixed(2), tokens, source: m ? 'measured' : 'reported' };
}
export const budgetWhy = (b) => `($${b.usd}, ${b.tokens} tokens, ${b.source})`;
