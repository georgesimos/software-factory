// docs/plans/pipelines.md §7: named pipelines. Each is one more skills.json scope, owner/repo@id, listed in match order by the
// project's `pipelines` rule; the project scope itself is the default pipeline, always last. Matching only picks among
// configurations the owner approved, and a run only ever tightens (the meet).
import path from 'node:path';
import { CAP, COST_CAP, MAX_DIFF, isLocal } from './constants.ts';
import { rules } from './rules.ts';
import { isObj, readSkills, type SkillsConfig } from './skills.ts';
import { hostOf, projects } from './workspace.ts';
import type { FactoryEvent, Rule, Run, RunRoute } from './types.ts';

/** A pipeline id: a new lowercase name. "default" names the project's own pipeline, so it is never an id. */
export const isPipelineId = (x: unknown): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(x) && x !== 'default';
export const PIPELINE_SCOPE = /^[\w.-]+\/[\w.-]+@[a-z][a-z0-9-]{0,30}$/;
export const isPipelineScope = (s: unknown): s is string => typeof s === 'string' && PIPELINE_SCOPE.test(s) && isPipelineId(s.slice(s.indexOf('@') + 1));
/** owner/repo@id → {project: owner/repo, id}; any other scope → {project: scope, id: null}. */
export const splitScope = (scope: string) => { const i = scope.indexOf('@'); return i < 0 ? { project: scope, id: null } : { project: scope.slice(0, i), id: scope.slice(i + 1) }; };
/** What a pipeline scope may hold (§7.1). Custom steps and added review steps come with slice 5. */
export const PIPELINE_KEYS = ['name', 'rules'];
export const PIPELINE_RULES = ['match', 'steps.off', 'run.loops', 'run.budgetUsd'];
export const NAME_OK = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 60 && !/[\x00-\x1f\x7f]/.test(v);

/** One condition set (§7.2): every term holds (AND); a pipeline matches when any of its sets does (OR). */
export interface MatchSet { labels?: string[]; files?: string[]; maxDiffLines?: number }
const TERMS = ['labels', 'files', 'maxDiffLines'];
const okGlob = (g: unknown) => { if (typeof g !== 'string' || !g || g.length > 200 || /[\x00-\x1f\x7f]/.test(g)) return false; try { path.matchesGlob('x', g); return true; } catch { return false; } };
/** null when v is a valid match, else why not. */
export function matchProblem(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 5) return 'a JSON array of 1-5 condition sets';
  for (const [i, s] of v.entries()) {
    const at = `set ${i + 1}`;
    if (!isObj(s) || !Object.keys(s).length) return `${at}: a set is an object with labels, files or maxDiffLines (an empty one would match everything)`;
    const bad = Object.keys(s).filter((k) => !TERMS.includes(k));
    if (bad.length) return `${at}: unknown terms ${bad.join(', ')} (labels, files, maxDiffLines)`;
    if (s.labels !== undefined && !(Array.isArray(s.labels) && s.labels.length >= 1 && s.labels.length <= 10 && s.labels.every((l: unknown) => typeof l === 'string' && !!l.trim() && l.length <= 50 && !/[\x00-\x1f\x7f]/.test(l))))
      return `${at}: labels must be 1-10 label names`;
    if ((s.labels as string[] | undefined)?.some((l) => l.startsWith('factory:'))) return `${at}: factory:* labels are F's own, never a match`;
    if (s.files !== undefined && !(Array.isArray(s.files) && s.files.length >= 1 && s.files.length <= 20 && s.files.every(okGlob))) return `${at}: files must be 1-20 globs`;
    if (s.maxDiffLines !== undefined && !(Number.isInteger(s.maxDiffLines) && (s.maxDiffLines as number) >= 1 && (s.maxDiffLines as number) <= MAX_DIFF)) return `${at}: maxDiffLines must be an integer 1-${MAX_DIFF}`;
  }
  return null;
}
/** A condition set as people read it: "labels hotfix", "files docs/**, *.md · ≤ 40 lines". */
export const setText = (s: MatchSet) => [s.labels && `label${s.labels.length > 1 ? 's' : ''} ${s.labels.join(', ')}`, s.files && `files ${s.files.join(', ')}`, s.maxDiffLines && `≤ ${s.maxDiffLines} lines`].filter(Boolean).join(' · ');
export const matchText = (m: unknown) => (Array.isArray(m) ? m.map((s) => setText(s as MatchSet)).join(' or ') : 'nothing');

