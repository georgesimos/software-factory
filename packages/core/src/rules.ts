import fs from 'node:fs';
import os from 'node:os';
import { CAP, COST_CAP, MAX_DIFF, MAX_ISSUES_PER_SESSION, PROJECT_BUDGET_USD, isLocal } from './constants.ts';
import { LOCKED_STEPS, OPTIONAL_STEPS, PIPELINE_HOLDS, STEP_KEYS, checkStep, isBuiltinAxis, isObj, isStepKey, readSkills, writeSkills, type ScopeConfig, type SkillsConfig } from './skills.ts';
import { dashboard } from './log.ts';
import { gh } from './github.ts';
import { git, hostFn, hostOf, projects, projectsFile } from './workspace.ts';
import { humanOnly } from './projectset.ts';
import { line, ttyAsk } from './approve.ts';
import { type MatchSet, NAME_OK, PIPELINE_KEYS, PIPELINE_RULES, diffLinesTrusted, isPipelineId, isPipelineScope, listedOf, matchProblem, matchText, ownersOf, pipelinesDiffer, pipelinesOf, runGets, splitScope } from './route.ts';
import { log, stateDir } from './log.ts';
import type { Rule } from './types.ts';

export function setAutoMerge(repo: string, on: unknown, ask: (prompt: string) => string = ttyAsk) {
  if (!projects()[repo]) throw new Error(`${repo} is not attached; run sync first`);
  if (typeof on !== 'boolean') throw new Error('auto-merge must be on or off');
  if (on) { // D1: on lets runs merge with nobody asked, so it comes from you (F automerge, or the page's toggle in F ui), verified where the host can verify
    if (hostOf(repo) !== 'github') throw new Error(`${repo} is a git project: it always asks before merging (F approve RUN --merge)`);
    humanOnly('turning auto-merge on');
    if (whoami('turning auto-merge on').via !== 'github') throw new Error('turning auto-merge on for a GitHub project needs a verified login (gh auth login)');
    // typed at your terminal, as F approve: a speed bump, not a boundary (an agent that clears humanOnly's variables can get a pty)
    const typed = ask(`${repo}: turn auto-merge on?\n\nA run whose gates all pass will then merge with nobody asked.\n\nType ${repo} to turn it on (anything else cancels): `);
    if (typed.trim() !== repo) throw new Error('auto-merge stays off: what you typed did not match');
  }
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], autoMerge: on } }, null, 2));
  dashboard.render();
  return projects()[repo];
}
const ARTIFACT_URL = /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+$/;
// Policy rules: a closed set of typed switches that F enforces. They can only make the factory stricter, or swap a
// signal that can't be had (GitHub CI, e.g. when Actions billing fails) for one F measures itself (local checks).
// One exception: `artifact` is a per-repo opt-in to publishing the dashboard off this machine, so `default` can't set it.
// Not configurable, ever: TRUSTED, SENSITIVE, the code/security axes, --match-head-commit, imported runs escalating.
const oneOf = (...xs: string[]) => (v: unknown) => xs.some((x) => x === v);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v); // Number.isInteger is false for anything else
// steps.off names optional steps only: review.ux|ui|seo|docs (OPTIONAL_STEPS) or review.<extra axis>. Read at call time: skills.ts imports this file.
const offKey = (k: unknown) => typeof k === 'string' && (OPTIONAL_STEPS.includes(k) || /^review\.[a-z][a-z0-9-]{0,30}$/.test(k) && !isBuiltinAxis(k.slice(7)));
export const RULES: Record<string, [check: (v: unknown) => boolean, want: string]> = {
  ci: [oneOf('required', 'advisory', 'skip'), 'required|advisory|skip'],
  'checks.commands': [(v) => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((c: unknown) => typeof c === 'string' && c.trim() && c.length <= 300 && !/[\r\n\0]/.test(c)), 'a JSON array of 1-10 one-line commands'],
  diffCap: [(v) => int(v) && v >= 1 && v <= MAX_DIFF, `an integer 1-${MAX_DIFF} (it can only lower the cap)`],
  'project.budgetUsd': [(v) => typeof v === 'number' && v > 0 && v <= PROJECT_BUDGET_USD, `dollars, above 0 and at most ${PROJECT_BUDGET_USD} (it can only lower the cap)`],
  'project.maxIssuesPerSession': [(v) => int(v) && v >= 1 && v <= MAX_ISSUES_PER_SESSION, `an integer 1-${MAX_ISSUES_PER_SESSION} (it can only lower the cap)`],
  'deploy.preview': [oneOf('required', 'advisory', 'off'), 'required|advisory|off (off is the built-in; required adds a merge condition)'],
  artifact: [(v) => typeof v === 'string' && ARTIFACT_URL.test(v), 'a private claude.ai Artifact URL (https://claude.ai/artifact/<id>); opts this repo\'s runs in to republishing it'],
  // docs/plans/pipelines.md §3, §7.5: the one rule that removes a check, and the run caps. Per project; loosening them is guarded (loosens()).
  'steps.off': [(v) => Array.isArray(v) && v.length >= 1 && v.length <= 10 && new Set(v).size === v.length && v.every(offKey), 'a JSON array of 1-10 distinct optional review steps (review.<axis>); F rules unset turns them all back on'],
  'run.loops': [(v) => int(v) && v >= 1 && v <= CAP, `an integer 1-${CAP} (it can only lower the loop cap)`],
  'run.budgetUsd': [(v) => typeof v === 'number' && v > 0 && v <= COST_CAP, `dollars, above 0 and at most ${COST_CAP} (it can only lower the run budget)`],
  // §7: a pipeline's match conditions (owner/repo@id only) and the project's named pipelines in match order. Routing is guarded (loosens()).
  match: [(v) => matchProblem(v) === null, 'a JSON array of 1-5 condition sets, each with labels, files (globs) or maxDiffLines'],
  pipelines: [(v) => Array.isArray(v) && v.length >= 1 && v.length <= 10 && new Set(v).size === v.length && v.every(isPipelineId), 'a JSON array of 1-10 distinct pipeline ids in match order (the default pipeline is always last and never listed)'],
};
const PER_PROJECT = ['artifact', 'steps.off', 'run.loops', 'run.budgetUsd', 'pipelines', 'match'];
// Where a rule may live (§7.1): match only on a pipeline, pipelines only on the project, a pipeline holds only PIPELINE_RULES.
const misplaced = (scope: string, key: string) => {
  const { project, id } = splitScope(scope);
  if (!id) return key === 'match' && scope !== 'default' ? `match is a pipeline's rule: set it on ${project}@<id>` : null;
  if (key === 'pipelines') return `pipelines is the project's rule: set it on ${project}`;
  return PIPELINE_RULES.includes(key) ? null : `${key} is the project's rule: a pipeline holds ${PIPELINE_RULES.slice(0, -1).join(', ')} and ${PIPELINE_RULES.at(-1)}`;
};
export const RUN_CAPS: Record<string, number> = { 'run.loops': CAP, 'run.budgetUsd': COST_CAP };
/** A run's caps: the lower of the project's rule and the built-in (§7.5). The per-run minimum across pipelines is slice 4's. */
export const runCaps = (policy: Record<string, Rule> = {}) => ({
  loops: Math.min(CAP, Number(policy['run.loops']?.value ?? CAP)), budgetUsd: Math.min(COST_CAP, Number(policy['run.budgetUsd']?.value ?? COST_CAP)),
});
export const RULE_FIELDS = ['value', 'reason', 'setBy', 'via', 'setAt', 'until'];
export const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
// Who changed a rule or wrote a note, and how sure F is: 'github' (gh api user, a verified login; also every rule with no via)
// or 'local' (the OS user, which can be DOMAIN\user on Windows: weaker, so it can't relax a merge condition; see gate.ts).
export type Via = 'github' | 'local';
export const LOCAL_BY = /^[^\x00-\x1f\x7f]{1,100}$/;

