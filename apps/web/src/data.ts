import { repoOf, type Burn, type BurnCell, type Deploy, type Metrics, type Run } from '@software-factory/design-system';

export interface Rule { key?: string; value?: unknown; scope?: string; setBy?: string; setAt?: string; reason?: string; until?: string }
export interface RuleChange { ts?: string; run?: string; status?: string; key?: string; value?: unknown; setBy?: string; reason?: string; until?: string }
export interface IdeaIssue { key?: string; title?: string; state?: string; run?: string; url?: string; dependsOn?: string[] }
export interface Idea {
  repo: string; phase?: string; stack?: string; visibility?: string; dryRun?: boolean; idea?: string; plan?: { vision?: string };
  milestones?: { name?: string; merged?: number; total?: number }[]; issues?: IdeaIssue[];
  burn?: { usd?: number; budgetUsd?: number; tokens?: number; over?: boolean };
  loop?: { state?: string; reason?: string; picked?: number; maxIssuesPerSession?: number };
  next?: IdeaIssue; remote?: { url?: string };
}
export interface Harness { id: string; label?: string; install?: string }
/** A step's runner in skills.json (packages/core/src/skills.ts checkRunner). Extra axes add `axis` and `when`. */
export interface StepRunner { use?: string; name?: string; path?: string; harness?: string; model?: string; effort?: string; fallback?: string[]; axis?: string; when?: string[] }
export interface CatalogEntry { source: string; group: string; name: string; kind: string; desc?: string; runner: StepRunner }
/** skillsData(): raw config (to tell "set here" from "inherited"), resolved plans, the catalog, models and presets. */
export interface SkillsData {
  error?: string; steps?: string[]; required?: string[]; scopes?: string[];
  config?: Record<string, Record<string, StepRunner | StepRunner[] | unknown>>;
  plans?: Record<string, { plan?: Record<string, StepRunner>; extra?: StepRunner[] }>;
  catalog?: { global?: CatalogEntry[]; projects?: Record<string, CatalogEntry[]> };
  models?: string[]; efforts?: string[]; preset?: string; presets?: Record<string, Record<string, [string, string]>>;
  applied?: string[]; skipped?: string[]; inherited?: string[];
}

/** What `page()` / `GET /api/state` carries (packages/server/src/server.ts pageData()). Every field but `runs` may be missing. */
export interface FactoryData {
  runs: Run[];
  generated?: string;
  cap?: number;
  costCap?: number;
  projects?: string[];
  metrics?: { all: Metrics; byProject: Record<string, Metrics> };
  /** The Artifact's Metrics sheet (#82): logMetrics() per project ('' for all) and range ('7', '30', '90', '' all time), as of `generated`. */
  metricsLog?: Record<string, Record<string, unknown>>;
  rules?: Record<string, { policy?: Record<string, Rule>; expired?: Rule[] }>;
  rulesError?: string;
  ruleHistory?: RuleChange[];
  harnesses?: Harness[];
  hooks?: { create?: boolean; ship?: boolean; connectors?: unknown };
  ideas?: Record<string, Omit<Idea, 'repo'>>;
  skills?: SkillsData;
  onboard?: Record<string, { ship?: string[] }>;
  /** How to run F here: a plugin install's real path. The Artifact drops it (a path), so use F_CMD then. */
  fCmd?: string | null;
  /** No F on this machine (the desktop app with no skill or plugin installed): the copy commands need one first. */
  fMissing?: boolean;
  /** F ui in the desktop app, which supplies node-pty: terminal sessions can start. */
  terminal?: boolean;
  /** F render's file: reload every this many ms to pick up new runs (the Artifact strips it). */
  reload?: number;
  /** Under F ui: runs whose session here stopped or crashed, which POST /api/sessions would resume. */
  resumable?: string[];
  /** Per attached project: false when auto-merge is off. */
  autoMerge?: Record<string, boolean>;
  /** The F ui token. Only set when the page was opened from `F ui`; writes need it. */
  token?: string;
}

// packages/core/src/constants.ts defaults, for data that does not carry them.
export const CAP = 3;
export const COST_CAP = 5;

declare global { interface Window { __FACTORY_DATA__?: unknown } }

const isData = (d: unknown): d is FactoryData => !!d && typeof d === 'object' && Array.isArray((d as FactoryData).runs);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});
const arr = <T = unknown>(x: unknown): T[] => (Array.isArray(x) ? x : []);

