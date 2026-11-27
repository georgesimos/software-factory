// The event log's shapes and the Run that derive() builds from them. Types only: no runtime code, no imports.
// Events come from events.jsonl (JSON.parse): F validates what it records, but a hand-edited log can hold anything, so
// every event field but ts, run, stage and status (which record() always writes) is optional, and readers keep their guards.

export type Severity = 'high' | 'medium' | 'low';
export type Route = 'spec' | 'build';
export interface Finding { severity?: Severity; file?: string; line?: number; issue?: string; route?: Route; dismissed?: string | boolean }
export interface AxisReview { verdict: 'passed' | 'failed'; findings: Finding[]; runner?: Runner }
/** Who ran a step (skills.json). `fallback`: the model chain, or {from, reason} when the configured runner was unavailable. */
export interface Runner {
  use?: string; name?: string; harness?: string; path?: string; model?: string; effort?: string;
  fallback?: string[] | { from?: Runner; reason?: string };
}
export interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
export interface LocalChecks { sha?: string; state?: string; commands?: { cmd: string; exit: number | string; ms?: number }[] } // exit: a code, 'timeout' (killed after 30 min), or the signal that killed the command
export interface Deploy { connector?: string; kind?: string; env?: string; state?: string; status?: string; url?: string; sha?: string | null; at?: string; detail?: string; creator?: string; ts?: string }
export interface Note { id?: string; step?: string; text?: string; by?: string; via?: string; ts?: string; state: 'pending' | 'applied'; appliedTo?: string[]; appliedAt?: string; claim?: unknown }
export interface Session { agent?: string; id: string; cwd?: string; last?: string; hostId?: string } // hostId: the Claude desktop app's session (local_<uuid>)

/** One line of events.jsonl. */
export interface FactoryEvent {
  ts: string; run: string; stage: string; status: string;
  title?: string; url?: string; pr?: string; branch?: string; spec?: string; issues?: number[]; children?: string[];
  author?: string; association?: string; source?: string; imported?: boolean; origin?: string; originAssociation?: string;
  harness?: string; sessionId?: string; hostSessionId?: string; cwd?: string; // hostSessionId: from CLAUDE_CODE_HOST_SESSION_ID only
  costUsd?: number; tokens?: number; usage?: Usage; model?: string;
  axis?: string; axes?: string[]; role?: string; sha?: string | null; findings?: Finding[]; runner?: Runner; localChecks?: LocalChecks;
  summary?: string; questions?: string[]; // intake passed / needs-info
  next?: string; reasons?: string[]; action?: string; by?: string; via?: string; mergedBy?: string | null; reason?: string; // via: as Rule.via, on rules and note events
  connector?: string; env?: string; kind?: string; state?: string; at?: string; detail?: string; creator?: string; // ship
  id?: string; step?: string; text?: string; notes?: string[]; steps?: string[]; claim?: unknown; // note
  [k: string]: unknown;
}

export interface BurnCell {
  tokens: number;
  /** null once finished when no model was priced; a number while adding up. */
  costUsd: number | null;
  cacheRead: number; unpriced: number;
  models: Record<string, number>; subModels: Record<string, number>;
  used?: string | null;
}
export interface Burn {
  measured: boolean; total: BurnCell;
  byStage: Record<string, BurnCell>; byIteration: Record<string, BurnCell>; byAxis: Record<string, BurnCell>;
  reported?: BurnCell | null;
}
/** A rule in effect (rules.ts rules().policy); value is whatever `F rules set` stored. */
/** via: where setBy came from. Absent (every rule before #52's local mode) or 'github': a verified GitHub login; 'local': the OS user, unverified. */
export interface Rule { value?: unknown; reason?: string; setBy?: string; via?: string; setAt?: string; until?: string; scope?: string; key?: string } // scope, key: in rules()' policy and expired lists
export interface Loopback { iteration: number; route?: string; reasons?: string[]; ts: string }

export type Outcome = 'in-progress' | 'rejected' | 'needs-info' | 'merged' | 'escalated' | 'closed' | 'awaiting-approval' | 'split';