export const isDay = (s: unknown): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s); // a string: ["2026-11-01"] read as one
export const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10); // UTC; a rule applies through its whole `until` day
export const isGuideKey = (k: string) => k === '*' || isStepKey(k) || /^(review|custom)\.[a-z][a-z0-9-]{0,30}$/.test(k); // review.<extra axis> and custom.<custom step> too
export function checkRules(v: unknown, at: string): void {
  if (!isObj(v)) throw new Error(`${at}: must be an object of rules`);
  for (const [k, x] of Object.entries(v)) {
    const rule = Object.hasOwn(RULES, k) ? RULES[k] : undefined; // own: "constructor" is not a rule
    if (!rule) throw new Error(`${at}: unknown rule "${k}" (${Object.keys(RULES).join('|')}). Trusted authors, sensitive paths, required axes and the merge checks are not configurable`);
    if (!isObj(x)) throw new Error(`${at}.${k}: must be {value, reason, setBy, setAt, until?}`);
    const bad = Object.keys(x).filter((f) => !RULE_FIELDS.includes(f));
    if (bad.length) throw new Error(`${at}.${k}: unknown fields ${bad.join(', ')}`);
    if (!rule[0](x.value)) throw new Error(`${at}.${k}: must be ${rule[1]}, got ${JSON.stringify(x.value)}`);
    const reason = x.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw new Error(`${at}.${k}: needs a reason (--reason "…", at most 200 characters)`);
    if (x.via !== undefined && x.via !== 'github' && x.via !== 'local') throw new Error(`${at}.${k}: via must be github or local`);
    if (isLocal(x) ? !(typeof x.setBy === 'string' && LOCAL_BY.test(x.setBy)) : !(typeof x.setBy === 'string' && LOGIN.test(x.setBy))) throw new Error(`${at}.${k}: setBy must be ${isLocal(x) ? 'a user name (1-100 characters)' : 'a GitHub login'}`);
    if (typeof x.setAt !== 'string' || isNaN(Date.parse(x.setAt))) throw new Error(`${at}.${k}: setAt must be a timestamp`);
    if (x.until !== undefined && !isDay(x.until)) throw new Error(`${at}.${k}: until must be YYYY-MM-DD`);
  }
}
export function checkGuide(v: unknown, at: string): void {
  if (!isObj(v)) throw new Error(`${at}: must be an object of step -> text`);
  for (const [k, t] of Object.entries(v)) {
    if (!isGuideKey(k)) throw new Error(`${at}: unknown step "${k}" (* | ${STEP_KEYS.join(' | ')} | review.<extra axis>)`);
    if (typeof t !== 'string' || !t.trim() || t.length > 1000) throw new Error(`${at}.${k}: guidance must be text, at most 1000 characters`);
  }
}
// Project rule over global, per key. An expired rule stops applying (the global one, or the built-in, takes over) and warns.
export function rules(repo: string, cfg: SkillsConfig = readSkills(), now = Date.now()): { repo: string; policy: Record<string, Rule>; guide: Record<string, string[]>; expired: Rule[]; warnings: string[] } {
  const mine = (s: string) => s === repo || (!isPipelineScope(repo) && (s === 'default' || s.startsWith(`${repo}@`)));
  const today = dayOf(now), policy: Record<string, Rule> = {}, expired: Rule[] = [], warnings: string[] = passWarnings.filter(([s]) => mine(s)).map(([, w]) => w);
  for (const scope of isPipelineScope(repo) ? [repo] : [...new Set([repo, 'default'])]) { // a pipeline inherits nothing: its steps.off is its own (§7.1)
    for (const [key, x] of Object.entries(cfg[scope]?.rules || {})) {
      const what = `${key}=${JSON.stringify(x.value)} (${scope}: ${x.reason})`;
      if (key === 'artifact' && scope === 'default') { warnings.push(`${what} is ignored: artifact is a per-repo opt-in`); continue; } // hand-edited skills.json
      if (x.until && x.until < today) { expired.push({ key, scope, ...x }); warnings.push(`${what} expired on ${x.until} and no longer applies; unset it or set it again with a new --until`); continue; }
      if (policy[key]) continue;
      policy[key] = { ...x, scope };
      if (x.until && Date.parse(x.until) - Date.parse(today) <= 3 * 864e5) warnings.push(`${what} expires on ${x.until}`);
    }
  }
  const g = cfg.default?.guide || {}, p = cfg[repo]?.guide || {}, guide: Record<string, string[]> = {};
  for (const k of new Set([...STEP_KEYS, ...Object.keys(g), ...Object.keys(p)])) { // per step: whole-flow text first, then the step's; global before project
    const texts = k === '*' ? [] : [g['*'], p['*'], g[k], p[k]].filter((t): t is string => !!t); // as filter(Boolean)
    if (texts.length) guide[k] = texts;
  }
  return { repo, policy, guide, expired, warnings };
}
// The person changing a rule (or writing a note), never typed in. A verified identity counts on every project, whatever its
// host: whoever gh is logged in as. With gh missing or logged out, or a login gh shouldn't return, the OS user, unverified (via
// 'local'), so rules and notes still save on a machine without GitHub; #131's guard keeps that user from loosening a verified
// rule. Any other gh failure throws: a logged-in user is never recorded as local. at: for tests.
// shortcut: gh is the one verified source; ask a host's own whoami here first once a host has verified logins of its own.
export function whoami(doing = 'changing the rule', at = { user: () => os.userInfo().username }): { by: string; via: Via } {
  let w: { login: string } | null = null;
  try { w = hostFn('github', 'whoami', 'tell who you are')({ gh, git }, { user: at.user }); } catch (e) { throw new Error(`cannot tell who is ${doing}: ${(e as Error).message}`); }
  if (w && LOGIN.test(w.login)) return { by: w.login, via: 'github' };
  let user = '';
  try { user = hostFn('git', 'whoami', 'tell who you are')({ gh, git }, { user: at.user })!.login; } catch { /* no OS user (uid without a passwd entry): below */ }
  if (!LOCAL_BY.test(user)) throw new Error(`cannot tell who is ${doing}: no verified gh login, and there is no OS user name`);
  return { by: user, via: 'local' };
}
export const stamp = (who: { by: string; via: Via }) => ({ setBy: who.by, ...(who.via === 'local' && { via: who.via }) }); // a GitHub login is stored as before: no via
// A local (unverified) user can't replace or remove a rule a verified login set: that could only ever loosen it. An expired
// one no longer applies (rules()), so anyone may clear or replace it. The message never names the local user (DOMAIN\user).
const live = (old: Rule | undefined): old is Rule => !!old && !isLocal(old) && !(old.until && old.until < dayOf());
const guard = (who: { by: string; via: Via }, old: Rule | undefined, key: string) => {
  if (who.via === 'local' && live(old)) throw new Error(`rule ${key} was set by ${old.setBy} (GitHub): changing it needs that verified login (gh auth login), not a local user`);
};
// A project rule overrides the default one, so a local user may shadow a verified default only with a value at least as strict.
const RANK: Record<string, string[]> = { ci: ['skip', 'advisory', 'required'], 'deploy.preview': ['off', 'advisory', 'required'] }; // least to most strict
export function asStrict(key: string, value: unknown, old: unknown): boolean {
  if (RANK[key]) return RANK[key].indexOf(String(value)) >= RANK[key].indexOf(String(old));
  if (typeof value === 'number' && typeof old === 'number') return value <= old; // caps: diffCap, project.*
  if (key === 'checks.commands') return Array.isArray(value) && Array.isArray(old) && old.every((c) => value.includes(c)); // every verified check still runs
  if (key === 'steps.off') return Array.isArray(value) && Array.isArray(old) && value.every((k) => old.includes(k)); // fewer steps off
  return JSON.stringify(value) === JSON.stringify(old);
}
const guardShadow = (who: { by: string; via: Via }, scope: string, base: Rule | undefined, key: string, value: unknown) => {
  if (who.via === 'local' && scope !== 'default' && live(base) && !asStrict(key, value, base.value))
    throw new Error(`rule ${key}=${JSON.stringify(base.value)} on default was set by ${base.setBy} (GitHub): overriding it on ${scope} with a looser value needs that verified login (gh auth login), not a local user`);
};
// Rule changes (stage "rules") and notes (stage "note") are owned events in the log, written here outside record():
// they never move a run, and F event refuses them.
export function audit(scope: string, status: string, e: Record<string, unknown>, stage = 'rules') {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(log(), JSON.stringify({ ts: new Date().toISOString(), ...e, run: scope, stage, status }) + '\n');
  dashboard.render();
}
export const checkScope = (scope: string) => { if (scope !== 'default' && !(typeof scope === 'string' && (/^[\w.-]+\/[\w.-]+$/.test(scope) || isPipelineScope(scope)))) throw new Error(`scope "${scope}" must be "default", owner/repo or owner/repo@<pipeline id>`); };
// docs/plans/pipelines.md §5: what a rule write loosens, or null. The CLI, the page's route and the desktop dialog all ask this.
// Any steps.off set (a smaller list is still a set); a cap set above what applies now, or unset (back up to the built-in), or
// set to expire before the stored one does (when it lapses, the cap goes back up).
export function loosens(scope: string, key: string, value: unknown, cfg: SkillsConfig = readSkills(), until?: string): string | null {
  if (key === 'pipelines' || key === 'match') { // routing (§7.3): guarded while any two pipelines it touches differ in what a run gets
    const { project, id } = splitScope(scope), ids = new Set<string | null>([null, ...listedOf(project, cfg), ...(key === 'pipelines' && Array.isArray(value) ? value : []), ...(id ? [id] : [])]);
    return pipelinesDiffer(project, [...ids], cfg) ? 'changing which pipeline a run gets' : null;
  }
  if (key === 'steps.off') return value === undefined ? null : 'turning a pipeline step off';
  if (!Object.hasOwn(RUN_CAPS, key)) return null;
  const built = RUN_CAPS[key]!, old = cfg[scope]?.rules?.[key], live = old && !(old.until && old.until < dayOf()), now = live ? Math.min(built, Number(old.value)) : built;
  if (value !== undefined && until && live && now < built && (!old.until || old.until > until)) return 'raising a cap';
  return Number(value ?? built) > now ? 'raising a cap' : null;
}
// The terminal command for a rule write, built only from checked values (scope, key, value, until), never page text.
const ruleCommand = (scope: string, key: string, value: unknown, until?: string) => value === undefined ? `F rules unset ${scope} ${key}`
  : `F rules set ${scope} ${key} ${typeof value === 'number' ? value : `'${JSON.stringify(value)}'`} --reason "…"${until ? ` --until ${until}` : ''}`;
