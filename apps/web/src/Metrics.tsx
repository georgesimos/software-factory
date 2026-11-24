import {
  Button, Dialog, EmptyState, MetricStat, MetricStrip, STAGES, Select, Skeleton, Table, costText, formatDuration, formatPercent, formatTokens,
} from '@software-factory/design-system';
import { useEffect, useMemo, useState } from 'react';
import './Metrics.css';

// The Metrics sheet (#82): GET /api/metrics, which derives burn, outcomes and timing from the event log, under F ui (its token).
// The Artifact has no API: its page embeds the same numbers per project and range (metricsLog), as of when it was published.
// F render's file has neither and keeps the board's own metric strip.

/** A logMetrics() cell (packages/core/src/metrics.ts). costUsd is null when no model was priced; unpriced tokens add a "+". */
export interface MCell { tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; unpriced: number; reported: number; source: string | null }
export interface LogMetrics {
  total: MCell; cacheHitRatio: number | null;
  byDay: Record<string, MCell>; byProject: Record<string, MCell>; byStage: Record<string, MCell>; byAxis: Record<string, MCell>; byModel: Record<string, MCell>; byHarness: Record<string, MCell>;
  outcomes: { merged: number; humanMerged: number; escalated: number; rejected: number; closed: number; split: number; reverted: number };
  costPerMergedPrUsd: number | null; loopsPerRun: number | null; capHitShare: number | null; medianIntakeToMergeMs: number | null; measuredRuns: number;
}

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});
const n0 = (x: unknown) => (num(x) ? x : 0), orNull = (x: unknown) => (num(x) ? x : null);
const cell = (c: unknown): MCell => {
  const x = obj(c);
  return { tokens: n0(x.tokens), input: n0(x.input), output: n0(x.output), cacheRead: n0(x.cacheRead), cacheWrite: n0(x.cacheWrite), costUsd: orNull(x.costUsd),
    unpriced: n0(x.unpriced), reported: n0(x.reported), source: typeof x.source === 'string' ? x.source : null };
};
const cells = (m: unknown) => Object.fromEntries(Object.entries(obj(m)).map(([k, v]) => [k.slice(0, 100), cell(v)]));
/** The API reply, with every number checked, so render code can trust shapes. */
export function normMetrics(x: unknown): LogMetrics {
  const m = obj(x), o = obj(m.outcomes);
  return {
    total: cell(m.total), cacheHitRatio: orNull(m.cacheHitRatio),
    byDay: Object.fromEntries(Object.entries(cells(m.byDay)).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort(([a], [b]) => a.localeCompare(b))),
    byProject: cells(m.byProject), byStage: cells(m.byStage), byAxis: cells(m.byAxis), byModel: cells(m.byModel), byHarness: cells(m.byHarness),
    outcomes: { merged: n0(o.merged), humanMerged: n0(o.humanMerged), escalated: n0(o.escalated), rejected: n0(o.rejected), closed: n0(o.closed), split: n0(o.split), reverted: n0(o.reverted) },
    costPerMergedPrUsd: orNull(m.costPerMergedPrUsd), loopsPerRun: orNull(m.loopsPerRun), capHitShare: orNull(m.capHitShare),
    medianIntakeToMergeMs: orNull(m.medianIntakeToMergeMs), measuredRuns: n0(m.measuredRuns),
  };
}

export const RANGES: [string, string][] = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['', 'All time']];
/** The `since` date (UTC, as the API buckets days) for a range in days; '' is all time. */
export const sinceFor = (days: string, now = Date.now()) => (days ? new Date(now - (Number(days) - 1) * 864e5).toISOString().slice(0, 10) : '');
export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** One bar per day from `from` (or the first day with burn) to `to` (or the last): a quiet day is a zero bar, never a gap. */
export function dayBars(byDay: Record<string, MCell>, from = '', to = '') {
  const days = Object.keys(byDay).sort();
  if (!days.length) return [];
  const out: { day: string; cell: MCell | null }[] = [];
  for (let t = Date.parse(from && from < days[0]! ? from : days[0]!), end = Date.parse(to > days.at(-1)! ? to : days.at(-1)!); t <= end; t += 864e5) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, cell: byDay[day] ?? null });
  }
  return out;
}