const gitHost = (repo: string) => { try { return !!projects()[repo] && hostOf(repo) === 'git'; } catch { return false; } };
/** maxDiffLines can't be trusted on a git project until #137: numstat reads `- -` under `* -diff`, so it would match everything. */
export const diffLinesTrusted = (repo: string) => !gitHost(repo);

/** The ids the project's `pipelines` rule lists, in match order (an expired rule lists nothing). */
export const listedOf = (repo: string, cfg: SkillsConfig = readSkills()) => (rules(repo, cfg).policy.pipelines?.value as string[] | undefined) ?? [];
/** Every named pipeline of a project: the listed ones in match order, then drafts (a scope nobody listed, which never matches). */
export function pipelinesOf(repo: string, cfg: SkillsConfig = readSkills()) {
  const listed = listedOf(repo, cfg), drafts = Object.keys(cfg).filter((s) => isPipelineScope(s) && splitScope(s).project === repo).map((s) => splitScope(s).id as string).filter((id) => !listed.includes(id));
  return [...listed.map((id) => ({ id, listed: true })), ...drafts.map((id) => ({ id, listed: false }))].map(({ id, listed: l }) => {
    const scope = `${repo}@${id}`, own = rules(scope, cfg).policy, m = own.match;
    return { id, scope, name: (cfg[scope] as { name?: string } | undefined)?.name ?? id, listed: l, match: (m?.value as MatchSet[] | undefined) ?? null, matchRule: m, policy: own };
  });
}
/** What a run gets from one pipeline (§7.3): its own steps.off (the default's is the project's), its caps (the lowest of the
 *  pipeline's, the project's and the built-in), and what it adds. Slice 5 fills custom steps, axes.on and a pipeline's own extra axes. */
export function runGets(repo: string, id: string | null, cfg: SkillsConfig = readSkills()) {
  const proj = rules(repo, cfg).policy, own = id ? rules(`${repo}@${id}`, cfg).policy : proj;
  const cap = (k: string, built: number) => Math.min(built, Number(proj[k]?.value ?? built), Number(own[k]?.value ?? built));
  return { off: [...((own['steps.off']?.value as string[] | undefined) ?? [])].sort(), offRule: own['steps.off'], caps: { loops: cap('run.loops', CAP), budgetUsd: cap('run.budgetUsd', COST_CAP) }, custom: [] as string[], axesOn: [] as string[], extra: [] as string[] };
}
const gets = (repo: string, id: string | null, cfg: SkillsConfig) => { const { offRule: _r, ...g } = runGets(repo, id, cfg); return JSON.stringify(g); };
/** True while any two of these pipelines (null: the default) differ in anything a run gets: then routing is a loosening (§7.3). */
export const pipelinesDiffer = (repo: string, ids: (string | null)[], cfg: SkillsConfig = readSkills()) => new Set(ids.map((id) => gets(repo, id, cfg))).size > 1;

/** The facts a pick matches on (§7.2): the labels intake recorded, the files F axes reviews, and the diff size facts() reads. */
export interface RouteFacts { labels: string[]; files: string[]; diffLines: number | null }
export function holds(s: MatchSet, f: RouteFacts, trusted = true) {
  if (s.labels && !s.labels.every((l) => f.labels.includes(l))) return false;
  if (s.files && !(f.files.length && f.files.every((x) => s.files!.some((g) => path.matchesGlob(x, g))))) return false; // every changed file, and at least one
  if (s.maxDiffLines !== undefined && !(trusted && f.diffLines !== null && f.diffLines <= s.maxDiffLines)) return false;
  return true;
}
/** The pick (§7.4): the first listed pipeline with a set that holds, else the default. local: a routing rule it read was set by
 *  a local (unverified) user, which on GitHub never counts toward an automatic merge (§7.6). */