export const pageRefusal = (doing: string, cmd: string) => new Error(`${doing} needs your confirmation outside the page: confirm it in the desktop app, or run in your own terminal: ${cmd}`);
// Everything setRule checks before asking who you are: the scope, the key, the value as stored, until, and steps.off's own rules.
function prepare(scope: string, key: string, raw: unknown, until: string | undefined, cfg: SkillsConfig) {
  checkScope(scope);
  if (!Object.hasOwn(RULES, key)) checkRules({ [key]: {} }, `rules ${scope}`); // throws the unknown-rule message
  if (PER_PROJECT.includes(key) && scope === 'default') throw new Error(key === 'artifact' ? 'artifact is a per-repo opt-in: set it on owner/repo, not default' : `${key} is a per-project rule: set it on owner/repo, not default`);
  const where = misplaced(scope, key), { project } = splitScope(scope);
  if (where) throw new Error(where);
  let value: unknown = raw;
  if (['diffCap', 'project.budgetUsd', 'project.maxIssuesPerSession', 'run.loops', 'run.budgetUsd'].includes(key)) value = Number(raw);
  if (key === 'checks.commands' || key === 'steps.off' || key === 'pipelines' || key === 'match') { try { value = JSON.parse(String(raw)); } catch { value = [raw]; } } // JSON.parse makes a string of raw anyway
  if (key === 'match') {
    const why = matchProblem(value);
    if (why) throw new Error(`match: ${why}`);
    if (!diffLinesTrusted(project) && (value as { maxDiffLines?: number }[]).some((s) => s.maxDiffLines !== undefined)) throw new Error(`maxDiffLines is refused on a git project until #137: ${project}'s diff size can't be trusted (a "* -diff" attribute reads as zero lines)`);
  }
  if (key === 'pipelines' && !RULES.pipelines![0](value)) throw new Error(`pipelines: must be ${RULES.pipelines![1]}`);
  if (key === 'pipelines' && Array.isArray(value)) for (const id of value) if (isPipelineId(id) && !cfg[`${project}@${id}`]?.rules?.match) throw new Error(`${project}@${id} has no match: set one first (F rules set ${project}@${id} match '[…]' --reason "…")`);
  if (key === 'steps.off' && Array.isArray(value)) {
    const extra = [...(cfg.default?.['axes.extra'] || []), ...(cfg[project]?.['axes.extra'] || []), ...(scope !== project ? cfg[scope]?.['axes.extra'] || [] : [])].map((x) => x.axis); // a pipeline's: the project's and its own
    for (const k of value) {
      if (LOCKED_STEPS.includes(k)) throw new Error(`${k} is locked: F always runs ${LOCKED_STEPS.join(', ')}`);
      if (offKey(k) && !OPTIONAL_STEPS.includes(k) && !extra.includes(k.slice(7))) throw new Error(`${k}: ${scope} has no extra axis ${k.slice(7)} (F skills set ${scope} axes.extra)`);
    }
  }
  if (until !== undefined && !(isDay(until) && until >= dayOf())) throw new Error('--until must be YYYY-MM-DD, today or later');
  return value;
}
export interface RuleRequest { scope: string; key: string; raw?: string; unset?: boolean; reason?: string; until?: string }
/** F's own reading of a rule write, without writing: the stored value, the new one (undefined: unset), what it loosens and the
 *  command for a terminal. The page's route asks it before requesting; the desktop dialog shows it, and asks again on confirm. */
