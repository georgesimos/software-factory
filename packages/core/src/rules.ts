// @ts-nocheck
import fs from 'node:fs';
import { MAX_DIFF, MAX_ISSUES_PER_SESSION, PROJECT_BUDGET_USD } from './constants.ts';
import { STEP_KEYS, readSkills, writeSkills } from './skills.ts';
import { dashboard, gh } from '../../factory/factory.mjs';
import { projects, projectsFile } from './workspace.ts';
import { log, stateDir } from './log.ts';

export function setAutoMerge(repo, on) {
  if (!projects()[repo]) throw new Error(`${repo} is not attached; run sync first`);
  if (typeof on !== 'boolean') throw new Error('auto-merge must be on or off');
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], autoMerge: on } }, null, 2));
  dashboard.render();
  return projects()[repo];
}
// Policy rules: a closed set of typed switches that F enforces. They can only make the factory stricter, or swap a
// signal that can't be had (GitHub CI, e.g. when Actions billing fails) for one F measures itself (local checks).
// Not configurable, ever: TRUSTED, SENSITIVE, the code/security axes, --match-head-commit, imported runs escalating.
export const RULES = {
  ci: [(v) => ['required', 'advisory', 'skip'].includes(v), 'required|advisory|skip'],
  'checks.commands': [(v) => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((c) => typeof c === 'string' && c.trim() && c.length <= 300 && !/[\r\n\0]/.test(c)), 'a JSON array of 1-10 one-line commands'],
  diffCap: [(v) => Number.isInteger(v) && v >= 1 && v <= MAX_DIFF, `an integer 1-${MAX_DIFF} (it can only lower the cap)`],
  'project.budgetUsd': [(v) => typeof v === 'number' && v > 0 && v <= PROJECT_BUDGET_USD, `dollars, above 0 and at most ${PROJECT_BUDGET_USD} (it can only lower the cap)`],
  'project.maxIssuesPerSession': [(v) => Number.isInteger(v) && v >= 1 && v <= MAX_ISSUES_PER_SESSION, `an integer 1-${MAX_ISSUES_PER_SESSION} (it can only lower the cap)`],
  'deploy.preview': [(v) => ['required', 'advisory', 'off'].includes(v), 'required|advisory|off (off is the built-in; required adds a merge condition)'],
};
export const RULE_FIELDS = ['value', 'reason', 'setBy', 'setAt', 'until'];
export const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
export const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);
export const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10); // UTC; a rule applies through its whole `until` day
export const isGuideKey = (k) => k === '*' || STEP_KEYS.includes(k) || /^review\.[a-z][a-z0-9-]{0,30}$/.test(k); // review.<extra axis> too
export function checkRules(v, at) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at}: must be an object of rules`);
  for (const [k, x] of Object.entries(v)) {
    if (!RULES[k]) throw new Error(`${at}: unknown rule "${k}" (${Object.keys(RULES).join('|')}). Trusted authors, sensitive paths, required axes and the merge checks are not configurable`);
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${at}.${k}: must be {value, reason, setBy, setAt, until?}`);
    const bad = Object.keys(x).filter((f) => !RULE_FIELDS.includes(f));
    if (bad.length) throw new Error(`${at}.${k}: unknown fields ${bad.join(', ')}`);
    if (!RULES[k][0](x.value)) throw new Error(`${at}.${k}: must be ${RULES[k][1]}, got ${JSON.stringify(x.value)}`);
    if (typeof x.reason !== 'string' || !x.reason.trim() || x.reason.length > 200) throw new Error(`${at}.${k}: needs a reason (--reason "…", at most 200 characters)`);
    if (!LOGIN.test(x.setBy || '')) throw new Error(`${at}.${k}: setBy must be a GitHub login`);
    if (isNaN(Date.parse(x.setAt))) throw new Error(`${at}.${k}: setAt must be a timestamp`);
    if (x.until !== undefined && !isDay(x.until)) throw new Error(`${at}.${k}: until must be YYYY-MM-DD`);
  }
}
export function checkGuide(v, at) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at}: must be an object of step -> text`);
  for (const [k, t] of Object.entries(v)) {
    if (!isGuideKey(k)) throw new Error(`${at}: unknown step "${k}" (* | ${STEP_KEYS.join(' | ')} | review.<extra axis>)`);
    if (typeof t !== 'string' || !t.trim() || t.length > 1000) throw new Error(`${at}.${k}: guidance must be text, at most 1000 characters`);
  }
}
// Project rule over global, per key. An expired rule stops applying (the global one, or the built-in, takes over) and warns.
export function rules(repo, cfg = readSkills(), now = Date.now()) {
  const today = dayOf(now), policy = {}, expired = [], warnings = [];
  for (const scope of [...new Set([repo, 'default'])]) {
    for (const [key, x] of Object.entries(cfg[scope]?.rules || {})) {
      const what = `${key}=${JSON.stringify(x.value)} (${scope}: ${x.reason})`;
      if (x.until && x.until < today) { expired.push({ key, scope, ...x }); warnings.push(`${what} expired on ${x.until} and no longer applies; unset it or set it again with a new --until`); continue; }
      if (policy[key]) continue;
      policy[key] = { ...x, scope };
      if (x.until && Date.parse(x.until) - Date.parse(today) <= 3 * 864e5) warnings.push(`${what} expires on ${x.until}`);
    }
  }
  const g = cfg.default?.guide || {}, p = cfg[repo]?.guide || {}, guide = {};
  for (const k of new Set([...STEP_KEYS, ...Object.keys(g), ...Object.keys(p)])) { // per step: whole-flow text first, then the step's; global before project
    const texts = k === '*' ? [] : [g['*'], p['*'], g[k], p[k]].filter(Boolean);
    if (texts.length) guide[k] = texts;
  }
  return { repo, policy, guide, expired, warnings };
}
// The person changing a rule is whoever gh is logged in as; it is never typed in.
export const whoami = () => {
  let login = '';
  try { login = gh('api', 'user', '--jq', '.login').trim(); } catch { /* below */ }
  if (!LOGIN.test(login)) throw new Error('cannot tell who is changing the rule: "gh api user" failed (run gh auth login)');
  return login;
};
// Rule changes are owned events in the log (stage "rules"), not run events: derive() skips them and F event refuses them.
export function audit(scope, status, e) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(log(), JSON.stringify({ ts: new Date().toISOString(), ...e, run: scope, stage: 'rules', status }) + '\n');
  dashboard.render();
}
export const checkScope = (scope) => { if (scope !== 'default' && !/^[\w.-]+\/[\w.-]+$/.test(scope || '')) throw new Error(`scope "${scope}" must be "default" or owner/repo`); };
export function setRule(scope, key, raw, { reason, until } = {}) {
  checkScope(scope);
  const cfg = readSkills(), s = { ...cfg[scope] }, step = key.startsWith('guide.') ? key.slice(6) : null;
  let value = raw;
  if (step !== null) s.guide = { ...s.guide, [step]: String(raw ?? '') };
  else {
    if (!RULES[key]) checkRules({ [key]: {} }, `rules ${scope}`); // throws the unknown-rule message
    if (['diffCap', 'project.budgetUsd', 'project.maxIssuesPerSession'].includes(key)) value = Number(raw);
    if (key === 'checks.commands') { try { value = JSON.parse(raw); } catch { value = [raw]; } }
    if (until !== undefined && !(isDay(until) && until >= dayOf())) throw new Error('--until must be YYYY-MM-DD, today or later');
  }
  const setBy = whoami();
  if (step === null) s.rules = { ...s.rules, [key]: { value, reason, setBy, setAt: new Date().toISOString(), ...(until && { until }) } };
  cfg[scope] = s;
  writeSkills(cfg); // validates the whole config first
  audit(scope, 'set', { key, value, ...(reason && { reason }), ...(until && { until }), setBy });
  return rules(scope);
}
export function unsetRule(scope, key, { reason } = {}) {
  checkScope(scope);
  const cfg = readSkills(), s = { ...cfg[scope] }, step = key.startsWith('guide.') ? key.slice(6) : null;
  const bag = step !== null ? 'guide' : 'rules', k = step ?? key;
  if (!s[bag] || !(k in s[bag])) throw new Error(`no ${bag === 'guide' ? 'guidance' : 'rule'} "${key}" set for ${scope}`);
  const setBy = whoami();
  s[bag] = { ...s[bag] };
  delete s[bag][k];
  if (!Object.keys(s[bag]).length) delete s[bag];
  cfg[scope] = s;
  writeSkills(cfg);
  audit(scope, 'unset', { key, ...(reason && { reason }), setBy });
  return rules(scope);
}
