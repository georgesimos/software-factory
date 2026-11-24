// Data shapes emitted by factory.mjs (derive() / metrics() / discover() / sync()) and the
// presentation rules the reference dashboard applies to them. Every field but `id` may be missing.
import type { Tone } from '../tokens.ts';
import type {
  AxisReview, Burn as WireBurn, BurnCell as WireBurnCell, Deploy, FactoryEvent, Finding, Loopback as WireLoopback, Metrics as WireMetrics, Outcome, Run as WireRun, Runner, Severity,
} from '@software-factory/core/types';

export const STAGES = ['intake', 'spec', 'build', 'review', 'gate', 'approve'] as const;
export type Stage = (typeof STAGES)[number];

export const OUTCOMES = ['in-progress', 'merged', 'escalated', 'rejected', 'needs-info', 'closed', 'awaiting-approval', 'split'] as const satisfies readonly Outcome[];
export type { Outcome };
true satisfies ([Exclude<Outcome, (typeof OUTCOMES)[number]>] extends [never] ? true : never); // tsc fails when core adds an outcome missing here
/** needs-info and awaiting-approval resume in their stage, so they are not terminal. */
export const TERMINAL: readonly Outcome[] = ['merged', 'escalated', 'rejected', 'closed', 'split'];

/** `factory` = the factory drove it. Imported runs carry the agent(s) found locally, joined by "+". */
export type Source = 'factory' | 'claude-code' | 'codex' | 'human' | 'none' | (string & {});

// The wire shapes are core's (packages/core/src/types.ts: what derive(), metrics() and the server produce), imported as types
// only, so the design system has no runtime dependency on core. The dashboard reads them loosely: embedded data, archives and
// older logs may lack any field, so every field but a run's id is optional here.
export type { Severity, Finding, AxisReview, Runner, Deploy };
export type RunEvent = Partial<FactoryEvent>;
export type Loopback = Partial<WireLoopback>;
/** Tokens and dollars for one slice of a run; only tokens and costUsd are always there. */
export type BurnCell = Pick<WireBurnCell, 'tokens' | 'costUsd'> & Partial<WireBurnCell>;
type Cells = 'total' | 'byStage' | 'byIteration' | 'byAxis' | 'reported';
export type Burn = Partial<Omit<WireBurn, Cells>> & { total: BurnCell; byStage?: Record<string, BurnCell>; byIteration?: Record<string, BurnCell>; byAxis?: Record<string, BurnCell>; reported?: BurnCell | null };
export type Run = Partial<Omit<WireRun, 'events' | 'loopbacks' | 'burn'>> & { id: string; events?: RunEvent[]; loopbacks?: Loopback[]; burn?: Burn | null };
export type Metrics = Partial<WireMetrics>;

/** One entry of `factory.mjs discover`. */
export interface DiscoveredRepo {
  repo: string;
  path: string;
  attached: boolean;
  lastCommit: string | null;
  worktrees: number;
  otherClones?: string[];
}

/** Return value of `factory.mjs sync`. Ids with "#" are PRs/issues; ids with ":" are session-only branches. */
export interface SyncResult { repo: string; path: string; added: string[]; attached: string[]; closed: string[] }

export const OUTCOME_TONE: Record<Outcome | 'reverted', Tone> = {
  'in-progress': 'run', merged: 'ok', escalated: 'warn', 'needs-info': 'warn', 'awaiting-approval': 'warn',
  rejected: 'bad', closed: 'idle', split: 'idle', reverted: 'bad',
};
export const OUTCOME_LABEL: Record<Outcome | 'reverted', string> = {
  'in-progress': 'In progress', merged: 'Merged', escalated: 'Escalated', 'needs-info': 'Needs info',
  'awaiting-approval': 'Awaiting approval', rejected: 'Rejected', closed: 'Closed', split: 'Split', reverted: 'Reverted',
};