export function ruleChange(scope: string, key: string, raw: unknown, { reason, until }: { reason?: string; until?: string } = {}, cfg: SkillsConfig = readSkills()) {
  let value: unknown;
  if (raw === undefined) { checkScope(scope); if (!cfg[scope]?.rules?.[key]) throw new Error(`no rule "${key}" set for ${scope}`); }
  else {
    value = prepare(scope, key, raw, until, cfg);
    checkRules({ [key]: { value, reason, setBy: 'x', setAt: new Date().toISOString(), ...(until && { until }) } }, `rules ${scope}`); // the value and the reason, as writeSkills would
  }
  const old = cfg[scope]?.rules?.[key];
  return { scope, key, stored: old?.value, ...(old?.until && { storedUntil: old.until }), value, ...(until && { until }), doing: loosens(scope, key, value, cfg, until), command: ruleCommand(scope, key, value, until), routes: routesFor(scope, key, value, cfg, until) };
}
/** How the project's runs are routed after a write (§7.3), for the typed prompt and the dialog: each listed pipeline's match,
 *  what it turns off and its caps, then the default. Only for a routing write or a write to a pipeline; [] otherwise. */
export function routesFor(scope: string, key: string, value: unknown, cfg: SkillsConfig, until?: string) {
  const { project, id } = splitScope(scope);
  if (!id && key !== 'pipelines') return [];
  const after: SkillsConfig = structuredClone(cfg), r = (after[scope] ??= {}).rules ??= {}; // the config with the write applied, unset included
  if (value === undefined) delete r[key]; else r[key] = { value, reason: '-', setBy: '-', setAt: new Date().toISOString(), ...(until && { until }) };
  const named = Object.fromEntries(pipelinesOf(project, after).map((p) => [p.id, p]));
  const row = (pid: string | null) => { const g = runGets(project, pid, after);
    return { id: pid ?? 'default', name: pid ? named[pid]?.name ?? pid : 'the default', match: pid ? matchText(named[pid]?.match) : 'every other issue', off: g.off, caps: g.caps }; };
  return [...listedOf(project, after).map(row), row(null)];
}
export const routesText = (routes: ReturnType<typeof routesFor>) => routes.length ? `Runs are then routed:\n${routes.map((p, i) => `  ${p.id === 'default' ? 'then the default' : `${i + 1}. ${p.id}`}: ${p.match}; ${p.off.length ? `off ${p.off.join(', ')}` : 'nothing off'}; loops ${p.caps.loops}, $${p.caps.budgetUsd}`).join('\n')}\n` : '';
/** A rule's value as a person reads it: an unset cap is the built-in one. */
export const shownRule = (key: string, v: unknown) => v === undefined ? (Object.hasOwn(RUN_CAPS, key) ? `the built-in (${RUN_CAPS[key]})` : 'nothing') : key === 'match' ? matchText(v) : Array.isArray(v) ? v.join(', ') : String(v);
type Ask = (prompt: string) => string;
// a loosening is typed at your terminal, as F automerge on and a relaxing F project set: a speed bump, not a boundary (humanOnly is the refusal)
/** What a rule reads as now, for a prompt or the dialog: an expired one says so, and what applies instead. */
export const shownNow = (key: string, old?: Pick<Rule, 'value' | 'until'>) =>
  old?.until && old.until < dayOf() ? `${shownRule(key, undefined)} (${shownRule(key, old.value)} expired on ${old.until})` : shownRule(key, old?.value);
