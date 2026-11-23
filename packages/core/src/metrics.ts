// @ts-nocheck
import { CAP, TERMINAL, costOf } from './constants.ts';
import { budget, derive } from './derive.ts';
import { attribute, withMeasured } from './burn.ts';

// Dashboard metrics (#82), derived from the event log and stored nowhere. Pure: the transcript burn (`measure(events)`) and
// the archive summaries come in as options, so GET /api/metrics passes the real ones and tests pass literals.
// Named logMetrics, not metrics: gate.ts's metrics(runs) is the dashboard's per-project summary and keeps its name.
// A cell: tokens (all of them), their split where known (a reported event without `usage` adds tokens only), dollars where
// every model was priced, unpriced tokens, and how many tokens the orchestrator reported rather than F measured.
const cell = () => ({ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0, reported: 0 });
const add = (c, tokens, t, usd, reported) => {
  c.tokens += tokens; c.input += t[0]; c.output += t[1]; c.cacheRead += t[2]; c.cacheWrite += t[3] + t[4];
  if (usd == null) c.unpriced += tokens; else c.costUsd += usd;
  if (reported) c.reported += tokens;
};
const finish = (c) => Object.assign(c, {
  costUsd: c.unpriced && !c.costUsd ? null : +c.costUsd.toFixed(4), // null: no priced model at all
  source: !c.tokens ? null : !c.reported ? 'measured' : c.reported === c.tokens ? 'reported' : 'mixed',
});
// Cache reads over all prompt tokens, from split tokens only.
const hitRatio = (c) => { const p = c.input + c.cacheRead + c.cacheWrite; return p ? +(c.cacheRead / p).toFixed(3) : null; };
export const repoOf = (id) => id.split(/[#:]/)[0];
const day = (ts) => String(ts).slice(0, 10); // UTC: every ts here is an ISO string from toISOString()

export function logMetrics(events, { project, since, measured = {}, archive = [] } = {}) {
  const from = since == null || since === '' ? -Infinity : Date.parse(since);
  if (Number.isNaN(from)) throw new RangeError('since must be an ISO date like 2026-11-01');
  const inScope = (id) => !project || repoOf(id) === project;
  const after = (ts) => Date.parse(ts) >= from;
  // The full log, so `since` never cuts a run in half; rows and outcomes are then filtered by their own timestamps.
  const runs = withMeasured(derive(events), events, measured, archive);
  const total = cell(), by = { day: {}, project: {}, stage: {}, axis: {}, model: {}, harness: {} };
  const put = (ts, run, { stage, axis, model, harness }, fill) => {
    if (!inScope(run) || !after(ts)) return;
    for (const c of [total, by.day[day(ts)] ??= cell(), by.project[repoOf(run)] ??= cell(), stage ? by.stage[stage] ??= cell() : null,
      axis ? by.axis[axis] ??= cell() : null, model ? by.model[model] ??= cell() : null, harness ? by.harness[harness] ??= cell() : null]) if (c) fill(c);
  };
  // Measured burn replaces reported burn per run, as in withMeasured: never both for one run.
  attribute(runs, events, measured, (at, [ts, , model, ...rest], f) => {
    const t = rest.slice(0, 5), usd = costOf(model, t, rest[5]);
    put(ts, at.run, { stage: at.stage, axis: f.sub ? f.axis : null, model, harness: at.harness }, (c) => add(c, t.reduce((s, n) => s + n, 0), t, usd, false));
  }, archive);
  for (const e of events) {
    if (!(e.tokens || e.costUsd) || !runs[e.run] || runs[e.run].burn?.measured) continue;
    const u = e.usage || {}, t = [u.input || 0, u.output || 0, u.cacheRead || 0, 0, u.cacheWrite || 0];
    const usd = e.costUsd ?? (e.usage ? costOf(e.model, t) : null); // as derive() prices it
    put(e.ts, e.run, { stage: e.stage, axis: e.axis || e.role, model: e.model, harness: e.harness }, (c) => add(c, e.tokens || 0, t, usd, true));
  }
  // shortcut: an archived run keeps run-level burn cells only, so it lands on its last day with no split, model or harness (cache
  // reads stay out, or the hit ratio would count them against no input). Upgrade: keep per-day cells in the archive summary.
  const live = new Set(Object.keys(runs));
  const archived = archive.filter((a) => !live.has(a.id) && inScope(a.id));
  const merge = (x, reported) => (c) => { // a finished burn cell: costUsd is null when nothing was priced
    c.tokens += x.tokens; c.costUsd += x.costUsd || 0; c.unpriced += x.costUsd == null ? x.tokens : x.unpriced || 0;
    if (reported) c.reported += x.tokens;
  };
  for (const a of archived) {
    const b = a.burn;
    if (!b?.total || !after(a.updated)) continue;
    put(a.updated, a.id, {}, merge(b.total, !b.measured));
    for (const [k, c] of Object.entries(b.byStage || {})) merge(c, !b.measured)(by.stage[k] ??= cell());
    for (const [k, c] of Object.entries(b.byAxis || {})) merge(c, !b.measured)(by.axis[k] ??= cell());
  }
  for (const c of [total, ...Object.values(by).flatMap(Object.values)]) finish(c);
  // Outcomes count the runs that ended in the window, at the event that ended them (a later revert moves `updated`, not this).
  const endedAt = (r) => r.events?.findLast((e) => e.status === r.outcome)?.ts ?? r.updated;
  const ended = [...Object.values(runs), ...archived].filter((r) => inScope(r.id) && TERMINAL.includes(r.outcome) && after(endedAt(r)));
  const count = (o) => ended.filter((r) => r.outcome === o).length;
  const merged = ended.filter((r) => r.outcome === 'merged');
  const built = ended.filter((r) => !r.imported && ['merged', 'escalated'].includes(r.outcome));
  const avg = (xs) => (xs.length ? +(xs.reduce((s, n) => s + n, 0) / xs.length).toFixed(3) : null);
  const toMerge = merged.filter((r) => !r.imported).map((r) => Date.parse(endedAt(r)) - Date.parse(r.started)).sort((a, b) => a - b);
  return {
    project: project || null, since: since || null, total, cacheHitRatio: hitRatio(total),
    byDay: Object.fromEntries(Object.entries(by.day).sort(([a], [b]) => a.localeCompare(b))),
    byProject: by.project, byStage: by.stage, byAxis: by.axis, byModel: by.model, byHarness: by.harness,
    outcomes: { merged: merged.length, escalated: count('escalated'), rejected: count('rejected'), reverted: merged.filter((r) => r.reverted).length },
    // shortcut: cost per merged PR divides all spend in the window (escalated runs included) by the merges in it, as gate's metrics() does
    costPerMergedPrUsd: merged.length && total.costUsd != null ? +(total.costUsd / merged.length).toFixed(2) : null,
    loopsPerRun: avg(built.map((r) => (r.loopbacks || []).length)), // gate loop-backs to spec or build, per finished build
    capHitShare: avg(built.map((r) => (r.iteration >= CAP || budget(r).over ? 1 : 0))), // ran into the loop cap or the run budget
    medianIntakeToMergeMs: toMerge.length ? toMerge[Math.floor(toMerge.length / 2)] : null,
    measuredRuns: Object.values(runs).filter((r) => inScope(r.id) && r.burn?.measured).length,
  };
}
