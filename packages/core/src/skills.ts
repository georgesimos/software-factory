import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ls, projects } from './workspace.ts';
import { audit, checkGuide, checkRules, checkScope, rules, whoami } from './rules.ts';
import { harnesses, type Harness } from '../../adapters/harnesses/index.mjs';
import { stateDir } from './log.ts';
import type { ExtraAxis } from './gate.ts';
import type { Rule } from './types.ts';

// Who does each step: the built-in brief, the user's own skill or brief, or a harness's tool.
// User-local only (io.dir/skills.json): a repo, and so a PR, can never pick its own reviewers.
export type BuiltinAxis = 'code' | 'security' | 'ux' | 'ui' | 'seo' | 'docs';
export const BUILTIN_AXES: BuiltinAxis[] = ['code', 'security', 'ux', 'ui', 'seo', 'docs'];
export const REQUIRED_AXES: BuiltinAxis[] = ['code', 'security']; // axesFor always selects them; config can swap who reviews, never drop them
export type StepKey = 'intake' | 'spec' | 'build' | `review.${BuiltinAxis}` | 'verifier' | 'postmerge';
export const STEP_KEYS: StepKey[] = ['intake', 'spec', 'build', ...BUILTIN_AXES.map((a) => `review.${a}` as const), 'verifier', 'postmerge'];
export const isStepKey = (k: unknown): k is StepKey => STEP_KEYS.some((x) => x === k);
const isBuiltinAxis = (a: unknown): a is BuiltinAxis => BUILTIN_AXES.some((x) => x === a);

/** A step's runner in skills.json, as checkRunner() admits it. */
export interface StepRunner { use: string; name?: string; path?: string; harness?: string; model?: string; effort?: string; fallback?: string[] }
/** An extra review axis (axes.extra): a runner plus gate's axis and the globs that select it. */
export interface ExtraAxisRunner extends StepRunner, ExtraAxis {}
/** One scope of skills.json ("default" or owner/repo): a runner per step, extra axes, rules and guidance. */
export type ScopeConfig = Partial<Record<StepKey, StepRunner>> & { 'axes.extra'?: ExtraAxisRunner[]; rules?: Record<string, Rule>; guide?: Record<string, string> };
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
    || s.use === 'skill' && NAME.test(String(s.name || '')) && !s.path && !s.harness
    || s.use === 'brief' && BRIEF[platform === 'win32' ? 'win32' : 'posix'].test(String(s.path || '')) && !s.name && !s.harness
    || s.use === 'provider' && harnessIds().some((id) => id === s.harness) && (s.name === undefined || NAME.test(String(s.name))) && !s.path;
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
export function checkStep(key: string, v: unknown, at: string): void {
  if (key === 'rules') return checkRules(v, at);
  if (key === 'guide') return checkGuide(v, at);
  if (key !== 'axes.extra') {
    if (!isStepKey(key)) throw new Error(`${at}: unknown step "${key}" (${STEP_KEYS.join('|')}|axes.extra)`);
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
    if (scope !== 'default' && !/^[\w.-]+\/[\w.-]+$/.test(scope)) throw new Error(`skills.json: scope "${scope}" must be "default" or owner/repo`);
    if (!isObj(steps)) throw new Error(`skills.json: ${scope} must be an object`);
    for (const [k, v] of Object.entries(steps)) checkStep(k, v, `skills.json ${scope}.${k}`);
  }
}
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
      : k === 'axes.extra' ? (Array.isArray(v) ? v.map((x: unknown) => drop(x, `${scope}.${k}`)) : v) : drop(v, `${scope}.${k}`)]))]));
}
export function readSkills(): SkillsConfig {
  try {
    const cfg = dropUnknownModels(JSON.parse(fs.readFileSync(skillsFile(), 'utf8')));
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
  return { repo, plan, extra, required: REQUIRED_AXES, guide: rules(repo, cfg).guide };
}
export function writeSkills(cfg: unknown): asserts cfg is SkillsConfig {
  checkSkills(cfg);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(skillsFile() + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(skillsFile() + '.tmp', skillsFile());
}
// value === undefined removes the step from that scope, so a project inherits the global choice again.
export function setSkill(scope: string, key: string, value: unknown): ScopeConfig {
  if (key === 'rules' || key === 'guide') throw new Error(`"${key}" is set with "rules set", which records who changed it and why`);
  if (scope !== 'default' && !/^[\w.-]+\/[\w.-]+$/.test(scope || '')) throw new Error(`scope "${scope}" must be "default" or owner/repo`);
  const cfg: Record<string, Record<string, unknown>> = readSkills(), next: Record<string, unknown> = { ...cfg[scope], [key]: value }; // unchecked until writeSkills
  cfg[scope] = next;
  if (value === undefined) { if (!isStepKey(key) && key !== 'axes.extra') throw new Error(`unknown step "${key}"`); delete next[key]; }
  if (!Object.keys(next).length) delete cfg[scope];
  writeSkills(cfg);
  return cfg[scope] || {};
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
  const setBy = whoami();
  cfg[scope] = s;
  writeSkills(cfg);
  audit(scope, 'set', { key: 'preset', value: name, setBy });
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
export function availablePlan(plan: Record<string, StepRunner>, version: (h: Harness) => string | null | undefined = (h) => h.detect().version): Record<string, PlannedStep> {
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
// Every step the session runs, keyed like the plan: built-in steps and extra axes as review.<axis>, after the version check.
export const resolvedSteps = (repo: string) => {
  const { plan, extra } = skills(repo);
  return availablePlan({ ...plan, ...Object.fromEntries(extra.map(({ axis, when: _w, ...x }) => [`review.${axis}`, x])) });
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
    const scopes = [...new Set([...Object.keys(projects()), ...repos, ...Object.keys(cfg)])].filter((s) => s !== 'default').sort();
    return { steps: STEP_KEYS, required: REQUIRED_AXES, config: cfg, scopes,
      plans: Object.fromEntries(['default', ...scopes].map((s) => [s, skills(s === 'default' ? '' : s, cfg)])), catalog: catalog(scopes),
      models: (harnesses.find((h) => h.host)?.models?.() || []).map((m) => m.alias), efforts: harnesses.find((h) => h.host)?.efforts || [], preset: DEFAULT_PRESET, presets: PRESETS };
  } catch (e) { return { error: (e as Error).message }; } // a bad skills.json must not break rendering an event that was already appended
}
