import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostOf, ls, projects, trackerOf } from './workspace.ts';
import { audit, checkGuide, checkRules, checkScope, pageRefusal, pipelinePass, rules, runCaps, stamp, whoami } from './rules.ts';
import { humanOnly } from './projectset.ts';
import { line, ttyAsk } from './approve.ts';
import { NAME_OK, PIPELINE_KEYS, PIPELINE_RULES, SLOTS, addedOf, allOf, isPipelineScope, okGlob, ownersOf, pipelinesOf, runGets, splitScope, type CustomStep, type Slot } from './route.ts';
import { customOf } from './custom.ts';
import { harnesses, type Harness } from '../../adapters/harnesses/index.ts';
import { stateDir } from './log.ts';
import type { ExtraAxis } from './gate.ts';
import { isLocal } from './constants.ts';
import type { Rule } from './types.ts';

// Who does each step: the built-in brief, the user's own skill or brief, or a harness's tool.
// User-local only (io.dir/skills.json): a repo, and so a PR, can never pick its own reviewers.
export type BuiltinAxis = 'code' | 'security' | 'ux' | 'ui' | 'seo' | 'docs';
export const BUILTIN_AXES: BuiltinAxis[] = ['code', 'security', 'ux', 'ui', 'seo', 'docs'];
export const REQUIRED_AXES: BuiltinAxis[] = ['code', 'security']; // axesFor always selects them; config can swap who reviews, never drop them
export type StepKey = 'intake' | 'spec' | 'build' | `review.${BuiltinAxis}` | 'verifier' | 'postmerge';
export const STEP_KEYS: StepKey[] = ['intake', 'spec', 'build', ...BUILTIN_AXES.map((a) => `review.${a}` as const), 'verifier', 'postmerge'];
export const isStepKey = (k: unknown): k is StepKey => STEP_KEYS.some((x) => x === k);
// docs/plans/pipelines.md §2: what no config can turn off or move. gate, merge and watch (F postmerge) are F's own decisions, not runners.
export const LOCKED_STEPS = ['intake', 'spec', 'build', ...REQUIRED_AXES.map((a) => `review.${a}`), 'verifier', 'gate', 'merge', 'watch'];
export const OPTIONAL_STEPS = BUILTIN_AXES.filter((a) => !REQUIRED_AXES.includes(a)).map((a) => `review.${a}`);
// When axesFor (gate.ts) selects each built-in axis: always, or when a UI, SEO or docs file changes. axesFor reads this table,
// so the Pipelines page and the engine can't disagree.
export const AXIS_WHEN: Record<BuiltinAxis, 'always' | 'ui' | 'seo' | 'docs'> = { code: 'always', security: 'always', ux: 'ui', ui: 'ui', seo: 'seo', docs: 'docs' };
/** The pipeline's structure for the Pipelines page (docs/plans/pipelines.md §6). adds: its custom steps by slot and the axes it
 *  always reviews (axes.on, a pipeline's only). */
export function pipeline(repo: string, extra: ExtraAxis[] = [], rl: { policy: Record<string, Rule>; warnings: string[] } = { policy: {}, warnings: [] },
  adds: { custom: Record<Slot, CustomStep[]>; on: string[] } = { custom: { 'spec.after': [], 'build.after': [] }, on: [] }) {
  const attached = !!projects()[repo], host = attached ? hostOf(repo) : null;
  const warnings: string[] = rl.warnings.filter((w) => /\.rules\.(steps\.off|run\.|match|pipelines)|@|\.name is ignored|\.steps\.custom|\.axes\.on/.test(w)); // pipelinePass's, about pipelines
  const o = rl.policy['steps.off'], offBy = o && (isLocal(o) ? 'a local user (unverified)' : o.setBy); // never the OS user (§6)
  let tracker: string | null = null;
  if (host) try { const t = trackerOf(repo); tracker = t === 'local' ? null : t; } catch (e) { warnings.push((e as Error).message); } // local: no tracker yet (5b)
  return {
    host, tracker, locked: LOCKED_STEPS, optional: OPTIONAL_STEPS,
    steps: ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch'],
    intake: ['pass', 'split', 'needs-info', 'reject'], loops: ['spec', 'build'], // intake's outcomes; where the gate loops back to
    axes: [...BUILTIN_AXES.map((axis) => ({ axis, when: (adds.on.includes(`review.${axis}`) ? 'always' : AXIS_WHEN[axis]) as string | string[] })), ...extra.map((x) => ({ axis: x.axis, when: x.when }))],
    off: o ? (o.value as string[]).map((step) => ({ step, scope: (o.scope ?? repo) as string, reason: o.reason, by: offBy as string, ...(o.until && { until: o.until }) })) : [],
    caps: runCaps(rl.policy), custom: adds.custom, on: adds.on, warnings,
  };
}
export const isBuiltinAxis = (a: unknown): a is BuiltinAxis => BUILTIN_AXES.some((x) => x === a);