/** Breakdown rows: pipeline order for stages, most tokens first otherwise; share is of the shown rows' tokens. */
export function rows(by: Record<string, MCell>, order?: readonly string[]) {
  const sum = Object.values(by).reduce((s, c) => s + c.tokens, 0);
  const rank = (k: string) => (order?.includes(k) ? order.indexOf(k) : Infinity);
  return Object.entries(by).sort(([a, x], [b, y]) => rank(a) - rank(b) || y.tokens - x.tokens || a.localeCompare(b))
    .map(([key, c]) => ({ key, cell: c, share: sum ? c.tokens / sum : 0 }));
}

export async function fetchMetrics(token: string, project: string, since: string): Promise<LogMetrics> {
  const q = new URLSearchParams();
  if (project) q.set('project', project);
  if (since) q.set('since', since);
  const qs = String(q); // not q.size: Safari 16 and older Chromium and Firefox lack it
  const res = await fetch('/api/metrics' + (qs ? '?' + qs : ''), { headers: { 'x-factory-token': token } });
  const x = await res.json().catch(() => null) as { error?: string } | null;
  if (!res.ok || !x || typeof x !== 'object') throw new Error(x?.error || `GET /api/metrics answered ${res.status}${res.ok ? ' without JSON' : ''}`);
  return normMetrics(x);
}

/**
 * The Artifact's loader: the embedded entry for the project and the range whose `since` (from `at`, the page's generated time)
 * is asked for. Only the all-time entry carries byDay; a range takes its days from `since` on. No entry: nothing in range.
 */
export function embedded(log: unknown, at: number): typeof fetchMetrics {
  const own = (o: unknown, k: string) => (Object.prototype.hasOwnProperty.call(obj(o), k) ? obj(o)[k] : undefined); // never __proto__ and the like
  return async (_token, project, since) => {
    const scope = own(log, project), range = RANGES.find(([v]) => sinceFor(v, at) === since)?.[0];
    const m = range == null ? undefined : own(scope, range);
    if (!m) return normMetrics({});
    const days = Object.entries(obj(obj(own(scope, '')).byDay)).filter(([d]) => !since || d >= since);
    return normMetrics({ ...obj(m), byDay: Object.fromEntries(days) });
  };
}

const tok = (n: number) => formatTokens(n) ?? '0';
const pct = (x: number | null) => formatPercent(x);

function Chart({ m, from, to }: { m: LogMetrics; from: string; to: string }) {
  const [by, setBy] = useState<'tokens' | 'cost'>('tokens');
  const bars = dayBars(m.byDay, from, to), val = (c: MCell | null) => (!c ? 0 : by === 'tokens' ? c.tokens : c.costUsd ?? 0);
  const max = Math.max(0, ...bars.map((b) => val(b.cell)));
  const peak = bars.find((b) => max > 0 && val(b.cell) === max);
  const text = (c: MCell | null) => (by === 'tokens' ? tok(c?.tokens ?? 0) + ' tokens' : c ? costText(c) : '$0.00');
  return (
    <section className="web-mx-sec" aria-labelledby="mx-burn">
      <div className="web-mx-h">
        <h3 id="mx-burn" className="sf-label">Burn per day</h3>
        <div className="web-mx-seg" role="group" aria-label="Measure">
          {(['tokens', 'cost'] as const).map((k) => <Button key={k} size="sm" variant={by === k ? 'secondary' : 'ghost'} aria-pressed={by === k} onClick={() => setBy(k)}>{k === 'tokens' ? 'Tokens' : 'Cost'}</Button>)}
        </div>
      </div>
      {bars.length ? (
        <>
          <div className="web-mx-chart" role="img" aria-label={`${by === 'tokens' ? 'Tokens' : 'Cost'} per day, ${bars[0]!.day} to ${bars.at(-1)!.day}` + (peak ? `; peak ${text(peak.cell)} on ${peak.day}` : '')}>
            {bars.map((b) => <i key={b.day} title={`${b.day}: ${text(b.cell)}`} style={{ height: max ? `${(val(b.cell) / max) * 100}%` : 0 }} />)}
          </div>
          <div className="web-mx-axis" aria-hidden="true"><span>{bars[0]!.day}</span>{peak ? <span>peak {text(peak.cell)}</span> : null}<span>{bars.at(-1)!.day}</span></div>
        </>
      ) : <p className="sf-muted">No burn recorded in this range.</p>}
    </section>
  );
}