const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
export const outcomeOf = (r: Run): Outcome => (r.outcome && OUTCOMES.includes(r.outcome) ? r.outcome : 'in-progress');
export const stageOf = (r: Run): Stage => (r.stage && (STAGES as readonly string[]).includes(r.stage) ? r.stage as Stage : 'intake');
export const isDone = (r: Run) => TERMINAL.includes(outcomeOf(r)) || !!r.archived;
export const isBlocking = (f: Finding) => (f.severity === 'high' || f.severity === 'medium') && !f.dismissed;
export const isDismissed = (f: Finding) => f.dismissed != null && f.dismissed !== false;
/** Findings outrank the verdict word: a review only fails if a blocking finding survives dismissal. */
export const reviewFailed = (v: AxisReview) => {
  const fs = arr(v.findings);
  return v.verdict !== 'passed' && !(fs.length && !fs.some(isBlocking));
};

export type StageState = 'pending' | 'active' | 'done' | 'failed' | 'warn' | 'skipped' | 'idle';
const STATUS_STATE: Record<string, StageState> = {
  started: 'active', passed: 'done', decided: 'active', merged: 'done', escalated: 'warn', 'needs-info': 'warn',
  'awaiting-approval': 'warn', rejected: 'failed', failed: 'failed', split: 'done', closed: 'idle', reverted: 'failed',
};

/** State and one-line subtitle for one stage of a run, as the dashboard's pipeline track shows it. */
export function stageState(r: Run, s: Stage): { state: StageState; sub: string } {
  const i = STAGES.indexOf(s), at = STAGES.indexOf(stageOf(r));
  const evs = arr(r.events).filter((e) => e.stage === s);
  const last = evs[evs.length - 1];
  if (!last) return i < at ? { state: 'skipped', sub: r.archived ? '' : 'skipped' } : { state: 'pending', sub: '' };
  if (s === 'review') {
    const it = String(r.iteration ?? 0), rev = r.reviews?.[it] ?? {}, axes = arr(r.axes?.[it]);
    if (axes.length) {
      const done = axes.filter((a) => rev[a]).length, fails = axes.filter((a) => rev[a] && reviewFailed(rev[a]!)).length;
      if (done < axes.length) return { state: 'active', sub: `${done}/${axes.length} axes` };
      return fails ? { state: 'failed', sub: `${fails} failed` } : { state: 'done', sub: `${axes.length} passed` };
    }
  }
  if (s === 'gate' && last.status === 'failed') return { state: last.next === 'approve' ? 'warn' : 'failed', sub: '→ ' + (last.next || '?') };
  if (s === 'approve' && r.reverted) return { state: 'failed', sub: 'reverted' };
  return { state: STATUS_STATE[last.status ?? ''] ?? 'pending', sub: last.status ?? '' };
}

/** The dot colour on a run card. */
export function runTone(r: Run): { tone: Tone; live: boolean } {
  const o = outcomeOf(r), { state } = stageState(r, stageOf(r));
  if (r.reverted) return { tone: 'bad', live: false };
  if (isDone(r) || o !== 'in-progress') return { tone: OUTCOME_TONE[o], live: false };
  if (state === 'failed') return { tone: 'bad', live: false };
  return { tone: 'run', live: state === 'active' };
}

// ---- runners and models ----
/** A model id as its alias (claude-fable-5-2 -> fable); unknown ids stay as they are. */
export const modelAlias = (id: string) => /(fable|opus|sonnet|haiku)/.exec(id)?.[1] ?? id;
const capital = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);
const runnerName = (y: Runner) => y.use === 'skill' ? `skill: ${y.name}` : y.use === 'brief' ? `brief: ${String(y.path ?? '').split('/').pop()}`
  : y.use === 'provider' ? [y.harness, y.name].filter(Boolean).join(': ') : null;
/**
 * Who did a step and on which model, when it wasn't the built-in brief on no known model. `short` drops the kind and the
 * effort, for the narrow pipeline track. `used` is the model that actually served it (burn); "Fable → Opus (fallback)" when it differs.
 */