export function pick(repo: string, f: RouteFacts, cfg: SkillsConfig = readSkills()) {
  const order = rules(repo, cfg).policy.pipelines, trusted = diffLinesTrusted(repo);
  let local = !!order && isLocal(order);
  for (const p of pipelinesOf(repo, cfg).filter((x) => x.listed)) {
    if (!p.match) continue; // none, or invalid: pipelinePass warned, and it never matches
    if (p.matchRule && isLocal(p.matchRule)) local = true;
    const set = p.match.findIndex((s) => holds(s, f, trusted));
    if (set >= 0) return { pipeline: p.id, name: p.name, set, text: setText(p.match[set]!), ...runGets(repo, p.id, cfg), local };
  }
  return { pipeline: 'default', name: null, set: null, text: null, ...runGets(repo, null, cfg), local };
}

/** A run's labels (§7.4): read once, at intake; a resume after needs-info reads them again. events: this run's (thisRun). */
export function runLabels(events: FactoryEvent[]) {
  let labels: string[] | undefined, parked = false;
  for (const e of events) {
    if (e.status === 'needs-info') parked = true;
    if (e.stage === 'intake' && e.status === 'started') { if (labels === undefined || parked) labels = Array.isArray(e.labels) ? e.labels.filter((l): l is string => typeof l === 'string') : []; parked = false; }
  }
  return labels ?? [];
}
const isRouted = (e: FactoryEvent) => e.stage === 'review' && e.status === 'routed'; // only F axes writes it: F event refuses routed on every stage
/** The meet so far (§7.4): every pick of this run, from its own records. off is the intersection, caps the minimum. */
export function routeOf(events: FactoryEvent[]): RunRoute | null {
  const rs = events.filter(isRouted);
  if (!rs.length) return null;
  const last = rs.at(-1)!, offs = rs.map((e) => (Array.isArray(e.off) ? e.off as string[] : []));
  const min = (k: 'loops' | 'budgetUsd', built: number) => Math.min(built, ...rs.map((e) => Number((e.caps as Record<string, number> | undefined)?.[k] ?? built)));
  return {
    pipeline: String(last.pipeline), name: (last.name as string | null) ?? null, set: (last.set as number | null) ?? null, text: (last.text as string | null) ?? null, facts: last.facts as RouteFacts,
    off: offs[0]!.filter((k) => offs.every((o) => o.includes(k))), caps: { loops: min('loops', CAP), budgetUsd: min('budgetUsd', COST_CAP) },
    local: rs.some((e) => e.local === true), picks: rs.map((e) => ({ pipeline: String(e.pipeline), set: (e.set as number | null) ?? null, iteration: e.iteration as number })),
  };
}
/** The routed event of the current iteration, if F axes already picked: one after the last build started. */
export const pickedThisIteration = (events: FactoryEvent[]) => events.slice(events.findLastIndex((e) => e.stage === 'build' && e.status === 'started') + 1).find(isRouted);
/** "pipeline hotfix (set 1: labels hotfix)", for decide's reasons and the run detail. */
export const routeText = (r: { pipeline: string; set: number | null; text: string | null }) => `pipeline ${r.pipeline}${r.set !== null ? ` (set ${r.set + 1}: ${r.text})` : ''}`;
export const ruleBy = (x: Rule) => (isLocal(x) ? 'a local user (unverified)' : x.setBy);
/** A run's caps (§7.5): the built-in, the project's, the pipeline it is on now and every pipeline it was routed to; the lowest wins. */
export function runCapsOf(r: Pick<Run, 'id' | 'route'>, cfg: SkillsConfig = readSkills()) {
  const repo = r.id.split(/[#:@]/)[0] as string, now = runGets(repo, r.route && r.route.pipeline !== 'default' ? r.route.pipeline : null, cfg).caps;
  return { loops: Math.min(now.loops, r.route?.caps.loops ?? CAP), budgetUsd: Math.min(now.budgetUsd, r.route?.caps.budgetUsd ?? COST_CAP) };
}