/** A step's runner in skills.json, as checkRunner() admits it. */
export interface StepRunner { use: string; name?: string; path?: string; harness?: string; model?: string; effort?: string; fallback?: string[] }
/** An extra review axis (axes.extra): a runner plus gate's axis and the globs that select it. */
export interface ExtraAxisRunner extends StepRunner, ExtraAxis {}
/** One scope of skills.json ("default" or owner/repo): a runner per step, extra axes, rules and guidance. */
export type ScopeConfig = Partial<Record<StepKey, StepRunner>> & { 'axes.extra'?: ExtraAxisRunner[]; 'steps.custom'?: CustomStep[]; 'axes.on'?: string[]; name?: string; rules?: Record<string, Rule>; guide?: Record<string, string> };
export type SkillsConfig = Record<string, ScopeConfig>;
/** An entry of the Skills sheet's runner picker. */
export interface CatalogItem { source: string; group: string; name: string; kind: string; desc: string; runner: StepRunner }
// A JSON object read from a file or a request: checked, not trusted.
export const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export const harnessIds = (): string[] => harnesses.map((h) => h.id);
export const NAME = /^[\w.-]+(:[\w.-]+)?$/; // skill, plugin:skill or agent type; it ends up in a command line
export const skillsFile = () => path.join(stateDir(), 'skills.json');

// Per-step models (docs/research/model-routing.md §1-2). [model, effort] per step; aliases, which the Agent tool takes.
type Preset = Partial<Record<StepKey, [model: string, effort: string]>>;
const ALL_CLAUDE: Preset = { intake: ['fable', 'medium'], spec: ['fable', 'high'], build: ['opus', 'high'], 'review.code': ['fable', 'high'], 'review.security': ['fable', 'high'],
    'review.ux': ['sonnet', 'high'], 'review.ui': ['sonnet', 'high'], 'review.seo': ['haiku', 'medium'], 'review.docs': ['haiku', 'medium'], verifier: ['fable', 'medium'] };