/** What derive() builds per run id; archive.jsonl holds the same shape with `archived` and `sessionEvents`. */
export interface Run {
  id: string; iteration: number; outcome: Outcome; events: FactoryEvent[]; loopbacks: Loopback[];
  /** iteration → axis → review (string keys: it is JSON on the wire; a number index still works) */
  reviews: Record<string, Record<string, AxisReview>>;
  /** iteration → axes requested */
  axes?: Record<string, string[]>;
  stage: string; status: string; started: string; updated: string; durationMs: number;
  title?: string; url?: string; pr?: string; branch?: string; spec?: string; issues?: number[]; children?: string[]; parent?: string;
  author?: string; association?: string; source?: string; imported?: boolean; origin?: string; originAssociation?: string;
  sessions?: Session[]; costUsd?: number; tokens?: number; burn?: Burn;
  localChecks?: LocalChecks; reviewedSha?: string; runners?: Record<string, Runner | undefined>;
  decision?: { action?: string; reasons?: string[] };
  humanMerge?: { by?: string | null; sha?: string | null; ts: string };
  reverted?: { pr?: string; reason?: string };
  deploys?: Deploy[]; notes?: Note[];
  /** server.ts runsData(): the worktree path, the dashboard's "Open in Claude" cwd. */
  worktree?: string;
  archived?: boolean; sessionEvents?: { ts: string; stage: string; status: string; sessionId: string }[];
  /** derive(): the pipeline this attempt was routed to (pipelines §7.4) and the meet of its picks: off the intersection, caps the minimum. */
  pipeline?: string; route?: RunRoute;
}
export interface RunRoute {
  pipeline: string; name: string | null; set: number | null; text: string | null;
  /** the condition set the last pick matched; decide re-checks it on the reviewed change (undefined: none recorded) */
  matched?: { labels?: string[]; files?: string[]; maxDiffLines?: number } | null | undefined;
  facts: { labels: string[]; files: string[]; diffLines: number | null; fileCount?: number; truncated?: boolean };
  off: string[]; caps: { loops: number; budgetUsd: number }; local: boolean; picks: { pipeline: string; set: number | null; iteration: number }[];
}

/** gate.ts metrics(): the board's numbers over a list of runs. */
export interface Metrics {
  runs: number; inProgress: number; merged: number; humanMerged: number; escalated: number; rejected: number; needsInfo: number;
  closed: number; awaitingApproval: number; split: number;
  mergeRate: number | null; avgIterations: number | null; medianCycleMs: number | null;
  reverts: number; revertRate: number | null; costUsd: number; costPerMergeUsd: number | null;
  tokens: number; tokensPerMerge: number | null; measuredRuns: number;
  /** stage → its share of all tokens, 0-1 */
  stageShare: Record<string, number>;
}

/** A transcript message's usage: [ts, message id, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, fast (0|1)]. */
export type TranscriptRow = [string, string, string, number, number, number, number, number, number];
/** One main or subagent transcript of a session; axis: the subagent's review axis, from its description. */
export interface Transcript { rows: TranscriptRow[]; axis?: string; sub: boolean }
/** sessionId → its transcripts (burn.ts measure()). */
export type Measured = Record<string, Transcript[]>;
/** Where a transcript message falls: the run, stage and iteration of the factory events around it. */
export interface Slot { t: number; run: string; stage: string; status: string; iteration: number; harness?: string }

/** projects.json, per owner/repo. */
/** One projects.json entry. host is set at the first attach (absent: github); a re-sync never changes it, only F project set
 *  does. remote (git hosts only) has no user:password@. */
export interface Project { path?: string; synced?: string; autoMerge?: boolean; host?: 'github' | 'git'; remote?: string;
  base?: string; ci?: string; tracker?: string } // F project set (base: git hosts only; ci: an adapters/ci/ id, else core's ciOf default; tracker: trackerOf's)
/** A run's worktree.json. */
export interface WorktreeInfo { path: string; repoPath: string; branch: string; [k: string]: unknown }
