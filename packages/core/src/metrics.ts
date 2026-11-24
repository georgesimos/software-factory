import { TERMINAL, costOf } from './constants.ts';
import { derive } from './derive.ts';
import { attribute, withMeasured } from './burn.ts';
import type { Burn, BurnCell, FactoryEvent, Measured, Run } from './types.ts';

/** A metrics cell; finish() turns costUsd to null when nothing was priced and adds source. */
interface Cell { tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; unpriced: number; reported: number; source?: 'measured' | 'reported' | 'mixed' | null }
type Dim = 'day' | 'project' | 'stage' | 'axis' | 'model' | 'harness';

// Dashboard metrics (#82), derived from the event log and stored nowhere. Pure: the transcript burn (`measure(events)`) and
// the archive summaries come in as options, so GET /api/metrics passes the real ones and tests pass literals.
// Named logMetrics, not metrics: gate.ts's metrics(runs) is the dashboard's per-project summary and keeps its name.
// A cell: tokens (all of them), their split where known (a reported event without `usage` adds tokens only), dollars where
// every model was priced, unpriced tokens, and how many tokens the orchestrator reported rather than F measured.
const cell = (): Cell => ({ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpriced: 0, reported: 0 });
const add = (c: Cell, tokens: number, t: number[], usd: number | null, reported: boolean) => {
  c.tokens += tokens; c.input += t[0] as number; c.output += t[1] as number; c.cacheRead += t[2] as number; c.cacheWrite += (t[3] as number) + (t[4] as number); // t has 5 numbers
  if (usd == null) c.unpriced += tokens; else (c.costUsd as number) += usd; // a number until finish()
  if (reported) c.reported += tokens;
};
const finish = (c: Cell) => Object.assign(c, {
  costUsd: c.unpriced && !c.costUsd ? null : +(c.costUsd as number).toFixed(4), // null: no priced model at all
  source: !c.tokens ? null : !c.reported ? 'measured' : c.reported === c.tokens ? 'reported' : 'mixed',
});
// Cache reads over all prompt tokens, from split tokens only.
const hitRatio = (c: Cell) => { const p = c.input + c.cacheRead + c.cacheWrite; return p ? +(c.cacheRead / p).toFixed(3) : null; };
export const repoOf = (id: string) => id.split(/[#:]/)[0] as string; // split always has a first part
const day = (ts: unknown) => String(ts).slice(0, 10); // UTC: every ts here is an ISO string from toISOString()

// runs: withMeasured(derive(events), …) when the caller already has it (sheetMetrics() asks for many projects and ranges); read only.
export function logMetrics(events: FactoryEvent[], { project, since, measured = {}, archive = [], runs: given }: { project?: string | null; since?: string | null; measured?: Measured; archive?: Run[]; runs?: Record<string, Run> } = {}) {
  const from = since == null || since === '' ? -Infinity : Date.parse(since);
  if (Number.isNaN(from)) throw new RangeError('since must be an ISO date like 2026-11-01');
  const inScope = (id: string) => !project || repoOf(id) === project;
  const after = (ts: string) => Date.parse(ts) >= from;
  // When a run ended: the event that ended it (a later revert moves `updated`, not this).
  const endedAt = (r: Run) => r.events?.findLast((e) => e.status === r.outcome)?.ts ?? r.updated;
  // The full log, so `since` never cuts a run in half; rows and outcomes are then filtered by their own timestamps.
  const runs = given ?? withMeasured(derive(events), events, measured, archive);
  const total = cell(), by: Record<Dim, Record<string, Cell>> = { day: {}, project: {}, stage: {}, axis: {}, model: {}, harness: {} };
  const put = (ts: string, run: string, { stage, axis, model, harness }: { stage?: string; axis?: string | null; model?: string; harness?: string }, fill: (c: Cell) => void) => {
    if (!inScope(run) || !after(ts)) return;
    for (const c of [total, by.day[day(ts)] ??= cell(), by.project[repoOf(run)] ??= cell(), stage ? by.stage[stage] ??= cell() : null,
      axis ? by.axis[axis] ??= cell() : null, model ? by.model[model] ??= cell() : null, harness ? by.harness[harness] ??= cell() : null]) if (c) fill(c);
  };
  // Measured burn replaces reported burn per run, as in withMeasured: never both for one run.
  // byAxis is not a partition of total: a measured run without subagent axis cells shows its reviewers' reported tokens there
  // (and nowhere else), as F usage does.
  const subAxes = new Set(), measuredIn = new Set(); // measuredIn: runs with measured rows in the window
  attribute(runs, events, measured, (at, [ts, , model, ...rest], f) => {
    const t = rest.slice(0, 5), usd = costOf(model, t, rest[5]);
    if (f.sub && f.axis) subAxes.add(at.run);
    if (inScope(at.run) && after(ts)) measuredIn.add(at.run);
    put(ts, at.run, { stage: at.stage, axis: f.sub ? f.axis : null, model, harness: at.harness }, (c) => add(c, t.reduce((s, n) => s + n, 0), t, usd, false));
  }, archive);
  for (const e of events) {
    if (!(e.tokens || e.costUsd) || !runs[e.run]) continue;
    const u = e.usage || {}, t = [u.input || 0, u.output || 0, u.cacheRead || 0, 0, u.cacheWrite || 0];
    const usd = e.costUsd ?? (e.usage ? costOf(e.model, t) : null), axis = e.axis || e.role; // as derive() prices it
    const fill = (c: Cell) => add(c, e.tokens || 0, t, usd, true);
    if ((runs[e.run] as Run).burn?.measured) { if (axis && !subAxes.has(e.run) && inScope(e.run) && after(e.ts)) fill(by.axis[axis] ??= cell()); continue; }
    // A provider runner names the harness that ran the step; e.harness is the orchestrating session's.
    put(e.ts, e.run, { stage: e.stage, axis, model: e.model, harness: (e.runner?.use === 'provider' && e.runner.harness) || e.harness }, fill);
  }
  // shortcut: an archived run keeps run-level burn cells only, so it lands on its last day with no split, model or harness (cache
  // reads stay out, or the hit ratio would count them against no input). Upgrade: keep per-day cells in the archive summary.
  const live = new Set(Object.keys(runs));
  const archived = archive.filter((a) => !live.has(a.id) && inScope(a.id));
  const merge = (x: Pick<BurnCell, 'tokens' | 'costUsd'> & { unpriced?: number }, reported: boolean) => (c: Cell) => { // a finished burn cell: costUsd is null when nothing was priced
    c.tokens += x.tokens; (c.costUsd as number) += x.costUsd || 0; c.unpriced += x.costUsd == null ? x.tokens : x.unpriced || 0;
    if (reported) c.reported += x.tokens;
  };
  for (const a of archived) {
    const b = a.burn, at = endedAt(a), spent = b?.total || { tokens: a.tokens || 0, costUsd: a.costUsd ?? null }; // as gate's spent()
    if (!(spent.tokens || spent.costUsd) || !after(at)) continue;
    if (b?.measured) measuredIn.add(a.id);
    put(at, a.id, {}, merge(spent, !b?.measured));
    for (const [k, c] of Object.entries(b?.byStage || {})) merge(c, !(b as Burn).measured)(by.stage[k] ??= cell()); // entries: b is set
    for (const [k, c] of Object.entries(b?.byAxis || {})) merge(c, !(b as Burn).measured)(by.axis[k] ??= cell());
  }
  for (const c of [total, ...Object.values(by).flatMap(Object.values)]) finish(c);
  // Outcomes count the runs that ended in the window, at the event that ended them.
  const ended = [...Object.values(runs), ...archived].filter((r) => inScope(r.id) && TERMINAL.includes(r.outcome) && after(endedAt(r)));
  const count = (o: string) => ended.filter((r) => r.outcome === o).length;
  // As gate's metrics() (#96): merged means the factory's own merges; one a human made after an escalation counts as escalated.
  const merged = ended.filter((r) => r.outcome === 'merged' && !r.humanMerge), humanMerged = ended.filter((r) => r.outcome === 'merged' && r.humanMerge).length;
  const built = ended.filter((r) => !r.imported && ['merged', 'escalated'].includes(r.outcome));
  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((s, n) => s + n, 0) / xs.length).toFixed(3) : null);
  const toMerge = merged.filter((r) => !r.imported).map((r) => Date.parse(endedAt(r)) - Date.parse(r.started)).sort((a, b) => a - b);
  const mid = toMerge.length >> 1;
  // A cap hit, as recorded at the time (never recomputed from today's burn): a run the factory did not merge (a human may have,
  // later) that the gate sent to approve for the loop cap or budget, or whose gate or approve reasons name either.
  const CAP_WHY = /loop cap \d+ reached|exceeds cap|budget reached|run budget exceeded/; // gate() and decide() wording
  const capped = (r: Run) => !merged.includes(r) && ((r.events || []).some((e) => e.stage === 'gate' && e.status === 'failed' && (e.next === 'approve' || (e.reasons || []).some((x) => CAP_WHY.test(x))))
    || (r.decision?.reasons || []).some((x) => CAP_WHY.test(x)));
  return {
    project: project || null, since: since || null, total, cacheHitRatio: hitRatio(total),
    byDay: Object.fromEntries(Object.entries(by.day).sort(([a], [b]) => a.localeCompare(b))),
    byProject: by.project, byStage: by.stage, byAxis: by.axis, byModel: by.model, byHarness: by.harness,
    outcomes: { merged: merged.length, humanMerged, escalated: count('escalated') + humanMerged, rejected: count('rejected'), closed: count('closed'), split: count('split'),
      reverted: merged.filter((r) => r.reverted).length }, // reverts of the factory's own merges
    // shortcut: cost per merged PR divides all spend in the window (escalated runs included) by the merges in it, as gate's metrics() does
    costPerMergedPrUsd: merged.length && total.costUsd != null ? +(total.costUsd / merged.length).toFixed(2) : null,
    loopsPerRun: avg(built.map((r) => (r.loopbacks || []).length)), // gate loop-backs to spec or build, per finished build
    capHitShare: avg(built.map((r) => (capped(r) ? 1 : 0))),
    medianIntakeToMergeMs: !toMerge.length ? null : toMerge.length % 2 ? toMerge[mid] : ((toMerge[mid - 1] as number) + (toMerge[mid] as number)) / 2,
    measuredRuns: measuredIn.size,
  };
}