export const PRESETS: Record<string, Preset> = {
  'all-claude': ALL_CLAUDE,
  'all-claude-lean': { intake: ['fable', 'medium'], spec: ['opus', 'high'], build: ['opus', 'high'], 'review.code': ['sonnet', 'high'], 'review.security': ['opus', 'high'],
    'review.ux': ['sonnet', 'high'], 'review.ui': ['sonnet', 'high'], 'review.seo': ['haiku', 'medium'], 'review.docs': ['haiku', 'medium'], verifier: ['opus', 'medium'] },
};
export const DEFAULT_PRESET = 'all-claude'; // the built-in plan; 'all-claude-lean' is the open alternative
const DEFAULT_PLAN = ALL_CLAUDE; // PRESETS[DEFAULT_PRESET]
const FALLBACK: Record<string, string[]> = { fable: ['opus'], opus: ['sonnet'], sonnet: ['opus'], haiku: ['sonnet'] }; // overloaded or unavailable: stay inside Claude
const MODEL_KEYS = ['model', 'effort', 'fallback'];
// Default, skill and brief runners run on the host harness (Claude Code); a provider on its own. Only a harness with models() takes a model.
const runsOn = (s: { use?: unknown; harness?: unknown }): Harness | undefined => harnesses.find((h) => (s.use === 'provider' ? h.id === s.harness : h.host));
const presetRunner = <T extends Partial<StepRunner>>([model, effort]: [string, string], base: T) => ({ ...base, model, effort, fallback: FALLBACK[model] });
// A brief must live outside any worktree, so a branch can't supply it: an absolute path, or ~. The Windows forms only on
// Windows, because on macOS and Linux `C:\x.md` and `~\x.md` are relative paths.
const BRIEF: Record<'posix' | 'win32', RegExp> = { posix: /^(\/|~\/).*\.md$/, win32: /^(\/|~[\\/]|[A-Za-z]:[\\/]).*\.md$/ };
export function checkRunner(s: unknown, at: string, more: string[] = [], platform: string = process.platform): asserts s is Record<string, unknown> {
  if (!isObj(s)) throw new Error(`${at}: a runner must be a JSON object`);
  const bad = Object.keys(s).filter((k) => !['use', 'name', 'path', 'harness', ...MODEL_KEYS, ...more].includes(k));
  if (bad.length) throw new Error(`${at}: unknown fields ${bad.join(', ')}`);
  const ok = s.use === 'default' && !s.name && !s.path && !s.harness
    || s.use === 'skill' && typeof s.name === 'string' && NAME.test(s.name) && !s.path && !s.harness
    || s.use === 'brief' && typeof s.path === 'string' && BRIEF[platform === 'win32' ? 'win32' : 'posix'].test(s.path) && !s.name && !s.harness
    || s.use === 'provider' && harnessIds().some((id) => id === s.harness) && (s.name === undefined || typeof s.name === 'string' && NAME.test(s.name)) && !s.path;
  if (!ok) throw new Error(`${at}: expected {"use":"default"}, {"use":"skill","name"}, {"use":"brief","path":"/abs/or/~/….md"} or {"use":"provider","harness":"${harnessIds().join('|')}","name"?}`);
  if (s.model === undefined && s.effort === undefined && s.fallback === undefined) return;
  const h = runsOn(s), ids = (h?.models?.() || []).map((m) => m.alias), has = (xs: string[], x: unknown) => xs.some((y) => y === x);
  if (!h || !ids.length) throw new Error(`${at}: ${h?.label || s.harness} runners can't set model, effort or fallback`); // no h: no ids
  if (s.model !== undefined && !has(ids, s.model)) throw new Error(`${at}: model must be one of ${ids.join('|')}`);
  if (s.effort !== undefined && !has(h.efforts || [], s.effort)) throw new Error(`${at}: effort must be one of ${(h.efforts || []).join('|') || 'nothing for ' + h.label}`);
  const fb: unknown = s.fallback, list: unknown[] = Array.isArray(fb) ? fb : [];
  if (fb !== undefined && !(Array.isArray(fb) && list.length >= 1 && list.length <= 3 && list.every((m) => has(ids, m)) && new Set(list).size === list.length && !list.includes(s.model)))
    throw new Error(`${at}: fallback must be 1-3 distinct ${h.label} models (${ids.join('|')}), not the model itself`);
}
// A custom step's id: a new lowercase name, never one of F's steps, axes or decisions (pipelines §4).
const RESERVED = [...new Set([...STEP_KEYS, ...BUILTIN_AXES, ...LOCKED_STEPS, 'review', 'default', 'custom'])];
export function checkCustom(v: unknown, at: string): void {
  if (!Array.isArray(v) || v.length > 10) throw new Error(`${at}: must be an array of at most 10 custom steps {id, slot, use, …}`);
  const seen = new Set<unknown>(), list: unknown[] = v;
  for (const x of list) {
    checkRunner(x, at, ['id', 'slot', 'when']);
    const id = x.id, step = `${at}: custom step "${String(id)}"`;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(id) || RESERVED.includes(id)) throw new Error(`${at}: custom step id "${String(id)}" must be a new lowercase name, not one of F's steps or axes (${RESERVED.join(', ')})`);
    if (seen.has(id)) throw new Error(`${step} is listed twice`);
    seen.add(id);
    if (!SLOTS.some((sl) => sl === x.slot)) throw new Error(`${step}: slot must be ${SLOTS.join(' or ')}`);
    if (x.use === 'default') throw new Error(`${step} has no built-in brief; use a skill, brief or provider`);
    if (x.when !== undefined && x.slot !== 'build.after') throw new Error(`${step}: when is for build.after only (a spec.after step runs before there is a diff, so it is always due)`);
    const when: unknown = x.when;
    if (when !== undefined && !(Array.isArray(when) && when.length >= 1 && when.length <= 20 && when.every(okGlob))) throw new Error(`${step}: when must be 1-20 globs`);
  }
}
export function checkStep(key: string, v: unknown, at: string): void {
  if (key === 'rules') return checkRules(v, at);
  if (key === 'guide') return checkGuide(v, at);
  if (key === 'steps.custom') return checkCustom(v, at);
  if (key === 'axes.on') { // §7.1: optional built-in axes a pipeline always reviews
    if (!(Array.isArray(v) && v.length >= 1 && v.length <= OPTIONAL_STEPS.length && new Set(v).size === v.length && v.every((k) => OPTIONAL_STEPS.includes(k)))) throw new Error(`${at}: must be 1-${OPTIONAL_STEPS.length} distinct optional review steps (${OPTIONAL_STEPS.join(', ')})`);
    return;
  }
  if (key !== 'axes.extra') {
    if (!isStepKey(key)) throw new Error(`${at}: unknown step "${key}" (${STEP_KEYS.join('|')}|axes.extra|steps.custom)`);
    return checkRunner(v, at);
  }
  if (!Array.isArray(v)) throw new Error(`${at}: must be an array of {axis, when, use, …}`);
  const list: unknown[] = v;
  for (const x of list) {
    checkRunner(x, at, ['axis', 'when']);
    const when: unknown = x.when;
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(String(x.axis || '')) || isBuiltinAxis(x.axis)) throw new Error(`${at}: extra axis "${x.axis}" must be a new lowercase name; configure built-in axes as review.<axis>`);
    if (!Array.isArray(when) || !when.length || !when.every((g: unknown) => typeof g === 'string' && g)) throw new Error(`${at}: extra axis "${x.axis}" needs "when": ["<glob>", …]`);
    if (x.use === 'default') throw new Error(`${at}: extra axis "${x.axis}" has no built-in brief; use a skill, brief or provider`);
  }
}
// Asserts the shape SkillsConfig names: every scope, step, runner, extra axis, rule and guide checked.
export function checkSkills(cfg: unknown): asserts cfg is SkillsConfig {
  if (!isObj(cfg)) throw new Error('skills.json must be a JSON object');
  for (const [scope, steps] of Object.entries(cfg)) {
    const pipe = isPipelineScope(scope);
    if (scope !== 'default' && !/^[\w.-]+\/[\w.-]+$/.test(scope) && !pipe) throw new Error(`skills.json: scope "${scope}" must be "default", owner/repo or owner/repo@<pipeline id>`);
    if (!isObj(steps)) throw new Error(`skills.json: ${scope} must be an object`);
    for (const [k, v] of Object.entries(steps)) {
      const at = `skills.json ${scope}.${k}`;
      if (k === 'name') { if (!pipe) throw new Error(`${at}: only a pipeline (owner/repo@id) has a name`); if (!NAME_OK(v)) throw new Error(`${at}: a name is 1-60 characters of text`); continue; }
      if (pipe && !PIPELINE_KEYS.includes(k)) throw new Error(`${at}: ${PIPELINE_HOLDS}`);
      if (pipe && k === 'steps.custom' && Array.isArray(v) && v.some((x) => isObj(x) && x.slot === 'spec.after')) throw new Error(`${at}: spec.after custom steps are the project's only: a pipeline is picked after build (docs/plans/pipelines.md §7.4)`);
      if (!pipe && k === 'axes.on') throw new Error(`${at}: axes.on is a pipeline's (owner/repo@id): on a project, set the axis's runner as review.<axis>`);
      checkStep(k, v, at);
      if (k === 'rules' && isObj(v)) for (const key of Object.keys(v)) { // where each rule may live (§7.1)
        if (pipe ? !PIPELINE_RULES.includes(key) : key === 'match' || (scope === 'default' && key === 'pipelines')) throw new Error(`${at}.${key}: ${pipe ? `${key} is the project's rule` : key === 'match' ? 'match is a pipeline\'s rule' : 'pipelines is a per-project rule'}`);
      }
    }
  }
  // §7.1: one id namespace per project, custom steps and extra axes together, across the project and all its pipelines
  for (const project of new Set(Object.keys(cfg).filter((s) => s !== 'default').map((s) => splitScope(s).project))) {
    const { owners, dropped } = ownersOf(project, cfg), x = dropped[0];
    if (x) throw new Error(`skills.json ${x.owner}: "${x.id}" is already ${x.first}'s: ids are unique across a project and its pipelines`);
    const p = owners[0]!, both = p.custom.find((c) => p.extra.some((e) => e.axis === c.id)); // owners[0]: the project
    if (both) throw new Error(`skills.json ${project}: "${both.id}" is both a custom step and an extra axis: ids are unique across a project and its pipelines`);
  }
}
/** What a pipeline scope may hold, as the refusals say it (§7.1). */
export const PIPELINE_HOLDS = 'a pipeline holds name, rules (match, steps.off, run.loops, run.budgetUsd), build.after custom steps (steps.custom), axes.on and its own extra axes (axes.extra); runners and guidance are the project\'s';
// On read, a model, effort or fallback the harness no longer offers is dropped with a warning instead of failing every
// command; setSkill and applyPreset still refuse them, since writeSkills checks strictly. The next write saves the drop.
const warned = new Set<string>();
export function dropUnknownModels(cfg: unknown): unknown {
  if (!isObj(cfg)) return cfg;
  const drop = (r: unknown, at: string): unknown => {
    if (!isObj(r) || (r.model === undefined && r.effort === undefined && r.fallback === undefined)) return r;
    const h = runsOn(r), ids = (h?.models?.() || []).map((m) => m.alias), has = (xs: string[], x: unknown) => xs.some((y) => y === x);
    if (!h || !ids.length) return r; // checkRunner names the real problem (no h: no ids)
    const out: Record<string, unknown> = { ...r }, gone: string[] = [];
    if (r.model !== undefined && !has(ids, r.model)) { gone.push(`model ${r.model}`); delete out.model; }
    if (r.effort !== undefined && !has(h.efforts || [], r.effort)) { gone.push(`effort ${r.effort}`); delete out.effort; }
    let same = '';
    const fb: unknown = r.fallback;
    if (Array.isArray(fb)) {
      const list: unknown[] = fb, keep = list.filter((m) => has(ids, m) && m !== out.model), unknown = list.filter((m) => !has(ids, m));
      if (unknown.length) gone.push(`fallback ${unknown.join(',')}`);
      if (keep.length + unknown.length < list.length) same = `fallback ${out.model} (same as the model)`;
      if (keep.length) out.fallback = keep; else delete out.fallback;
    }
    const what = [gone.length && `${gone.join(', ')} (${h.label} offers ${ids.join('|')})`, same].filter(Boolean).join('; ');
    const msg = `skills.json ${at}: ignoring ${what}; the next settings change removes it from the file`;
    if (what && !warned.has(msg)) { warned.add(msg); console.error(msg); }
    return out;
  };
  return Object.fromEntries(Object.entries(cfg).map(([scope, steps]) => [scope, !isObj(steps) ? steps
    : Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, k === 'rules' || k === 'guide' ? v
      : k === 'axes.extra' || k === 'steps.custom' ? (Array.isArray(v) ? v.map((x: unknown) => drop(x, `${scope}.${k}`)) : v) : drop(v, `${scope}.${k}`)]))]));
}
export function readSkills(): SkillsConfig {
  try {
    const cfg = pipelinePass(dropUnknownModels(JSON.parse(fs.readFileSync(skillsFile(), 'utf8'))));
    checkSkills(cfg);
    return cfg;
  } catch (e) {
    const err = e as NodeJS.ErrnoException; // what readFileSync, JSON.parse and checkSkills throw
    if (err.code === 'ENOENT') return {};
    throw new Error(err.message.startsWith('skills.json') ? err.message : `skills.json: ${err.message}`);
  }
}
// The resolved plan: per step the project's runner, else the global one, else the built-in. Extra axes add up, project wins per axis.
export function skills(repo: string, cfg: SkillsConfig = readSkills()) {
  const g: ScopeConfig = cfg.default || {}, p: ScopeConfig = cfg[repo] || {};
  // Claude-run steps fill what they don't set, field by field, from the global step (so a global preset reaches a project
  // that only swaps the runner), then the default preset. A fallback follows its model and can't be the chosen model.
  const fill = (k: StepKey, r: StepRunner): StepRunner => {
    const preset = DEFAULT_PLAN[k];
    if (!preset || !runsOn(r)?.models) return r;
    const up: Partial<StepRunner> = r !== g[k] && runsOn(g[k] || { use: 'default' }) === runsOn(r) ? g[k] || {} : {};
    const d = presetRunner(preset, {}), model = r.model || up.model || d.model;
    const fallback = (r.fallback || (!r.model && up.model && up.fallback) || FALLBACK[model] || []).filter((m) => m !== model); // FALLBACK covers every model a harness offers today
    const { fallback: _f, ...rest } = r;
    return { ...rest, model, effort: r.effort || up.effort || d.effort, ...(fallback.length && { fallback }) };
  };
  const plan = Object.fromEntries(STEP_KEYS.map((k) => [k, fill(k, p[k] || g[k] || { use: 'default' })]));
  const all = [...(g['axes.extra'] || []), ...(p['axes.extra'] || [])];
  const extra = all.filter((x, i) => all.findLastIndex((y) => y.axis === x.axis) === i);
  const rl = rules(repo, cfg);
  // §7.1: the project's named pipelines, listed ones in match order then drafts, each drawn like the default (which is `pipeline`)
  const pipelines = repo ? pipelinesOf(repo, cfg).map((p) => { const a = addedOf(repo, [p.id], cfg);
    return { id: p.id, name: p.name, listed: p.listed, match: p.match, ...(p.matchRule && { matchBy: p.matchRule.setBy, matchReason: p.matchRule.reason }),
      ...pipeline(repo, [...extra, ...a.extra], rules(p.scope, cfg), { custom: customOf(repo, [p.id], cfg), on: a.on }), caps: runGets(repo, p.id, cfg).caps }; }) : [];
  return { repo, plan, extra, required: REQUIRED_AXES, guide: rl.guide, pipeline: pipeline(repo, extra, rl, { custom: customOf(repo, [], cfg), on: [] }), pipelines };
}
export function writeSkills(cfg: unknown): asserts cfg is SkillsConfig {
  checkSkills(cfg);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(skillsFile() + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(skillsFile() + '.tmp', skillsFile());
}
// docs/plans/pipelines.md §5, §7.3: the skills writes that take a check away. Adding or reordering custom steps, or adding a
// review step, only adds checks above the built-in floor; removing one (or moving it, or narrowing when it runs) is guarded.
export const GUARDED_SKILLS = ['steps.custom', 'axes.on', 'axes.extra'];
type Cfg = Record<string, Record<string, unknown>>;
const applied = (cfg: Cfg, scope: string, key: string, value: unknown) => {
  const out: Cfg = { ...cfg }, next: Record<string, unknown> = { ...cfg[scope], [key]: value };
  if (value === undefined) delete next[key];
  if (Object.keys(next).length) out[scope] = next; else delete out[scope];
  return out;
};
const listOf = (x: unknown) => (Array.isArray(x) ? x.filter(isObj) : []);
/** What a skills write takes away, or null. Compared on what runs: a project's custom steps are default's with its own in place. */
export function skillLoosens(scope: string, key: string, value: unknown, cfg: Cfg = readSkills()): string | null {
  if (!GUARDED_SKILLS.includes(key) || (key === 'axes.extra' && !isPipelineScope(scope))) return null; // a project's extra axes: the known gap (§5)
  const after = applied(cfg, scope, key, value);
  if (key === 'steps.custom') {
    const eff = (c: Cfg) => (scope === 'default' || isPipelineScope(scope) ? listOf(c[scope]?.['steps.custom'])
      : listOf(c[scope]?.['steps.custom']).reduce((a: Record<string, unknown>[], x) => { const i = a.findIndex((y) => y.id === x.id); if (i >= 0) a[i] = x; else a.push(x); return a; }, [...listOf(c.default?.['steps.custom'])]));
    const next = eff(after);
    for (const o of eff(cfg)) {
      const n = next.find((x) => x.id === o.id);
      if (!n || n.slot !== o.slot) return 'removing a custom step';
      if (n.when !== undefined && JSON.stringify(n.when) !== JSON.stringify(o.when)) return 'narrowing when a custom step runs'; // no when: every change, the widest
    }
    return null;
  }
  if (key === 'axes.on') { const next = (after[scope]?.['axes.on'] as unknown[] | undefined) ?? []; return ((cfg[scope]?.['axes.on'] as unknown[] | undefined) ?? []).every((k) => next.includes(k)) ? null : 'removing an added review step'; }
  const next = listOf(after[scope]?.['axes.extra']); // a pipeline's own extra axes
  return listOf(cfg[scope]?.['axes.extra']).every((o) => next.some((n) => n.axis === o.axis && JSON.stringify(n.when) === JSON.stringify(o.when))) ? null : 'removing an added review step';
}
/** A guarded skills value as people read it: the ids or axes it holds. */
export const shownSkill = (key: string, v: unknown) => {
  const xs = Array.isArray(v) ? v.map((x) => (isObj(x) ? `${x.id ?? x.axis}${x.slot ? ` (${x.slot}${Array.isArray(x.when) ? `, when ${x.when.join(', ')}` : ''})` : Array.isArray(x.when) ? ` (when ${x.when.join(', ')})` : ''}` : String(x))) : [];
  return xs.length ? xs.join(', ') : 'nothing';
};
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The terminal command for a skills write, built from checked values only. */
export const skillCommand = (scope: string, key: string, value: unknown) => value === undefined ? `F skills unset ${scope} ${key} --reason "…"` : `F skills set ${scope} ${key} ${shq(JSON.stringify(value))} --reason "…"`;
/** F's own reading of a skills write, without writing: the stored value, the new one, what it takes away and the command.
 *  The page's route asks it before requesting; the desktop dialog shows it, and asks again on confirm. */
export function skillChange(scope: string, key: string, value: unknown, cfg: Cfg = readSkills()) {
  checkScope(scope);
  if (value === undefined && !Object.hasOwn(cfg[scope] ?? {}, key)) throw new Error(`no ${key} set for ${scope}`);
  checkSkills(applied(cfg, scope, key, value)); // never ask about a write that would fail
  return { scope, key, stored: cfg[scope]?.[key], value, doing: skillLoosens(scope, key, value, cfg), command: skillCommand(scope, key, value) };
}
// value === undefined removes the step from that scope, so a project inherits the global choice again.
// page: the write comes from the dashboard's route, which may only request a guarded one (§5); ask: the typed confirmation.
export function setSkill(scope: string, key: string, value: unknown, { reason, page, ask = ttyAsk }: { reason?: string; page?: boolean; ask?: (prompt: string) => string } = {}): ScopeConfig {
  if (key === 'rules' || key === 'guide') throw new Error(`"${key}" is set with "rules set", which records who changed it and why`);
  checkScope(scope); // a string: POST bodies pass scope through
  if (value === undefined && !isStepKey(key) && key !== 'name' && !GUARDED_SKILLS.includes(key)) throw new Error(`unknown step "${key}"`);
  const cfg: Cfg = readSkills(), after = applied(cfg, scope, key, value), doing = skillLoosens(scope, key, value, cfg); // after: unchecked until checkSkills
  if (doing && page) throw pageRefusal(doing, skillCommand(scope, key, value));
  if (doing) humanOnly(doing);
  checkSkills(after); // checked first: never ask about a write that would fail
  let who: ReturnType<typeof whoami> | undefined;
  if (doing) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw new Error(`${doing} needs a reason (--reason "…", at most 200 characters)`);
    who = whoami(doing);
    if (ask(`${scope}: ${doing}\n${key}: ${shownSkill(key, cfg[scope]?.[key])} -> ${shownSkill(key, value)} (${line(reason)})\n\nThis relaxes what the factory checks before it merges.\n\nType ${scope} to confirm (anything else cancels): `).trim() !== scope)
      throw new Error(`${scope}'s ${key} stays as it is: what you typed did not match`);
  }
  writeSkills(after);
  if (doing && who) audit(scope, value === undefined ? 'unset' : 'set', { key, ...(value !== undefined && { value }), reason, ...stamp(who) }); // the rules audit trail, as a rule write
  return after[scope] || {};
}
// The preset's model, effort and fallback on each step of a scope, keeping who runs the step. Non-Claude runners are skipped.
// A project gets them only on steps it already sets; the rest keep inheriting global (and its preset) as it changes.
export function applyPreset(name: unknown, scope = 'default') {
  const preset = typeof name === 'string' && Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
  if (!preset) throw new Error(`unknown preset ${JSON.stringify(name)} (${Object.keys(PRESETS).join('|')})`);
  checkScope(scope);
  const cfg = readSkills(), s: ScopeConfig = { ...cfg[scope] }, applied: StepKey[] = [], skipped: StepKey[] = [], inherited: StepKey[] = [];
  for (const key of Object.keys(preset).filter(isStepKey)) { // a preset's keys are steps: the filter only types them
    const pair = preset[key];
    if (!pair) continue; // never: key comes from the preset
    if (scope !== 'default' && !s[key]) { inherited.push(key); continue; }
    const { model: _m, effort: _e, fallback: _f, ...base } = s[key] || { use: 'default' };
    if (!runsOn(base)?.models) { skipped.push(key); continue; }
    s[key] = presetRunner(pair, base);
    applied.push(key);
  }
  if (!applied.length) return { scope, preset: name, applied, skipped, inherited }; // nothing to write or audit
  const { by: setBy, via } = whoami();
  cfg[scope] = s;
  writeSkills(cfg);
  audit(scope, 'set', { key: 'preset', value: name, setBy, ...(via === 'local' && { via }) });
  return { scope, preset: name, applied, skipped, inherited };
}

