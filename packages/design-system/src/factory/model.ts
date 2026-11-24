// Data shapes emitted by factory.mjs (derive() / metrics() / discover() / sync()) and the
// presentation rules the reference dashboard applies to them. Every field but `id` may be missing.
import type { Tone } from '../tokens.ts';

export const STAGES = ['intake', 'spec', 'build', 'review', 'gate', 'approve'] as const;
export type Stage = (typeof STAGES)[number];

export const OUTCOMES = ['in-progress', 'merged', 'escalated', 'rejected', 'needs-info', 'closed', 'awaiting-approval', 'split'] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** needs-info and awaiting-approval resume in their stage, so they are not terminal. */
export const TERMINAL: readonly Outcome[] = ['merged', 'escalated', 'rejected', 'closed', 'split'];

/** `factory` = the factory drove it. Imported runs carry the agent(s) found locally, joined by "+". */
export type Source = 'factory' | 'claude-code' | 'codex' | 'human' | 'none' | (string & {});

export type Severity = 'high' | 'medium' | 'low';
export interface Finding {
  severity?: Severity;
  file?: string;
  line?: number;
  issue?: string;
  route?: 'spec' | 'build';
  /** A string is the dismissal reason. Dismissed findings never block. */
  dismissed?: string | boolean;
}
export interface AxisReview { verdict?: 'passed' | 'failed'; findings?: Finding[]; runner?: Runner }
/** Who runs a step (skills.json). `fallback` is the model's chain, or {from, reason} when the configured runner was unavailable. */
export interface Runner {
  use?: 'default' | 'skill' | 'brief' | 'provider' | (string & {});
  name?: string;
  harness?: string;
  path?: string;
  model?: string;
  effort?: string;
  fallback?: string[] | { from?: Runner; reason?: string };
}
/** Tokens and dollars for one slice of a run. `unpriced`: tokens on a model with no price. `used`: the model that served most of it. */
export interface BurnCell { tokens: number; costUsd: number | null; unpriced?: number; used?: string | null }
export interface Burn {
  /** true: counted from session transcripts; false: reported by subagents. */
  measured?: boolean;
  total: BurnCell;
  byStage?: Record<string, BurnCell>;
  byIteration?: Record<string, BurnCell>;
  byAxis?: Record<string, BurnCell>;
  reported?: BurnCell | null;
}
export interface Loopback { iteration?: number; route?: 'spec' | 'build'; reasons?: string[]; ts?: string }

export interface RunEvent {
  ts?: string;
  run?: string;
  stage?: Stage;
  status?: string;
  axis?: string;
  axes?: string[];
  next?: string;
  summary?: string;
  reason?: string;
  reasons?: string[];
  questions?: string[];
  spec?: string;
  costUsd?: number;
  tokens?: number;
  [k: string]: unknown;
}

export interface Run {
  id: string;
  title?: string;
  url?: string;
  pr?: string;
  branch?: string;
  spec?: string;
  stage?: Stage;
  status?: string;
  outcome?: Outcome;
  iteration?: number;
  /** iteration → axes requested */
  axes?: Record<string, string[]>;
  /** iteration → axis → review */
  reviews?: Record<string, Record<string, AxisReview>>;
  loopbacks?: Loopback[];
  events?: RunEvent[];
  decision?: { action?: 'merge' | 'escalate'; reasons?: string[] } | null;
  reverted?: { pr?: string; reason?: string };
  imported?: boolean;
  source?: Source;
  author?: string;
  association?: string;
  issues?: number[];
  children?: string[];
  parent?: string;
  archived?: boolean;
  costUsd?: number;
  tokens?: number;
  started?: string;
  updated?: string;
  durationMs?: number;
  /** Local Claude Code / Codex sessions on the run's branch. */
  sessions?: import('./Sessions.tsx').AgentSession[];
  /** Latest deploy per connector and env, recorded by packages/ship. Never moves the run's stage. */
  deploys?: Deploy[];
  /** step → who ran it */
  runners?: Record<string, Runner>;
  burn?: Burn | null;
  /** The user's one-shot notes (F note): pending until the next step starting takes them. */
  notes?: { id?: string; step?: string; text?: string; by?: string; ts?: string; state?: 'pending' | 'applied' }[];
  /** The run's local worktree (F ui only; never in an Artifact). */
  worktree?: string;
}

export interface Deploy {
  connector?: string;
  kind?: string;
  env?: string;
  state?: string;
  status?: string;
  url?: string;
  sha?: string;
  at?: string;
  detail?: string;
  creator?: string;
}

export interface Metrics {
  runs?: number;
  inProgress?: number;
  merged?: number;
  escalated?: number;
  awaitingApproval?: number;
  mergeRate?: number | null;
  avgIterations?: number | null;
  medianCycleMs?: number | null;
  reverts?: number;
  revertRate?: number | null;
  costUsd?: number;
  costPerMergeUsd?: number | null;
}

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
export const stageOf = (r: Run): Stage => (r.stage && STAGES.includes(r.stage) ? r.stage : 'intake');
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
/** A run id after its owner/repo: "#12", or a branch run's last path segment ("o/r:simos/fix-x" → ":fix-x"). */
export const idTail = (id: string) => {
  const i = id.search(/[#:]/);
  return i < 0 ? '' : id[i] === '#' ? id.slice(i) : ':' + (id.slice(i + 1).split('/').filter(Boolean).pop() ?? '');
};

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