function typed(ask: Ask, scope: string, key: string, doing: string, old: Rule | undefined, to: unknown, until: string | undefined, reason: string | undefined, cfg: SkillsConfig) {
  if (ask(`${scope}: ${doing}\n${key}: ${shownNow(key, old)} -> ${shownRule(key, to)}${until ? ` until ${until}` : ''}${reason ? ` (${line(reason)})` : ''}\n${routesText(routesFor(scope, key, to, cfg, until))}\nThis relaxes what the factory checks before it merges.\n\nType ${scope} to confirm (anything else cancels): `).trim() !== scope)
    throw new Error(`${scope}'s ${key} stays as it is: what you typed did not match`);
}
// page: the write comes from the dashboard's route, which may only request a guarded write (§5); core refuses it here too.
export function setRule(scope: string, key: string, raw: unknown, { reason, until, page, ask = ttyAsk }: { reason?: string; until?: string; page?: boolean; ask?: Ask } = {}) {
  checkScope(scope);
  const cfg = readSkills(), s: ScopeConfig = { ...cfg[scope] }, step = key.startsWith('guide.') ? key.slice(6) : null;
  let value: unknown = raw, doing: string | null = null;
  if (step !== null) s.guide = { ...s.guide, [step]: String(raw ?? '') };
  else {
    value = prepare(scope, key, raw, until, cfg);
    doing = loosens(scope, key, value, cfg, until);
    if (doing && page) throw pageRefusal(doing, ruleCommand(scope, key, value, until));
    if (doing) humanOnly(doing);
  }
  const who = whoami();
  if (step === null) { guard(who, s.rules?.[key], key); guardShadow(who, scope, cfg.default?.rules?.[key], key, value); const rule = { value, reason, ...stamp(who), setAt: new Date().toISOString(), ...(until && { until }) };
    if (doing) { checkRules({ [key]: rule }, `rules ${scope}`); typed(ask, scope, key, doing, s.rules?.[key], value, until, reason, cfg); } // checked first: never ask about a write that would fail
    s.rules = { ...s.rules, [key]: rule }; }
  cfg[scope] = s;
  writeSkills(cfg); // validates the whole config first
  audit(scope, 'set', { key, value, ...(reason && { reason }), ...(until && { until }), ...stamp(who) });
  return rules(scope);
}
export function unsetRule(scope: string, key: string, { reason, page, ask = ttyAsk }: { reason?: string; page?: boolean; ask?: Ask } = {}) {
  checkScope(scope);
  const cfg = readSkills(), s: ScopeConfig = { ...cfg[scope] }, step = key.startsWith('guide.') ? key.slice(6) : null;
  const bag = step !== null ? 'guide' : 'rules', k = step ?? key, cur = s[bag];
  if (!cur || !Object.hasOwn(cur, k)) throw new Error(`no ${bag === 'guide' ? 'guidance' : 'rule'} "${key}" set for ${scope}`);
  const doing = bag === 'rules' ? loosens(scope, k, undefined, cfg) : null;
  if (doing && page) throw pageRefusal(doing, ruleCommand(scope, k, undefined));
  if (doing) humanOnly(doing);
  const who = whoami();
  if (bag === 'rules') guard(who, cur[k] as Rule, k);
  if (doing) typed(ask, scope, k, doing, cur[k] as Rule, undefined, undefined, reason, cfg);
  const without = <T,>(m: Record<string, T> = {}) => { const { [k]: _gone, ...left } = m; return left; }; // a copy without k
  if (bag === 'guide') s.guide = without(s.guide); else s.rules = without(s.rules);
  if (!Object.keys(s[bag] ?? {}).length) delete s[bag];
  cfg[scope] = s;
  writeSkills(cfg);
  audit(scope, 'unset', { key, ...(reason && { reason }), ...stamp(who) });
  return rules(scope);
}