// base: the total's source; a row is tagged only where it differs, so an all-reported range isn't a column of tags.
function Breakdown({ title, by, order, base }: { title: string; by: Record<string, MCell>; order?: readonly string[]; base: string | null }) {
  const r = rows(by, order);
  if (!r.length) return null;
  return (
    <section className="web-mx-sec" aria-label={`Burn by ${title.toLowerCase()}`}>
      <h3 className="sf-label">By {title.toLowerCase()}</h3>
      <Table>
        <thead><tr><th scope="col">{title}</th><th scope="col" className="sf-num">Tokens</th><th scope="col" className="sf-num">Cost</th><th scope="col"><span className="sf-sr-only">Share</span></th></tr></thead>
        <tbody>
          {r.map(({ key, cell: c, share }) => (
            <tr key={key}>
              <td className="web-mx-k">{key}{c.source && c.source !== base ? <small className="sf-muted"> {c.source}</small> : null}</td>
              <td className="sf-num">{tok(c.tokens)}</td>
              <td className="sf-num">{costText(c)}</td>
              <td className="web-mx-share"><span className="sf-sr-only">{Math.round(share * 100)}% of tokens</span><span className="web-mx-bar" aria-hidden="true"><i style={{ width: `${share * 100}%` }} /></span></td>
            </tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}

function Body({ token, projects, initial, load, at }: { token: string; projects: string[]; initial: string; load: typeof fetchMetrics; at?: number }) {
  const [project, setProject] = useState(initial), [range, setRange] = useState('30');
  const [st, setSt] = useState<{ m?: LogMetrics; error?: string; busy?: boolean; of?: { project: string; range: string } }>({}); // of: the filter m was loaded for
  const now = at ?? Date.now(), since = sinceFor(range, now), to = range ? dayOf(now) : ''; // a range runs to today, quiet days included
  useEffect(() => {
    let ignore = false;
    setSt((s) => ({ m: s.m, of: s.of, busy: true })); // the last numbers stay, dimmed and marked busy, until the new filter's arrive
    load(token, project, since).then((m) => { if (!ignore) setSt({ m, of: { project, range } }); }, (e: unknown) => { if (!ignore) setSt({ error: String((e as Error)?.message ?? e) }); });
    return () => { ignore = true; };
  }, [token, project, since, load]);
  const { m, error } = st, o = m?.outcomes, t = m?.total;
  const cache = pct(m?.cacheHitRatio ?? null), cap = pct(m?.capHitShare ?? null), med = formatDuration(m?.medianIntakeToMergeMs);
  const empty = m && !t!.tokens && !(['merged', 'humanMerged', 'escalated', 'rejected', 'reverted'] as const).some((k) => o![k]); // the outcomes shown
  return (
    <div className="web-mx">
      <div className="web-mx-filters">
        <label>Project <Select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>{projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select></label>
        <label>Range <Select value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></label>
      </div>
      {error ? <EmptyState title="Could not load metrics">{error}</EmptyState> : !m ? <><span className="sf-sr-only">Loading metrics…</span><Skeleton height={240} width="100%" /></> : empty ? (
        <div className="web-mx-data" aria-busy={st.busy || undefined}> {/* worded for the filter that loaded it, not one still loading */}
          <EmptyState title="Nothing in this range">No run spent tokens or finished {st.of?.range ? `in the last ${st.of.range} days` : 'yet'}{st.of?.project ? ` in ${st.of.project}` : ''}.</EmptyState>
        </div>
      ) : (
        <div className="web-mx-data" aria-busy={st.busy || undefined}>
          <MetricStrip label="Burn and cost">
            <MetricStat label="Spend" value={costText(t!)} sub={`${tok(t!.tokens)} tokens${t!.source && t!.source !== 'measured' ? ` · ${t!.source}` : ''}`} />
            <MetricStat label="Cache hits" value={cache?.[0] ?? null} unit={cache?.[1]} sub={`${tok(t!.cacheRead)} read from cache`} />
            <MetricStat label="Cost / merged PR" value={m.costPerMergedPrUsd == null ? null : costText({ tokens: 0, costUsd: m.costPerMergedPrUsd, unpriced: t!.unpriced })} sub="factory merges" />
            <MetricStat label="Intake → merge" value={med?.[0] ?? null} unit={med?.[1]} sub="median" />
            <MetricStat label="Loops / run" value={m.loopsPerRun == null ? null : m.loopsPerRun.toFixed(1)} sub="gate loop-backs" />
            <MetricStat label="Cap hits" value={cap?.[0] ?? null} unit={cap?.[1]} sub="loop cap or budget" />
          </MetricStrip>
          <div className="web-mx-out"><MetricStrip label="Outcomes">
            <MetricStat size="sm" label="Merged" value={String(o!.merged)} sub="by the factory" />
            <MetricStat size="sm" label="Human-merged" value={String(o!.humanMerged)} sub="after escalation" />
            <MetricStat size="sm" label="Escalated" value={String(o!.escalated)} />
            <MetricStat size="sm" label="Rejected" value={String(o!.rejected)} />
            <MetricStat size="sm" label="Reverted" value={String(o!.reverted)} sub="of factory merges" />
          </MetricStrip></div>
          <Chart m={m} from={since} to={to} />
          <div className="web-mx-grid">
            <Breakdown title="Stage" by={m.byStage} order={STAGES} base={t!.source} />
            <Breakdown title="Axis" by={m.byAxis} base={t!.source} />
            <Breakdown title="Model" by={m.byModel} base={t!.source} />
            <Breakdown title="Harness" by={m.byHarness} base={t!.source} />
            {project ? null : <Breakdown title="Project" by={m.byProject} base={t!.source} />}
          </div>
          <p className="sf-muted web-mx-note">{m.measuredRuns} run{m.measuredRuns === 1 ? '' : 's'} measured from transcripts; the rest is what subagents reported. A “+” on a cost means some tokens ran on an unpriced model.</p>
        </div>
      )}
    </div>
  );
}

/** With a token, GET /api/metrics; without one, the page's embedded metricsLog, as of `generated` (the Artifact). */
export function MetricsSheet({ open, onClose, token, projects, project, load = fetchMetrics, metricsLog, generated }: {
  open: boolean; onClose: () => void; token?: string; projects: string[]; project: string; load?: typeof fetchMetrics; metricsLog?: unknown; generated?: string;
}) {
  const at = token ? undefined : Date.parse(generated ?? '') || Date.now(); // the published ranges end on the day it was published
  const fromPage = useMemo(() => embedded(metricsLog, at ?? 0), [metricsLog, at]);
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Metrics" className="web-mx-sheet"
      description={token ? 'Token burn, cost and outcomes, derived from the event log.' : `Token burn, cost and outcomes, derived from the event log as of ${dayOf(at ?? 0)}.`}>
      <Body token={token ?? ''} projects={projects} initial={project} load={token ? load : fromPage} at={at} />
    </Dialog>
  );
}