// A model the installed CLI is too old for (Fable needs 2.1.321) moves the step down its fallback chain, noted as
// modelFallback; fallback entries it is too old for are dropped too. Nothing left: no model (the session's own) and the
// reason. An unknown or non-numeric version counts as new enough; missing parts are 0 (2.2 is 2.2.0).
export const older = (v: unknown, min: string): boolean => {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v ?? ''));
  if (!m) return false;
  const a = m.slice(1).map((n) => Number(n || 0)), b = [...min.split('.').map(Number), 0, 0, 0].slice(0, 3);
  const i = b.findIndex((n, j) => a[j] !== n);
  return i >= 0 && (a[i] ?? 0) < (b[i] ?? 0); // both have 3 parts
};
export type PlannedStep = StepRunner & { modelFallback?: { from?: string; reason: string } };
export function availablePlan(plan: Record<string, StepRunner> | StepRunner[], version: (h: Harness) => string | null | undefined = (h) => h.detect().version): Record<string, PlannedStep> {
  const seen = new Map<string, string | null | undefined>(), ver = (h: Harness) => (seen.has(h.id) ? seen.get(h.id) : seen.set(h.id, version(h)).get(h.id));
  return Object.fromEntries(Object.entries(plan).map(([k, r]): [string, PlannedStep] => {
    const h = r.model ? runsOn(r) : undefined;
    if (!h?.models) return [k, r];
    const models = h.models(), min = (m?: string) => models.find((x) => x.alias === m)?.minVersion;
    const ok = (m?: string) => { const need = min(m); if (!need) return true; const v = ver(h); return !v || !older(v, need); }; // the version only when a model needs one
    const { model, fallback = [], ...rest } = r, left = fallback.filter(ok);
    if (ok(model)) return [k, { ...rest, model, ...(left.length && { fallback: left }) }];
    const modelFallback = { from: model, reason: `${h.label} ${ver(h)} is older than ${min(model)}, which ${model} needs` };
    return [k, { ...rest, ...(left[0] && { model: left[0] }), ...(left.length > 1 && { fallback: left.slice(1) }), modelFallback }];
  }));
}
// Every step the session runs, keyed like the plan: built-in steps and extra axes as review.<axis> (a pipeline's own too), custom
// steps as custom.<id>, after the version check.
export const resolvedSteps = (repo: string) => {
  const { plan, extra } = skills(repo), all = allOf(repo);
  return availablePlan({ ...plan, ...Object.fromEntries([...extra, ...all.extra].map(({ axis, when: _w, ...x }) => [`review.${axis}`, x as StepRunner])),
    ...Object.fromEntries(all.custom.map(({ id, slot: _s, when: _w, ...x }) => [`custom.${id}`, x])) });
};