// docs/plans/pipelines.md §4, lenient on read: before checkSkills, a hand-edited steps.off or cap that F would refuse on write
// is fixed or dropped with a warning (rules().warnings), never a throw. Turning fewer steps off and a lower cap only tighten.
export let passWarnings: [scope: string, warning: string][] = [];
/** The checks pipelinePass dropped (a broken steps.custom or axes.on, a duplicate id): decide escalates while any is reported (§4). */
export let passDropped: [scope: string, warning: string][] = [];
/** The dropped checks a project's runs may have lost: default's, the project's and its pipelines'. Read after readSkills(). */
export const droppedFor = (repo: string) => passDropped.filter(([s]) => s === 'default' || s === repo || s.startsWith(`${repo}@`)).map(([, w]) => w);
export function pipelinePass(cfg: unknown): unknown {
  passWarnings = []; passDropped = [];
  if (!isObj(cfg)) return cfg;
  const axes = (scope: string) => { const s = cfg[scope], x = isObj(s) ? s['axes.extra'] : undefined; return Array.isArray(x) ? x.map((a: unknown) => (isObj(a) ? a.axis : null)) : []; };
  const out = Object.fromEntries(Object.entries(cfg).map(([scope, s0]) => {
    if (!isObj(s0)) return [scope, s0];
    const pipe = isPipelineScope(scope), { project } = splitScope(scope), s: Record<string, unknown> = { ...s0 };
    const ignore = (k: string, why: string, check = false) => { delete s[k]; const w = `skills.json ${scope}.${k} is ignored: ${why}`; passWarnings.push([scope, w]); if (check) passDropped.push([scope, w]); };
    // §7.1: a pipeline holds a name, its rules, its build.after custom steps and its added review steps; only a pipeline has a name
    for (const k of Object.keys(s)) {
      if (pipe && !PIPELINE_KEYS.includes(k)) ignore(k, PIPELINE_HOLDS, k === 'steps.custom');
      else if (k === 'name' && (!pipe || !NAME_OK(s.name))) ignore(k, pipe ? 'a name is 1-60 characters of text' : 'only a pipeline (owner/repo@id) has a name');
      else if (k === 'axes.on' && !pipe) ignore(k, 'axes.on is a pipeline\'s (owner/repo@id)');
      else if (k === 'steps.custom' || k === 'axes.on') { // §4: a broken list is dropped whole, and decide escalates while it is
        try {
          checkStep(k, s[k], `skills.json ${scope}.${k}`);
          if (pipe && k === 'steps.custom' && (s[k] as { slot?: unknown }[]).some((x) => x.slot === 'spec.after')) throw new Error('spec.after custom steps are the project\'s only');
        } catch (e) { ignore(k, `${(e as Error).message.replace(/^skills\.json \S+: /, '')}, so ${k === 'axes.on' ? 'it adds no reviews' : 'that scope runs the built-in pipeline'}`, true); }
      }
    }
    if (!isObj(s.rules)) return [scope, s];
    const r: Record<string, unknown> = { ...s.rules };
    for (const key of [...PER_PROJECT.filter((k) => k !== 'artifact'), ...Object.keys(r).filter((k) => pipe && !PIPELINE_RULES.includes(k))].filter((k, i, a) => Object.hasOwn(r, k) && a.indexOf(k) === i)) {
      const at = `skills.json ${scope}.rules.${key}`, warn = (w: string) => passWarnings.push([scope, `${at}${w}`]), x = r[key];
      const drop = (why: string) => { delete r[key]; warn(` is ignored: ${why}`); };
      if (scope === 'default') { drop('it is a per-project rule'); continue; }
      const where = misplaced(scope, key);
      if (where) { drop(where); continue; }
      if (!isObj(x)) { drop('it is not a rule'); continue; }
      let value = x.value;
      if (key === 'match') {
        const why = matchProblem(value); if (why) { drop(`${why} (so it never matches)`); continue; }
        if (!diffLinesTrusted(project)) (value as MatchSet[]).forEach((m, i) => { if (m.maxDiffLines !== undefined) warn(`: set ${i + 1}'s maxDiffLines never holds on a git project until #137 (a "* -diff" attribute reads as zero lines)`); }); // §7.2; pick() skips it
      }
      if (key === 'steps.off' && Array.isArray(value)) {
        const extra = [...axes('default'), ...axes(project), ...(pipe ? axes(scope) : [])], ok = (k: unknown) => typeof k === 'string' && (OPTIONAL_STEPS.includes(k) || k.startsWith('review.') && !isBuiltinAxis(k.slice(7)) && extra.includes(k.slice(7)));
        const keep = [...new Set(value.filter(ok))].slice(0, 10), gone = [...new Set(value.filter((k) => !keep.includes(k)))];
        if (gone.length) warn(`: ignoring ${gone.map(String).join(', ')}: only an optional review step or an extra axis that exists can be off (F always runs ${LOCKED_STEPS.join(', ')})`);
        if (!keep.length) { drop('nothing in it can be turned off'); continue; }
        value = keep;
      }
      if (Object.hasOwn(RUN_CAPS, key) && typeof value === 'number' && value > RUN_CAPS[key]!) { warn(`: ${value} is above the built-in cap ${RUN_CAPS[key]}, so the built-in applies`); value = RUN_CAPS[key]; }
      try { checkRules({ [key]: { ...x, value } }, at); r[key] = { ...x, value }; } catch (e) { drop((e as Error).message); }
    }
    return [scope, { ...s, rules: r }];
  }));
  // §7.1: a custom-step id or extra-axis name two owners of a project hold is dropped from the later one, keeping the project's,
  // then the first pipeline's in `pipelines` order. Only a pipeline's copy is ever dropped: the project is the first owner.
  for (const project of new Set(Object.keys(out).filter((x) => x !== 'default').map((x) => splitScope(x).project))) {
    for (const d of ownersOf(project, out).dropped) {
      const sc = out[d.owner] as Record<string, unknown>, w = `skills.json ${d.owner}: "${d.id}" is ignored: ${d.first} already has it (ids are unique across a project and its pipelines)`;
      for (const k of ['steps.custom', 'axes.extra']) if (Array.isArray(sc[k])) { sc[k] = (sc[k] as Record<string, unknown>[]).filter((x) => x.id !== d.id && x.axis !== d.id); if (!(sc[k] as unknown[]).length) delete sc[k]; }
      passWarnings.push([d.owner, w]); passDropped.push([d.owner, w]);
    }
  }
  for (const scope of Object.keys(out).filter(isPipelineScope)) { // a pipeline nobody listed is a draft: it never matches
    const { project, id } = splitScope(scope), o = out[project], list = isObj(o) && isObj(o.rules) && isObj(o.rules.pipelines) ? o.rules.pipelines.value : [];
    if (!(Array.isArray(list) && list.includes(id))) passWarnings.push([scope, `skills.json ${scope} is not listed in ${project}'s pipelines, so it never matches`]);
  }
  return out;
}
