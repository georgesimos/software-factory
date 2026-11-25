import fs from 'node:fs';
import os from 'node:os';
import { MAX_DIFF, MAX_ISSUES_PER_SESSION, PROJECT_BUDGET_USD, isLocal } from './constants.ts';
import { STEP_KEYS, isObj, isStepKey, readSkills, writeSkills, type ScopeConfig, type SkillsConfig } from './skills.ts';
import { dashboard } from './log.ts';
import { gh } from './github.ts';
import { git, hostFn, hostOf, projects, projectsFile } from './workspace.ts';
import { humanOnly } from './projectset.ts';
import { log, stateDir } from './log.ts';
import type { Rule } from './types.ts';

export function setAutoMerge(repo: string, on: unknown) {
  if (!projects()[repo]) throw new Error(`${repo} is not attached; run sync first`);
  if (typeof on !== 'boolean') throw new Error('auto-merge must be on or off');
  if (on) { // D1: on lets runs merge with nobody asked, so it comes from you (F automerge, or the page's toggle in F ui), verified where the host can verify
    if (hostOf(repo) !== 'github') throw new Error(`${repo} is a git project: it always asks before merging (F approve RUN --merge)`);
    humanOnly('turning auto-merge on');
    if (whoami('turning auto-merge on').via !== 'github') throw new Error('turning auto-merge on for a GitHub project needs a verified login (gh auth login)');
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
export const RULES: Record<string, [check: (v: unknown) => boolean, want: string]> = {
  ci: [oneOf('required', 'advisory', 'skip'), 'required|advisory|skip'],
  'checks.commands': [(v) => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((c: unknown) => typeof c === 'string' && c.trim() && c.length <= 300 && !/[\r\n\0]/.test(c)), 'a JSON array of 1-10 one-line commands'],
  diffCap: [(v) => int(v) && v >= 1 && v <= MAX_DIFF, `an integer 1-${MAX_DIFF} (it can only lower the cap)`],
  'project.budgetUsd': [(v) => typeof v === 'number' && v > 0 && v <= PROJECT_BUDGET_USD, `dollars, above 0 and at most ${PROJECT_BUDGET_USD} (it can only lower the cap)`],
  'project.maxIssuesPerSession': [(v) => int(v) && v >= 1 && v <= MAX_ISSUES_PER_SESSION, `an integer 1-${MAX_ISSUES_PER_SESSION} (it can only lower the cap)`],
  'deploy.preview': [oneOf('required', 'advisory', 'off'), 'required|advisory|off (off is the built-in; required adds a merge condition)'],
  artifact: [(v) => typeof v === 'string' && ARTIFACT_URL.test(v), 'a private claude.ai Artifact URL (https://claude.ai/artifact/<id>); opts this repo\'s runs in to republishing it'],
};
export const RULE_FIELDS = ['value', 'reason', 'setBy', 'via', 'setAt', 'until'];
export const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
// Who changed a rule or wrote a note, and how sure F is: 'github' (gh api user, a verified login; also every rule with no via)
// or 'local' (the OS user, which can be DOMAIN\user on Windows: weaker, so it can't relax a merge condition; see gate.ts).
export type Via = 'github' | 'local';
export const LOCAL_BY = /^[^\x00-\x1f\x7f]{1,100}$/;

export const isDay = (s: unknown): boolean => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s); // a string: ["2026-11-01"] read as one
export const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10); // UTC; a rule applies through its whole `until` day
export const isGuideKey = (k: string) => k === '*' || isStepKey(k) || /^review\.[a-z][a-z0-9-]{0,30}$/.test(k); // review.<extra axis> too
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
  const today = dayOf(now), policy: Record<string, Rule> = {}, expired: Rule[] = [], warnings: string[] = [];
  for (const scope of [...new Set([repo, 'default'])]) {
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
const stamp = (who: { by: string; via: Via }) => ({ setBy: who.by, ...(who.via === 'local' && { via: who.via }) }); // a GitHub login is stored as before: no via
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
export const checkScope = (scope: string) => { if (scope !== 'default' && !(typeof scope === 'string' && /^[\w.-]+\/[\w.-]+$/.test(scope))) throw new Error(`scope "${scope}" must be "default" or owner/repo`); };
export function setRule(scope: string, key: string, raw: unknown, { reason, until }: { reason?: string; until?: string } = {}) {
  checkScope(scope);
  const cfg = readSkills(), s: ScopeConfig = { ...cfg[scope] }, step = key.startsWith('guide.') ? key.slice(6) : null;
  let value: unknown = raw;
  if (step !== null) s.guide = { ...s.guide, [step]: String(raw ?? '') };
  else {
    if (!Object.hasOwn(RULES, key)) checkRules({ [key]: {} }, `rules ${scope}`); // throws the unknown-rule message
    if (key === 'artifact' && scope === 'default') throw new Error('artifact is a per-repo opt-in: set it on owner/repo, not default');
    if (['diffCap', 'project.budgetUsd', 'project.maxIssuesPerSession'].includes(key)) value = Number(raw);
    if (key === 'checks.commands') { try { value = JSON.parse(String(raw)); } catch { value = [raw]; } } // JSON.parse makes a string of raw anyway
    if (until !== undefined && !(isDay(until) && until >= dayOf())) throw new Error('--until must be YYYY-MM-DD, today or later');
  }
  const who = whoami();
  if (step === null) { guard(who, s.rules?.[key], key); guardShadow(who, scope, cfg.default?.rules?.[key], key, value); s.rules = { ...s.rules, [key]: { value, reason, ...stamp(who), setAt: new Date().toISOString(), ...(until && { until }) } }; }
  cfg[scope] = s;
  writeSkills(cfg); // validates the whole config first
  audit(scope, 'set', { key, value, ...(reason && { reason }), ...(until && { until }), ...stamp(who) });
  return rules(scope);
}
export function unsetRule(scope: string, key: string, { reason }: { reason?: string } = {}) {
  checkScope(scope);
  const cfg = readSkills(), s: ScopeConfig = { ...cfg[scope] }, step = key.startsWith('guide.') ? key.slice(6) : null;
  const bag = step !== null ? 'guide' : 'rules', k = step ?? key, cur = s[bag];
  if (!cur || !Object.hasOwn(cur, k)) throw new Error(`no ${bag === 'guide' ? 'guidance' : 'rule'} "${key}" set for ${scope}`);
  const who = whoami();
  if (bag === 'rules') guard(who, cur[k] as Rule, k);
  const without = <T,>(m: Record<string, T> = {}) => { const { [k]: _gone, ...left } = m; return left; }; // a copy without k
  if (bag === 'guide') s.guide = without(s.guide); else s.rules = without(s.rules);
  if (!Object.keys(s[bag] ?? {}).length) delete s[bag];
  cfg[scope] = s;
  writeSkills(cfg);
  audit(scope, 'unset', { key, ...(reason && { reason }), ...stamp(who) });
  return rules(scope);
}