export function runnerLabel(x: Runner | undefined, short = false, what = 'Run by', usedId = ''): { text: string; title: string } | null {
  if (!x || typeof x !== 'object') x = {};
  const used = usedId ? modelAlias(usedId) : '';
  const down = !!x.fallback && !Array.isArray(x.fallback), fb = down ? x.fallback as { from?: Runner; reason?: string } : {};
  const base = down ? 'default · fallback' : runnerName(x), model = typeof x.model === 'string' ? modelAlias(x.model) : '', fell = !!(used && model && used !== model);
  const m = fell ? `${capital(model)} → ${capital(used)} (fallback)` : capital(used || model);
  if (!base && !m) return null;
  const last = (n: string) => n.split(':').pop() ?? n;
  const who = !base ? '' : !short || down ? base : x.use === 'brief' ? base.slice(7) : last(String(x.name || x.harness || ''));
  const text = [who, m + (m && !short && x.effort ? ` · ${x.effort}` : '')].filter(Boolean).join(' · ');
  const on = m ? ` on ${used || model}${x.effort ? ` (${x.effort} effort)` : ''}${fell ? `; configured ${model}` : used ? '' : ' (configured; no usage yet)'}${Array.isArray(x.fallback) ? `; fallback chain ${x.fallback.join(' → ')}` : ''}` : '';
  const title = down ? `Configured ${(fb.from && runnerName(fb.from)) || 'runner'} was unavailable: ${fb.reason || 'no reason given'}` : `${what} ${base || 'the built-in brief'}${on}`;
  return { text, title };
}
/** Tokens and cost as one string; "+" when some tokens ran on a model with no price. */
export const burnText = (c: BurnCell) => `${formatTokens(c.tokens)} · ${c.costUsd == null ? '—' : formatMoney(c.costUsd) + (c.unpriced ? '+' : '')}`;
export const costText = (c: BurnCell) => (c.costUsd == null ? '—' : formatMoney(c.costUsd) + (c.unpriced ? '+' : ''));

/** The latest passed preview deploy with an https URL. */
export const previewOf = (r: Run) => r.deploys?.find((d) => d.env === 'preview' && d.status === 'passed' && /^https:\/\//.test(d.url ?? ''));
export const repoOf = (id: string) => id.split(/[#:]/)[0] ?? id;
export const shortId = (id: string) => id.replace(/^[^/#:]*\//, '');

/** Counts for the onboarding progress row. Session-backed PRs attached to existing runs count as sessions. */
export const syncCounts = (s: SyncResult) => ({
  prs: s.added.filter((id) => id.includes('#')).length,
  sessions: s.added.filter((id) => !id.includes('#')).length + s.attached.length,
  closed: s.closed.length,
});

// ---- formatting (shared by cards, metrics, timeline) ----
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export function formatAgo(ts: string | undefined | null, now = Date.now()) {
  const t = Date.parse(ts ?? '');
  if (Number.isNaN(t)) return '';
  const m = Math.max(0, Math.round((now - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
export function formatClock(ts: string | undefined, now = Date.now()) {
  const d = new Date(ts ?? '');
  if (Number.isNaN(d.getTime())) return '';
  const today = d.toDateString() === new Date(now).toDateString();
  return d.toLocaleString([], today ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}
/** [value, unit] so the unit can be set smaller. */
export const formatDuration = (ms: number | null | undefined): [string, string] | null =>
  !num(ms) || ms < 0 ? null : ms < 3600e3 ? [String(Math.max(1, Math.round(ms / 60e3))), 'm'] : ms < 864e5 ? [(ms / 3600e3).toFixed(1), 'h'] : [(ms / 864e5).toFixed(1), 'd'];
export const formatPercent = (x: number | null | undefined): [string, string] | null => (num(x) ? [String(Math.round(x * 100)), '%'] : null);
export const formatMoney = (x: number | null | undefined) => (num(x) ? '$' + (x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(2)) : null);
export const formatTokens = (x: number | null | undefined) => (!num(x) ? null : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e3 ? Math.round(x / 1e3) + 'k' : String(x));
