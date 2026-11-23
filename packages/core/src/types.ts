// The event log's shapes and the Run that derive() builds from them. Types only: no runtime code, no imports.
// Events come from events.jsonl (JSON.parse): F validates what it records, but a hand-edited log can hold anything, so
// every event field is optional and readers keep their guards.

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
export interface LocalChecks { sha?: string; state?: string; commands?: { cmd: string; exit: number }[] }
export interface Deploy { connector?: string; kind?: string; env?: string; state?: string; status?: string; url?: string; sha?: string; at?: string; detail?: string; creator?: string; ts?: string }
export interface Note { id?: string; step?: string; text?: string; by?: string; ts?: string; state: 'pending' | 'applied'; appliedTo?: string[]; appliedAt?: string; claim?: unknown }
export interface Session { agent?: string; id: string; cwd?: string; last?: string }

/** One line of events.jsonl. */
export interface FactoryEvent {
  ts: string; run: string; stage: string; status: string;
  title?: string; url?: string; pr?: string; branch?: string; spec?: string; issues?: number[]; children?: string[];
  author?: string; association?: string; source?: string; imported?: boolean; origin?: string; originAssociation?: string;
  harness?: string; sessionId?: string; cwd?: string;
  costUsd?: number; tokens?: number; usage?: Usage; model?: string;
  axis?: string; axes?: string[]; role?: string; sha?: string; findings?: Finding[]; runner?: Runner; localChecks?: LocalChecks;
  next?: string; reasons?: string[]; action?: string; by?: string; mergedBy?: string | null; reason?: string;
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
export interface Loopback { iteration: number; route?: string; reasons?: string[]; ts: string }

export type Outcome = 'in-progress' | 'rejected' | 'needs-info' | 'merged' | 'escalated' | 'closed' | 'awaiting-approval' | 'split';

/** What derive() builds per run id; archive.jsonl holds the same shape with `archived` and `sessionEvents`. */
export interface Run {
  id: string; iteration: number; outcome: Outcome; events: FactoryEvent[]; loopbacks: Loopback[];
  /** iteration → axis → review */
  reviews: Record<number, Record<string, AxisReview>>;
  /** iteration → axes requested */
  axes?: Record<number, string[]>;
  stage?: string; status?: string; started?: string; updated?: string; durationMs?: number;
  title?: string; url?: string; pr?: string; branch?: string; spec?: string; issues?: number[]; children?: string[]; parent?: string;
  author?: string; association?: string; source?: string; imported?: boolean; origin?: string; originAssociation?: string;
  sessions?: Session[]; costUsd?: number; tokens?: number; burn?: Burn;
  localChecks?: LocalChecks; reviewedSha?: string; runners?: Record<string, Runner | undefined>;
  decision?: { action?: string; reasons?: string[] };
  humanMerge?: { by?: string | null; sha?: string; ts: string };
  reverted?: { pr?: string; reason?: string };
  deploys?: Deploy[]; notes?: Note[];
  archived?: boolean; sessionEvents?: { ts: string; stage: string; status: string; sessionId: string }[];
}