/** Every repo with a run, attached projects that have none yet, and F new projects. */
export const projectsOf = (d: FactoryData) => [...new Set([...(d.projects ?? []), ...d.runs.map((r) => repoOf(r.id)), ...Object.keys(d.ideas ?? {})])];

// Burn, deploys and sessions come from logs and transcripts: keep only well-formed cells, so render code can trust shapes.
const cell = (c: unknown): BurnCell | null => {
  const x = obj(c);
  return num(x.tokens) ? { tokens: x.tokens, costUsd: num(x.costUsd) ? x.costUsd : null, unpriced: num(x.unpriced) ? x.unpriced : 0,
    used: typeof x.used === 'string' && /^[\w.:[\]-]{1,64}$/.test(x.used) ? x.used : null } : null;
};
const cells = (m: unknown) => Object.fromEntries(Object.entries(obj(m)).map(([k, v]) => [k, cell(v)]).filter((e): e is [string, BurnCell] => !!e[1]));
const burnOf = (b: unknown): Burn | null => {
  const x = obj(b), total = cell(x.total);
  return total ? { measured: x.measured === true, total, byStage: cells(x.byStage), byIteration: cells(x.byIteration), byAxis: cells(x.byAxis), reported: cell(x.reported) } : null;
};
export function normRun(r: Run): Run {
  const deploys = arr<Deploy>(r.deploys).filter((d) => d && d.connector != null && d.env != null)
    .map((d) => ({ ...d, connector: String(d.connector), env: String(d.env), state: String(d.state || '?'), status: String(d.status || ''), at: d.at || (d as { ts?: string }).ts }));
  const sessions = arr<NonNullable<Run['sessions']>[number]>(r.sessions).filter((s) => s && s.id != null).map((s) => ({ ...s, id: String(s.id) }))
    .sort((a, b) => (Date.parse(b.last ?? '') || 0) - (Date.parse(a.last ?? '') || 0));
  return { ...r, id: String(r.id), events: arr(r.events), loopbacks: arr(r.loopbacks), children: arr(r.children), issues: arr(r.issues), notes: arr<NonNullable<Run['notes']>[number]>(r.notes).filter((n) => n && typeof n.text === 'string'), burn: burnOf(r.burn), deploys, sessions };
}
export const normData = (d: FactoryData): FactoryData => ({ ...d, runs: d.runs.filter((r) => r && r.id != null).map(normRun) });

/** A write through the F ui API: the token header, a JSON body; the browser adds Origin. Throws the server's error. */
export async function post<T>(route: string, body: unknown, token: string): Promise<T> {
  const res = await fetch('/api' + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory-token': token }, body: JSON.stringify(body) });
  const x = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(x.error || `request failed (${res.status})`);
  return x;
}

/** `?t=` from `F ui`'s URL. */
export const uiToken = () => new URLSearchParams(location.search).get('t') || undefined;

/**
 * Injected data first (a host-set `window.__FACTORY_DATA__`, or the #data tag), then `GET /api/state` with the `F ui`
 * token from `?t=`, then the fixture in dev. A production build never shows fixture runs.
 */
export async function loadData(): Promise<FactoryData> {
  if (isData(window.__FACTORY_DATA__)) return normData(window.__FACTORY_DATA__);
  let why = 'No run data was injected and no `F ui` token is in the URL.';
  const tag = document.getElementById('data')?.textContent?.trim() ?? '';
  if (tag.startsWith('{')) {
    try {
      const d: unknown = JSON.parse(tag);
      if (isData(d)) return normData(d);
    } catch {
      why = 'The injected run data is not valid JSON, and no `F ui` token is in the URL.';
    }
  }

  const token = uiToken();
  if (token) {
    try {
      // The API is always at the server root (API.md), wherever the page itself is served.
      const res = await fetch('/api/state', { headers: { 'x-factory-token': token } });
      const body: unknown = res.ok ? await res.json().catch(() => null) : null; // a dev server may answer with index.html
      if (isData(body)) return { ...normData(body), token };
      why = `GET /api/state answered ${res.status}${res.ok ? ' without a run list' : ''}.`;
    } catch (e) {
      why = `GET /api/state failed: ${(e as Error).message}`;
    }
    throw new Error(why); // never swap live data for the dev fixture: App keeps the last good data and retries
  }
  if (import.meta.env.DEV) {
    const f = (await import('../fixtures/state.json')).default as unknown as FactoryData;
    return normData({ ...f, generated: new Date().toISOString() });
  }
  throw new Error(why);
}