// Every runner the picker can offer, by where it comes from. Descriptions come from front matter and are display-only.
export const front = (file: string): string => {
  let t = '';
  try { t = fs.readFileSync(file, 'utf8').slice(0, 6000); } catch { return ''; }
  const m = /^---\r?\n([^]*?)\r?\n---/.exec(t);
  const d = m && /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/m.exec(m[1] ?? ''); // ?? '': a matched group, never undefined
  return d ? (d[1] ?? '').replace(/^[|>][-+]?\s*/, '').replace(/\s+/g, ' ').replace(/^(["'])(.*)\1$/, '$2').trim().slice(0, 240) : '';
};
export const tilde = (p: string) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
export const dirs = (d: string): string[] => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };
type InstalledPlugins = Record<string, { scope?: string; installPath?: string; projectPath?: string }[]>; // installed_plugins.json's plugins
export function pluginItems(dir: string, source: string, group?: string): CatalogItem[] {
  let name = path.basename(dir).replace(/~.*$/, '');
  try { const m: { name?: string } = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')); name = m.name || name; } catch { /* no manifest: folder name */ }
  const out: CatalogItem[] = [];
  const add = (n: string, kind: string, file: string, runner: StepRunner) => NAME.test(`${name}:${n}`) && out.push({ source, group: group || `plugin: ${name}`, name: `${name}:${n}`, kind, desc: front(file), runner });
  for (const s of dirs(path.join(dir, 'skills'))) { const f = path.join(dir, 'skills', s, 'SKILL.md'); if (fs.existsSync(f)) add(s, 'skill', f, { use: 'skill', name: `${name}:${s}` }); }
  for (const c of ls(path.join(dir, 'commands')).filter((f) => f.endsWith('.md'))) add(c.slice(0, -3), 'command', path.join(dir, 'commands', c), { use: 'skill', name: `${name}:${c.slice(0, -3)}` });
  const host = harnesses.find((h) => h.host)?.id; // plugin agents run on the harness that hosts this skill
  if (host) for (const a of ls(path.join(dir, 'agents')).filter((f) => f.endsWith('.md'))) add(a.slice(0, -3), 'agent', path.join(dir, 'agents', a), { use: 'provider', harness: host, name: `${name}:${a.slice(0, -3)}` });
  return out;
}
export let globalCatalog: CatalogItem[] | undefined; // one disk scan per process: render() runs on every record()
export function scanGlobal(): CatalogItem[] {
  const home = os.homedir(), claude = path.join(home, '.claude'), out: CatalogItem[] = [];
  const skillDir = (root: string, source: string, group: string, runnerOf: (n: string, f: string) => StepRunner | false) => {
    for (const n of dirs(root)) { const f = path.join(root, n, 'SKILL.md'); if (fs.existsSync(f) && n !== 'software-factory') { const runner = runnerOf(n, f); if (runner) out.push({ source, group, name: runner.name || n, kind: 'skill', desc: front(f), runner }); } }
  };
  out.push({ source: 'builtin', group: 'Software Factory', name: 'Factory default', kind: 'brief', desc: 'The built-in brief in SKILL.md or references/reviewers.md.', runner: { use: 'default' } });
  for (const h of harnesses) for (const t of h.providerTools?.() || []) { // the runner is built here, so a harness can only offer itself
    const runner = { use: 'provider', harness: h.id, ...(t.tool !== undefined && { name: t.tool }) };
    if (t.tool === undefined || NAME.test(t.tool)) out.push({ source: 'system', group: h.label, name: String(t.name), kind: 'tool', desc: String(t.desc || '').slice(0, 240), runner });
  }
  skillDir(path.join(claude, 'skills'), 'global', '~/.claude/skills', (n) => NAME.test(n) && { use: 'skill', name: n });
  // shortcut: synced (org-provided) skills are named anthropic-skills:<name> in Claude Code; read the prefix from Claude Code if it ever varies.
  for (const b of dirs(path.join(claude, 'skills', 'synced'))) skillDir(path.join(claude, 'skills', 'synced', b), 'global', 'Synced skills', (n) => NAME.test(`anthropic-skills:${n}`) && { use: 'skill', name: `anthropic-skills:${n}` });
  const mine = new Set(out.map((x) => x.name));
  skillDir(path.join(home, '.agents', 'skills'), 'global', '~/.agents/skills', (n, f) => !mine.has(n) && /^[^'"\0-\x1f]+$/.test(f) && { use: 'brief', path: tilde(f) }); // other harnesses' skills run as a brief
  let installed: InstalledPlugins = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { /* no plugins */ }
  for (const list of Object.values(installed)) for (const e of list) if (e.scope === 'user' && e.installPath) out.push(...pluginItems(e.installPath, 'global'));
  for (const b of dirs(path.join(claude, 'plugins', 'synced'))) for (const p of dirs(path.join(claude, 'plugins', 'synced', b))) out.push(...pluginItems(path.join(claude, 'plugins', 'synced', b, p), 'global'));
  for (const f of ls(path.join(stateDir(), 'briefs')).filter((f) => f.endsWith('.md'))) {
    const p = path.join(stateDir(), 'briefs', f);
    if (/^[^'"\0-\x1f]+$/.test(p)) out.push({ source: 'yours', group: tilde(path.join(stateDir(), 'briefs')), name: f, kind: 'brief', desc: front(p), runner: { use: 'brief', path: tilde(p) } });
  }
  return out;
}
// Project skills come from the attached clone's checkout. Picking one for a review lets the repo supply the reviewer;
// a PR that changes it touches .claude/, which is SENSITIVE, so it can never auto-merge.
export function scanProject(repo: string): CatalogItem[] {
  const clone = projects()[repo]?.path;
  if (!clone) return [];
  const out: CatalogItem[] = [], root = path.join(clone, '.claude', 'skills');
  for (const n of dirs(root)) { const f = path.join(root, n, 'SKILL.md'); if (fs.existsSync(f) && NAME.test(n)) out.push({ source: 'project', group: '.claude/skills', name: n, kind: 'skill', desc: front(f), runner: { use: 'skill', name: n } }); }
  let installed: InstalledPlugins = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { /* none */ }
  for (const list of Object.values(installed)) for (const e of list) if ((e.scope === 'project' || e.scope === 'local') && e.projectPath === clone && e.installPath) out.push(...pluginItems(e.installPath, 'project'));
  return out;
}
export function catalog(repos: string[] = []) {
  globalCatalog ??= scanGlobal();
  return { global: globalCatalog, projects: Object.fromEntries(repos.map((r) => [r, scanProject(r)])) };
}
// Everything the Skills sheet needs: raw config (to tell "set here" from "inherited"), resolved plans and the catalog.
export function skillsData(repos: string[] = []) {
  try {
    const cfg = readSkills();
    const scopes = [...new Set([...Object.keys(projects()), ...repos, ...Object.keys(cfg)])].filter((s) => s !== 'default' && !isPipelineScope(s)).sort(); // a pipeline is its project's (skills().pipelines)
    return { steps: STEP_KEYS, required: REQUIRED_AXES, config: cfg, scopes,
      plans: Object.fromEntries(['default', ...scopes].map((s) => [s, skills(s === 'default' ? '' : s, cfg)])), catalog: catalog(scopes),
      models: (harnesses.find((h) => h.host)?.models?.() || []).map((m) => m.alias), efforts: harnesses.find((h) => h.host)?.efforts || [], preset: DEFAULT_PRESET, presets: PRESETS };
  } catch (e) { return { error: (e as Error).message }; } // a bad skills.json must not break rendering an event that was already appended
}
