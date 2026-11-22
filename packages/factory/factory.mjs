#!/usr/bin/env node
// Software factory state: append-only event log -> derived run state -> dashboard.html.
// Every state change goes through this script; never hand-edit events.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let DIR = process.env.FACTORY_DIR || path.join(os.homedir(), '.claude', 'factory');
const log = () => path.join(DIR, 'events.jsonl');
const GH = process.env.FACTORY_GH || 'gh'; // overridable only so the self-test can stub GitHub
const GIT = process.env.FACTORY_GIT || 'git';

export const CAP = 3;          // max build iterations before escalating
export const MAX_DIFF = 300;   // added + deleted lines allowed for auto-merge
export const COST_CAP = 5;     // USD per run; over it, the run stops looping and escalates
export const TOKEN_CAP = 3_000_000; // same, for runs that record tokens but not dollars
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const OUTCOMES = ['rejected', 'needs-info', 'merged', 'escalated', 'closed', 'awaiting-approval', 'split'];
const TERMINAL = ['rejected', 'merged', 'escalated', 'closed', 'split']; // needs-info / awaiting-approval resume later
const STAGES = ['intake', 'spec', 'build', 'review', 'gate', 'approve'];
const STATUSES = ['started', 'passed', 'failed', 'decided', 'reverted', ...OUTCOMES];
const BLOCKING = ['high', 'medium'];
const SENSITIVE = /(^|\/)(auth|login|session|oauth|payments?|billing|money|migrations?)(\/|\.|$)|^\.github\/workflows\/|(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock))$|(^|\/)\.env|(^|\/)\.(claude|codex)\//i; // .claude/.codex: a branch's own agent skills, hooks and settings
const UI = /\.(tsx|jsx|vue|svelte|astro|html|css|scss|sass|less)$/i;
const SEO = /(^|\/)(page|layout|head|metadata|sitemap|robots|opengraph-image)\.[a-z]+$|(^|\/)pages\/|\.html$/i;
const DOCS = /\.mdx?$|(^|\/)\.env\.example$|(^|\/)(app\/api|pages\/api|routes|cli|bin)\//i; // docs, env and public API surface
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|swift|php|cs|vue|svelte)$/i;
const TEST = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?|e2e|spec)\//i;
const SEVERITIES = ['high', 'medium', 'low'];
const REVIEW_KEYS = ['axis', 'verdict', 'findings', 'costUsd', 'tokens'];
const FINDING_KEYS = ['severity', 'file', 'line', 'issue', 'route', 'dismissed'];
const blocking = (f) => BLOCKING.includes(f.severity) && !f.dismissed; // a verifier-dismissed finding never blocks

export const runDir = (run) => path.join(DIR, run.replace(/[^a-z0-9]+/gi, '-'));

export function read() {
  try {
    return fs.readFileSync(log(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export function record(run, stage, status, payload = {}, cli) { // cli: {fallback?} when the orchestrator reports a step; in-process records (sync, demo) get no runner
  if (!run) throw new Error('missing run id');
  if (!STAGES.includes(stage)) throw new Error(`unknown stage "${stage}" (${STAGES.join('|')})`);
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}" (${STATUSES.join('|')})`);
  if (status === 'merged' && derive(read())[run]?.decision?.action !== 'merge') throw new Error('refusing "merged": the recorded decision is not merge');
  if (stage === 'review' && payload.axis !== undefined) validateReview(run, payload, status);
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID; // set by Claude Code; lets the UI link back to the driving session
  const ev = { ts: new Date().toISOString(), ...payload, ...(sessionId ? { harness: 'claude-code', sessionId, cwd: process.cwd() } : {}), ...(cli && runnerStamp(run, stage, payload.axis, cli.fallback)), run, stage, status };
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(log(), JSON.stringify(ev) + '\n');
  if (TERMINAL.includes(status) || status === 'needs-info') { // a finished (or parked) run gives back its worktree
    try { const c = cleanup(run); if (c.startsWith('kept')) console.error(`factory: ${c}`); } catch (e) { console.error(`factory: worktree cleanup failed: ${e.message}`); }
  }
  render();
  return ev;
}

// Reviewer output is untrusted model text: reject anything outside the contract instead of storing it.
function validateReview(run, p, status) {
  const extra = Object.keys(p).filter((k) => !REVIEW_KEYS.includes(k));
  if (extra.length) throw new Error(`review payload has unknown fields: ${extra.join(', ')}`);
  const r = derive(read())[run];
  const axes = r?.axes?.[r.iteration] || [];
  if (!axes.includes(p.axis)) throw new Error(`axis "${p.axis}" is not one of this iteration's axes (${axes.join(', ') || 'none recorded'})`);
  if (!Array.isArray(p.findings || [])) throw new Error('findings must be an array');
  for (const f of p.findings || []) {
    const bad = Object.keys(f).filter((k) => !FINDING_KEYS.includes(k));
    if (bad.length) throw new Error(`finding has unknown fields: ${bad.join(', ')}`);
    if (!SEVERITIES.includes(f.severity)) throw new Error(`finding severity must be ${SEVERITIES.join('|')}`);
    if (!['spec', 'build'].includes(f.route)) throw new Error('finding route must be spec|build');
    if (typeof f.issue !== 'string' || !f.issue) throw new Error('finding needs an issue sentence');
  }
  if (status === 'failed' && !(p.findings || []).some(blocking)) throw new Error('a failed review needs at least one undismissed high or medium finding (record "passed" if the verifier dismissed them all)');
}

export function derive(events) {
  const runs = {};
  for (const e of events) {
    if (e.stage === 'rules') continue; // rule changes: an audit trail, not a run
    const r = (runs[e.run] ??= { id: e.run, iteration: 0, reviews: {}, loopbacks: [], events: [], outcome: 'in-progress' });
    r.events.push(e);
    Object.assign(r, { stage: e.stage, status: e.status, updated: e.ts });
    r.started ??= e.ts;
    for (const k of ['title', 'url', ...(e.status === 'reverted' ? [] : ['pr']), 'branch', 'spec', 'issues', 'children']) if (e[k]) r[k] = e[k];
    if (e.stage === 'intake' && e.status === 'started') for (const k of ['author', 'association', 'source', 'imported', 'origin', 'originAssociation']) if (e[k]) r[k] = e[k];
    if (e.sessionId && !(r.sessions ||= []).some((x) => x.id === e.sessionId)) r.sessions.push({ agent: e.harness, id: e.sessionId, cwd: e.cwd, last: e.ts });
    else if (e.sessionId) r.sessions.find((x) => x.id === e.sessionId).last = e.ts;
    if (e.costUsd) r.costUsd = +((r.costUsd || 0) + e.costUsd).toFixed(4);
    if (e.tokens) r.tokens = (r.tokens || 0) + e.tokens;
    if (e.stage === 'intake' && e.status === 'started') r.outcome = 'in-progress'; // resume after needs-info
    if (r.outcome === 'awaiting-approval' && !OUTCOMES.includes(e.status)) r.outcome = 'in-progress'; // spec approved
    if (e.status === 'reverted') r.reverted = { pr: e.pr, reason: e.reason };
    if (e.stage === 'build' && e.status === 'started') r.iteration++;
    if (e.stage === 'build' && e.localChecks) r.localChecks = e.localChecks; // only "F checks" records it
    if (e.stage === 'review' && e.status === 'started') { r.axes = { ...r.axes, [r.iteration]: e.axes }; if (e.sha) r.reviewedSha = e.sha; }
    if (e.stage === 'review' && e.axis) {
      const findings = e.findings || [];
      const verdict = findings.some(blocking) ? 'failed' : 'passed'; // findings outrank the verdict word
      (r.reviews[r.iteration] ??= {})[e.axis] = { verdict, findings, ...(e.runner && { runner: e.runner }) };
    }
    if (e.stage !== 'review' && (e.runner || r.runners?.[e.stage])) (r.runners ??= {})[e.stage] = e.runner; // latest event of the stage wins
    if (e.stage === 'gate' && ['spec', 'build'].includes(e.next)) r.loopbacks.push({ iteration: r.iteration, route: e.next, reasons: e.reasons, ts: e.ts });
    if (e.stage === 'approve' && e.status === 'decided') r.decision = { action: e.action, reasons: e.reasons };
    if (OUTCOMES.includes(e.status)) r.outcome = e.status;
  }
  for (const r of Object.values(runs)) {
    r.durationMs = Date.parse(r.updated) - Date.parse(r.started);
    for (const c of r.children || []) if (runs[c]) runs[c].parent = r.id;
  }
  return runs;
}

const getRun = (run) => {
  const r = derive(read())[run] || readArchive().find((a) => a.id === run);
  if (!r) throw new Error(`no run ${run}`);
  return r;
};

export function axesFor(files, extra = []) {
  const axes = ['code', 'security'];
  if (files.some((f) => UI.test(f))) axes.push('ux', 'ui');
  if (files.some((f) => SEO.test(f))) axes.push('seo');
  if (files.some((f) => DOCS.test(f))) axes.push('docs');
  for (const x of extra) if (files.some((f) => x.when.some((g) => path.matchesGlob(f, g)))) axes.push(x.axis); // user axes only add, never replace. shortcut: path.matchesGlob needs Node >= 22.5 (experimental before 24); swap in a small glob regex if older Node matters
  return axes;
}

// Loop-backs re-review only what the new commits touch, plus every axis that failed last time.
export function reviewAxes(r, files, extra = []) {
  const prev = Math.max(-1, ...Object.keys(r.axes || {}).map(Number).filter((i) => i < r.iteration));
  const failed = prev < 0 ? [] : r.axes[prev].filter((a) => r.reviews[prev]?.[a]?.verdict !== 'passed');
  return [...new Set([...axesFor(files, extra), ...failed])];
}

export function gate(r) {
  const expected = r.axes?.[r.iteration];
  if (!expected) throw new Error(`no review axes recorded for iteration ${r.iteration}; run "axes" first`);
  const rev = r.reviews[r.iteration] || {};
  const missing = expected.filter((a) => !rev[a]);
  if (missing.length) throw new Error(`missing review verdicts: ${missing.join(', ')}`);
  const failed = expected.filter((a) => rev[a].verdict !== 'passed');
  if (!failed.length) return { status: 'passed', next: 'approve', reasons: [`all axes passed: ${expected.join(', ')}`] };
  const findings = failed.flatMap((a) => rev[a].findings.filter(blocking));
  const route = findings.some((f) => f.route === 'spec') ? 'spec' : 'build';
  const reasons = failed.map((a) => `${a}: ${rev[a].findings.filter(blocking).length} blocking finding(s)`);
  if (r.iteration >= CAP) return { status: 'failed', next: 'approve', reasons: [...reasons, `loop cap ${CAP} reached`] };
  if ((r.costUsd || 0) > COST_CAP || (r.tokens || 0) > TOKEN_CAP) return { status: 'failed', next: 'approve', reasons: [...reasons, `budget reached ($${r.costUsd || 0}, ${r.tokens || 0} tokens)`] };
  return { status: 'failed', next: route, reasons };
}

// Default is escalate: merge only when every condition holds.
export function decide(r, f) {
  if (r.imported) return { action: 'escalate', reasons: [`imported ${r.source || ''} run: the factory did not spec or build it`] };
  const why = [];
  const assoc = f.association ?? r.association; // facts() reads it live from GitHub
  if (!TRUSTED.includes(assoc)) why.push(`author association "${assoc || 'unknown'}" is not trusted`);
  if (r.originAssociation && !TRUSTED.includes(r.originAssociation)) why.push(`split from ${r.origin}, whose author "${r.originAssociation}" is not trusted`);
  if (f.autoMerge === false) why.push('auto-merge is turned off for this project');
  const expected = r.axes?.[r.iteration] || [];
  const rev = r.reviews[r.iteration] || {};
  const notPassed = expected.filter((a) => rev[a]?.verdict !== 'passed');
  if (!expected.length) why.push('no reviews recorded');
  if (notPassed.length) why.push(`axes not passed: ${notPassed.join(', ')}`);
  // CI: required unless a rule says otherwise. Not required never means green: F's own local checks on the reviewed commit stand in, or the run escalates.
  const pol = f.rules || {}, ci = pol.ci?.value || 'required', cmds = pol['checks.commands']?.value;
  const by = (x) => `set by ${x.setBy} on ${String(x.setAt).slice(0, 10)}: ${x.reason}`;
  if (ci === 'required' && f.checks !== 'pass') why.push(`CI checks are "${f.checks ?? 'unknown'}"`);
  const ruleNote = ci === 'required' ? null : `CI not required by rule ci=${ci}, ${by(pol.ci)}${ci === 'advisory' ? ` (CI is "${f.checks ?? 'unknown'}")` : ''}`;
  let local = null;
  if (ci !== 'required' || cmds) {
    const lc = r.localChecks, short = (s) => String(s || 'none').slice(0, 7);
    const failing = (lc?.commands || []).filter((c) => c.exit !== 0).map((c) => c.cmd);
    local = !cmds ? { ok: false, text: 'no checks.commands rule replaces CI, so nothing was checked' }
      : !lc ? { ok: false, text: 'Local checks: not run ("F checks")' }
      : lc.sha !== r.reviewedSha ? { ok: false, text: `Local checks: ran on ${short(lc.sha)}, not the reviewed commit ${short(r.reviewedSha)}` }
      : JSON.stringify((lc.commands || []).map((c) => c.cmd)) !== JSON.stringify(cmds) ? { ok: false, text: 'Local checks: ran a different command list than the checks.commands rule now has' }
      : lc.state !== 'pass' || failing.length ? { ok: false, text: `Local checks: fail (${failing.join(', ') || 'unknown'})` }
      : { ok: true, text: `Local checks: pass (${cmds.join(', ')})` };
  }
  const ciLine = [ruleNote, local?.text].filter(Boolean).join('. ');
  if (local && !local.ok) why.push(ciLine);
  const lines = (f.additions || 0) + (f.deletions || 0), cap = Math.min(MAX_DIFF, pol.diffCap?.value ?? MAX_DIFF);
  if (lines > cap) why.push(`diff is ${lines} lines (max ${cap}${cap < MAX_DIFF ? ` by rule diffCap, ${by(pol.diffCap)}` : ''})`);
  const sens = (f.files || []).filter((p) => SENSITIVE.test(p));
  if (sens.length) why.push(`touches sensitive paths: ${sens.join(', ')}`);
  if (r.iteration > CAP) why.push(`iteration ${r.iteration} exceeds cap ${CAP}`);
  if ((r.costUsd || 0) > COST_CAP || (r.tokens || 0) > TOKEN_CAP) why.push(`run budget exceeded ($${r.costUsd || 0}, ${r.tokens || 0} tokens)`);
  const src = (f.files || []).filter((p) => SOURCE.test(p) && !TEST.test(p));
  if (src.length && !(f.files || []).some((p) => TEST.test(p))) why.push(`source changed (${src.length} file(s)) with no test change`);
  if (!r.pr) why.push('no PR recorded');
  if (ciLine && local?.ok && why.length) why.push(ciLine); // context: this escalation happened under a CI rule
  return why.length
    ? { action: 'escalate', reasons: why }
    : ciLine ? { action: 'merge', reasons: [`trusted author, all axes passed, tests changed, ${lines}-line diff, no sensitive paths`, ...(ci === 'required' ? ['CI green'] : []), ciLine] }
    : { action: 'merge', reasons: [`trusted author, all axes passed, CI green, tests changed, ${lines}-line diff, no sensitive paths`] };
}

// Before building: untrusted authors and sensitive planned files need a human to approve the spec.
export function risk(r, plannedFiles) {
  const reasons = [];
  if (!TRUSTED.includes(r.association)) reasons.push(`author association "${r.association || 'unknown'}" is not trusted`);
  if (r.originAssociation && !TRUSTED.includes(r.originAssociation)) reasons.push(`split from ${r.origin}, whose author is not trusted`);
  const sens = plannedFiles.filter((p) => SENSITIVE.test(p));
  if (sens.length) reasons.push(`plans to touch sensitive paths: ${sens.join(', ')}`);
  return { risky: reasons.length > 0, reasons };
}

// Who does each step: the built-in brief, the user's own skill or brief, or a harness's tool.
// User-local only (DIR/skills.json): a repo, and so a PR, can never pick its own reviewers.
const BUILTIN_AXES = ['code', 'security', 'ux', 'ui', 'seo', 'docs'];
export const REQUIRED_AXES = ['code', 'security']; // axesFor always selects them; config can swap who reviews, never drop them
export const STEP_KEYS = ['intake', 'spec', 'build', ...BUILTIN_AXES.map((a) => `review.${a}`), 'verifier', 'postmerge'];
const HARNESSES = ['claude-code', 'codex'];
const NAME = /^[\w.-]+(:[\w.-]+)?$/; // skill, plugin:skill or agent type; it ends up in a command line
const skillsFile = () => path.join(DIR, 'skills.json');

function checkRunner(s, at, more = []) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at}: a runner must be a JSON object`);
  const bad = Object.keys(s).filter((k) => !['use', 'name', 'path', 'harness', ...more].includes(k));
  if (bad.length) throw new Error(`${at}: unknown fields ${bad.join(', ')}`);
  const ok = s.use === 'default' && !s.name && !s.path && !s.harness
    || s.use === 'skill' && NAME.test(s.name || '') && !s.path && !s.harness
    || s.use === 'brief' && /^(\/|~\/).*\.md$/.test(s.path || '') && !s.name && !s.harness // outside any worktree, so a branch can't supply it
    || s.use === 'provider' && HARNESSES.includes(s.harness) && (s.name === undefined || NAME.test(s.name)) && !s.path;
  if (!ok) throw new Error(`${at}: expected {"use":"default"}, {"use":"skill","name"}, {"use":"brief","path":"/abs/or/~/….md"} or {"use":"provider","harness":"${HARNESSES.join('|')}","name"?}`);
}

function checkStep(key, v, at) {
  if (key === 'rules') return checkRules(v, at);
  if (key === 'guide') return checkGuide(v, at);
  if (key !== 'axes.extra') {
    if (!STEP_KEYS.includes(key)) throw new Error(`${at}: unknown step "${key}" (${STEP_KEYS.join('|')}|axes.extra)`);
    return checkRunner(v, at);
  }
  if (!Array.isArray(v)) throw new Error(`${at}: must be an array of {axis, when, use, …}`);
  for (const x of v) {
    checkRunner(x, at, ['axis', 'when']);
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(x.axis || '') || BUILTIN_AXES.includes(x.axis)) throw new Error(`${at}: extra axis "${x.axis}" must be a new lowercase name; configure built-in axes as review.<axis>`);
    if (!Array.isArray(x.when) || !x.when.length || !x.when.every((g) => typeof g === 'string' && g)) throw new Error(`${at}: extra axis "${x.axis}" needs "when": ["<glob>", …]`);
    if (x.use === 'default') throw new Error(`${at}: extra axis "${x.axis}" has no built-in brief; use a skill, brief or provider`);
  }
}

function checkSkills(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('skills.json must be a JSON object');
  for (const [scope, steps] of Object.entries(cfg)) {
    if (scope !== 'default' && !/^[\w.-]+\/[\w.-]+$/.test(scope)) throw new Error(`skills.json: scope "${scope}" must be "default" or owner/repo`);
    if (!steps || typeof steps !== 'object' || Array.isArray(steps)) throw new Error(`skills.json: ${scope} must be an object`);
    for (const [k, v] of Object.entries(steps)) checkStep(k, v, `skills.json ${scope}.${k}`);
  }
  return cfg;
}

export function readSkills() {
  try { return checkSkills(JSON.parse(fs.readFileSync(skillsFile(), 'utf8'))); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(e.message.startsWith('skills.json') ? e.message : `skills.json: ${e.message}`);
  }
}

// The resolved plan: per step the project's runner, else the global one, else the built-in. Extra axes add up, project wins per axis.
export function skills(repo, cfg = readSkills()) {
  const g = cfg.default || {}, p = cfg[repo] || {};
  const plan = Object.fromEntries(STEP_KEYS.map((k) => [k, p[k] || g[k] || { use: 'default' }]));
  const all = [...(g['axes.extra'] || []), ...(p['axes.extra'] || [])];
  const extra = all.filter((x, i) => all.findLastIndex((y) => y.axis === x.axis) === i);
  return { repo, plan, extra, required: REQUIRED_AXES, guide: rules(repo, cfg).guide };
}

function writeSkills(cfg) {
  checkSkills(cfg);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(skillsFile() + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(skillsFile() + '.tmp', skillsFile());
}

export function setSkill(scope, key, value) {
  if (key === 'rules' || key === 'guide') throw new Error(`"${key}" is set with "rules set", which records who changed it and why`);
  const cfg = readSkills();
  cfg[scope] = { ...cfg[scope], [key]: value };
  writeSkills(cfg);
  return cfg[scope];
}

// Policy rules: a closed set of typed switches that F enforces. They can only make the factory stricter, or swap a
// signal that can't be had (GitHub CI, e.g. when Actions billing fails) for one F measures itself (local checks).
// Not configurable, ever: TRUSTED, SENSITIVE, the code/security axes, --match-head-commit, imported runs escalating.
const RULES = {
  ci: [(v) => ['required', 'advisory', 'skip'].includes(v), 'required|advisory|skip'],
  'checks.commands': [(v) => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((c) => typeof c === 'string' && c.trim() && c.length <= 300 && !/[\r\n\0]/.test(c)), 'a JSON array of 1-10 one-line commands'],
  diffCap: [(v) => Number.isInteger(v) && v >= 1 && v <= MAX_DIFF, `an integer 1-${MAX_DIFF} (it can only lower the cap)`],
};
const RULE_FIELDS = ['value', 'reason', 'setBy', 'setAt', 'until'];
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s);
const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10); // UTC; a rule applies through its whole `until` day
const isGuideKey = (k) => k === '*' || STEP_KEYS.includes(k) || /^review\.[a-z][a-z0-9-]{0,30}$/.test(k); // review.<extra axis> too

function checkRules(v, at) {
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

function checkGuide(v, at) {
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
const whoami = () => {
  let login = '';
  try { login = gh('api', 'user', '--jq', '.login').trim(); } catch { /* below */ }
  if (!LOGIN.test(login)) throw new Error('cannot tell who is changing the rule: "gh api user" failed (run gh auth login)');
  return login;
};

// Rule changes are owned events in the log (stage "rules"), not run events: derive() skips them and F event refuses them.
function audit(scope, status, e) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(log(), JSON.stringify({ ts: new Date().toISOString(), ...e, run: scope, stage: 'rules', status }) + '\n');
  render();
}

export function setRule(scope, key, raw, { reason, until } = {}) {
  const cfg = readSkills(), s = { ...cfg[scope] }, step = key.startsWith('guide.') ? key.slice(6) : null;
  let value = raw;
  if (step !== null) s.guide = { ...s.guide, [step]: String(raw ?? '') };
  else {
    if (!RULES[key]) checkRules({ [key]: {} }, `rules ${scope}`); // throws the unknown-rule message
    if (key === 'diffCap') value = Number(raw);
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

// F, not the payload, says who did the work. Default runners leave events unchanged; a fallback can only downgrade to default.
function runnerStamp(run, stage, axis, fallback) {
  const key = stage === 'review' ? (axis && `review.${axis}`) : stage === 'gate' ? 'verifier' : ['intake', 'spec', 'build'].includes(stage) ? stage : null;
  if (!key) return {};
  const { plan, extra } = skills(run.split(/[#:]/)[0]);
  const { axis: _a, when: _w, ...runner } = plan[key] || extra.find((x) => x.axis === axis) || { use: 'default' };
  if (fallback) return { runner: { use: 'default', fallback: { from: runner, reason: String(fallback).slice(0, 200) } } };
  return runner.use === 'default' ? {} : { runner };
}

// Reviewer output from any runner is untrusted text: anything outside the contract is a failed review, never a pass.
export function reviewFromText(run, axis, text) {
  const r = derive(read())[run];
  const axes = r?.axes?.[r.iteration] || [];
  if (!axes.includes(axis)) throw new Error(`axis "${axis}" is not one of this iteration's axes (${axes.join(', ') || 'none recorded'})`);
  try {
    const p = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n([^]*)\n```$/, '$1'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not a JSON object');
    if (p.axis !== axis) throw new Error(`axis is "${p.axis}", expected "${axis}"`); // a reviewer can't overwrite another axis's cell
    if (!['passed', 'failed'].includes(p.verdict)) throw new Error('verdict must be passed|failed');
    validateReview(run, p, p.verdict);
    return { status: (p.findings || []).some(blocking) ? 'failed' : 'passed', payload: p };
  } catch (e) {
    return { status: 'failed', payload: { axis, verdict: 'failed', findings: [{ severity: 'high', issue: `reviewer output invalid: ${e.message}`.slice(0, 300), route: 'build' }] } };
  }
}

const gh = (...args) => execFileSync(GH, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const parseRun = (run) => {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(run || '');
  if (!m) throw new Error(`run must look like owner/repo#N, got "${run}"`);
  return { repo: `${m[1]}/${m[2]}`, n: m[3] };
};

// Fetches the issue itself so title/author/association are never model-typed. Prints what intake should read.
export function intake(run) {
  const { repo, n } = parseRun(run);
  if (process.env.FACTORY_FIXTURES && repo === 'eval/golden') return intakeFixture(run, n); // offline eval: no GitHub
  // Exact links only (GitHub closing references); the factory's own branch is a resume, not a clash.
  const { prs } = openPRs(repo);
  const inProgress = prs
    .filter((p) => p.headRefName !== `factory/issue-${n}` && p.closingIssuesReferences.nodes.some((x) => String(x.number) === n))
    .map((p) => p.url);
  if (inProgress.length) return { inProgress }; // nothing recorded: someone is already on it
  const i = JSON.parse(gh('api', `repos/${repo}/issues/${n}`));
  if (i.pull_request) return { notAnIssue: `#${n} is a pull request` };
  if (i.state !== 'open') return { notAnIssue: `#${n} is ${i.state}` };
  // Advisory only: PRs naming the issue in their title without a formal closing link.
  const mentions = prs.filter((p) => p.headRefName !== `factory/issue-${n}` && new RegExp(`(^|[^\\w])#${n}(?!\\d)`).test(p.title)).map((p) => ({ url: p.url, title: p.title }));
  const comments = gh('api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[]').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = { title: i.title, url: i.html_url, author: i.user.login, association: i.author_association };
  // A split child is authored by whoever ran the split; it inherits its parent's (possibly untrusted) author.
  const parent = [...Object.values(derive(read())), ...readArchive()].find((r) => (r.children || []).includes(run));
  if (parent) Object.assign(meta, { origin: parent.id, originAssociation: parent.originAssociation || parent.association });
  record(run, 'intake', 'started', meta);
  // Only the reporter and repo insiders may shape requirements; others could steer a trusted issue into auto-merge.
  const counts = (c) => c.user.login === meta.author || TRUSTED.includes(c.author_association);
  return {
    ...meta, state: i.state, body: i.body, mentions,
    comments: comments.filter(counts).map((c) => ({ author: c.user.login, association: c.author_association, created_at: c.created_at, body: c.body })),
    ignoredComments: comments.filter((c) => !counts(c)).length,
  };
}

function intakeFixture(run, n) {
  const fx = JSON.parse(fs.readFileSync(path.join(process.env.FACTORY_FIXTURES, `${n}.json`), 'utf8'));
  const meta = { title: fx.issue.title, url: `https://github.com/eval/golden/issues/${n}`, author: fx.issue.author, association: fx.issue.association };
  record(run, 'intake', 'started', meta);
  return { ...meta, state: 'open', body: fx.issue.body, mentions: [], comments: fx.comments || [], ignoredComments: 0, dryRun: true };
}

const git = (...args) => execFileSync(GIT, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const projectsFile = () => path.join(DIR, 'projects.json');
export const projects = () => { try { return JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); } catch { return {}; } };
const saveProject = (repo, p) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], path: p, synced: projects()[repo]?.synced } }, null, 2)); };
const wtFile = (run) => path.join(runDir(run), 'worktree.json');
const wtInfo = (run) => { try { return JSON.parse(fs.readFileSync(wtFile(run), 'utf8')); } catch { return null; } };

// One git worktree per run, sharing the clone's object store (not a second clone). A resume recreates it from the pushed branch.
export function worktree(run, repoPath) {
  const have = wtInfo(run);
  if (have && fs.existsSync(have.path)) return have;
  const { repo, n } = parseRun(run);
  repoPath = repoPath ? path.resolve(repoPath) : projects()[repo]?.path;
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) throw new Error(`no local clone for ${repo}; pass its path: worktree ${run} <path>`);
  const base = gh('repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name').trim();
  const branch = `factory/issue-${n}`;
  const wt = path.join(runDir(run), 'wt');
  fs.mkdirSync(runDir(run), { recursive: true });
  git('-C', repoPath, 'worktree', 'prune');
  git('-C', repoPath, 'fetch', '-q', 'origin', base);
  let from = `origin/${base}`;
  try { git('-C', repoPath, 'fetch', '-q', 'origin', `${branch}:refs/remotes/origin/${branch}`); from = `origin/${branch}`; } catch { /* first run: nothing pushed yet */ }
  git('-C', repoPath, 'worktree', 'add', '-q', '-B', branch, wt, from);
  const info = { repoPath, path: wt, branch, base };
  fs.writeFileSync(wtFile(run), JSON.stringify(info, null, 2));
  if (projects()[repo]?.path !== repoPath) saveProject(repo, repoPath);
  return info;
}

// Removes a run's worktree and local branch, unless that would lose uncommitted or unpushed work.
export function cleanup(run) {
  const w = wtInfo(run);
  if (!w) return 'none';
  if (fs.existsSync(w.path)) {
    const dirty = git('-C', w.path, 'status', '--porcelain').trim();
    const unpushed = git('-C', w.path, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin').trim();
    if (dirty || unpushed !== '0') return `kept ${w.path}: ${dirty ? 'uncommitted changes' : `${unpushed} unpushed commit(s)`}`;
    git('-C', w.repoPath, 'worktree', 'remove', '--force', w.path);
  }
  git('-C', w.repoPath, 'worktree', 'prune');
  try { git('-C', w.repoPath, 'branch', '-D', w.branch); } catch { /* already gone */ }
  fs.rmSync(wtFile(run));
  return 'removed';
}

// Sweeps worktrees of finished runs (e.g. a session that ended before cleanup ran).
export function gc() {
  const out = {};
  for (const r of Object.values(derive(read()))) if (r.outcome !== 'in-progress' && wtInfo(r.id)) out[r.id] = cleanup(r.id);
  for (const { path: p } of Object.values(projects())) if (p && fs.existsSync(p)) git('-C', p, 'worktree', 'prune');
  return out;
}

// Cheapest node_modules for a run's worktree. Prints one line; install logs only on failure, to keep them out of the context.
export function deps(run) {
  const w = wtInfo(run);
  if (!w) throw new Error(`no worktree for ${run}; run "worktree" first`);
  const has = (dir, f) => fs.existsSync(path.join(dir, f));
  const sh = (cmd, args) => {
    try { execFileSync(cmd, args, { cwd: w.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      const tail = (x) => String(x || '').trim().split('\n').slice(-15).join('\n');
      throw new Error(`${cmd} ${args.join(' ')} failed:\n${tail(e.stdout)}\n${tail(e.stderr)}`);
    }
  };
  if (!has(w.path, 'package.json')) return 'no package.json: nothing to install';
  if (has(w.path, 'node_modules')) return 'node_modules already present';
  if (has(w.path, 'pnpm-lock.yaml')) { sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline']); return 'pnpm install: packages hard-linked from the shared store'; }
  const lock = ['package-lock.json', 'yarn.lock'].find((f) => has(w.path, f));
  const workspaces = !!JSON.parse(fs.readFileSync(path.join(w.path, 'package.json'), 'utf8')).workspaces; // nested node_modules: install instead
  const same = lock && !workspaces && has(w.repoPath, 'node_modules') && has(w.repoPath, lock) &&
    fs.readFileSync(path.join(w.path, lock)).equals(fs.readFileSync(path.join(w.repoPath, lock)));
  if (same) {
    try { // copy-on-write clone: near-instant, no extra disk until a file changes. Never a symlink into the main checkout.
      execFileSync('cp', [process.platform === 'darwin' ? '-cR' : '-R', ...(process.platform === 'darwin' ? [] : ['--reflink=auto']), path.join(w.repoPath, 'node_modules'), path.join(w.path, 'node_modules')], { stdio: 'pipe' });
      return 'node_modules cloned copy-on-write from the main checkout (same lockfile)';
    } catch { fs.rmSync(path.join(w.path, 'node_modules'), { recursive: true, force: true }); /* no CoW here: install below */ }
  }
  if (lock === 'yarn.lock') sh('yarn', ['install', '--frozen-lockfile', '--prefer-offline']);
  else sh('npm', [lock ? 'ci' : 'install', '--prefer-offline', '--no-audit', '--no-fund']);
  return `${lock === 'yarn.lock' ? 'yarn' : 'npm'} install (offline cache first)`;
}

export function openPRs(repo) {
  const [o, n] = repo.split('/');
  const q = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){defaultBranchRef{name} pullRequests(states:OPEN,first:100){nodes{number url title headRefName authorAssociation author{login} closingIssuesReferences(first:20){nodes{number}}}} done: pullRequests(states:[MERGED,CLOSED],last:100){nodes{headRefName}}}}';
  const r = JSON.parse(gh('api', 'graphql', '-f', `query=${q}`, '-f', `o=${o}`, '-f', `n=${n}`)).data.repository;
  return { base: r.defaultBranchRef.name, prs: r.pullRequests.nodes, doneBranches: (r.done?.nodes || []).map((x) => x.headRefName) };
}

// branch -> { agents, last } from local Claude Code and Codex logs. Reads branch names and file times only, never prompt text.
export function sessionsByBranch(repo, repoPath) {
  const out = {};
  const add = (branch, agent, ts, id, cwd) => {
    if (!branch || branch === 'HEAD') return;
    const s = (out[branch] ??= { agents: [], last: '', sessions: [] });
    if (!s.agents.includes(agent)) s.agents.push(agent);
    if (ts > s.last) s.last = ts;
    if (id && !s.sessions.some((x) => x.id === id)) s.sessions.push({ agent, id, cwd, last: ts });
  };
  const mtime = (f) => fs.statSync(f).mtime.toISOString();
  const claude = path.join(os.homedir(), '.claude', 'projects');
  const prefix = repoPath.replace(/[^a-zA-Z0-9]/g, '-'); // Claude Code's project-folder naming
  for (const d of ls(claude).filter((d) => d === prefix || d.startsWith(prefix + '-'))) {
    for (const f of ls(path.join(claude, d)).filter((f) => f.endsWith('.jsonl'))) {
      const file = path.join(claude, d, f);
      const text = fs.readFileSync(file, 'utf8');
      const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1]; // first cwd = where the session was started
      for (const b of new Set([...text.matchAll(/"gitBranch":"([^"]*)"/g)].map((m) => m[1]))) add(b, 'claude-code', mtime(file), f.slice(0, -6), cwd);
    }
  }
  const codex = path.join(os.homedir(), '.codex', 'sessions');
  const sameRepo = new RegExp(`[:/]${repo.replace(/[.]/g, '\\.')}(\\.git)?$`, 'i');
  for (const f of ls(codex).length ? fs.readdirSync(codex, { recursive: true }) : []) {
    if (!String(f).endsWith('.jsonl')) continue;
    const file = path.join(codex, String(f));
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const first = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8').split('\n')[0];
    fs.closeSync(fd);
    try {
      const meta = JSON.parse(first).payload;
      const g = meta?.git;
      if (g && sameRepo.test(g.repository_url || '')) add(g.branch, 'codex', mtime(file), meta.id, meta.cwd);
    } catch { /* first line cut off or not session_meta: skip */ }
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'dist', 'build', 'vendor']);
const DISCOVER_ROOTS = ['Development', 'code', 'Code', 'projects', 'Projects', 'src', 'dev', 'repos', 'workspace', 'git', 'GitHub'];

// Finds local clones with a GitHub origin, for onboarding. Reads .git/config directly (no subprocess per folder);
// skips hidden folders and node_modules.
export function discover(roots, maxDepth = 5) {
  roots = roots?.length ? roots.map((r) => path.resolve(r)) : DISCOVER_ROOTS.map((d) => path.join(os.homedir(), d)).filter((d) => fs.existsSync(d));
  const clones = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dotGit = entries.find((e) => e.name === '.git');
    if (dotGit?.isDirectory()) clones.push(dir); // keep descending: clones can live inside another repo (a .git *file* is a linked worktree, counted under its clone)
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  const byRepo = {};
  for (const dir of clones) {
    let config;
    try { config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'); } catch { continue; }
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] || '';
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
    if (!m) continue;
    let lastCommit = null;
    try { lastCommit = git('-C', dir, 'log', '-1', '--format=%cI').trim() || null; } catch { /* empty repo */ }
    const worktrees = ls(path.join(dir, '.git', 'worktrees')).length;
    (byRepo[`${m[1]}/${m[2]}`] ??= []).push({ path: dir, lastCommit, worktrees });
  }
  const attached = projects();
  return Object.entries(byRepo).map(([repo, cs]) => {
    cs.sort((a, b) => (b.lastCommit || '').localeCompare(a.lastCommit || ''));
    const main = cs.find((c) => c.path === attached[repo]?.path) || cs[0]; // prefer the clone already attached, else the freshest
    return { repo, path: main.path, otherClones: cs.filter((c) => c !== main).map((c) => c.path), attached: !!attached[repo], lastCommit: main.lastCommit, worktrees: main.worktrees };
  }).sort((a, b) => (b.lastCommit || '').localeCompare(a.lastCommit || ''));
}

// Registers the repo and imports work already in flight: open PRs, plus recent agent sessions on unmerged branches.
// Imported runs are tracked, never driven: decide() always escalates them.
export function sync(repo, repoPath) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error(`repo must look like owner/repo, got "${repo}"`);
  repoPath = path.resolve(repoPath || projects()[repo]?.path || '.');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { path: repoPath, synced: new Date().toISOString() } }, null, 2));
  const runs = Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') || r.id.startsWith(repo + ':'));
  const byPr = new Map(runs.filter((r) => r.pr).map((r) => [r.pr, r]));
  const byBranch = new Map(runs.filter((r) => r.branch).map((r) => [r.branch, r]));
  const { base, prs, doneBranches } = openPRs(repo);
  const sessions = sessionsByBranch(repo, repoPath);
  const ours = (b) => b.startsWith('factory/'); // the factory's own branches are never imported
  const added = [], attached = [], closed = [];
  const importRun = (id, meta, summary) => {
    record(id, 'intake', 'started', { ...meta, imported: true });
    record(id, 'intake', 'passed', { summary });
  };
  for (const p of prs) {
    if (byPr.has(p.url) || ours(p.headRefName)) continue;
    const prior = byBranch.get(p.headRefName);
    if (prior) { // a session-only run whose branch now has a PR
      if (!prior.pr && prior.outcome === 'in-progress') { record(prior.id, 'build', 'passed', { pr: p.url }); attached.push(prior.id); }
      continue;
    }
    const s = sessions[p.headRefName];
    const source = s ? s.agents.join('+') : 'none';
    const id = `${repo}#${p.number}`; // PRs and issues share GitHub's number space
    importRun(id, { title: p.title, url: p.url, author: p.author?.login, association: p.authorAssociation, source, issues: p.closingIssuesReferences.nodes.map((x) => x.number) },
      `Imported open PR${s ? ` from a ${source} session` : ' (no local session found)'}; not built by the factory.`);
    record(id, 'build', 'started');
    record(id, 'build', 'passed', { pr: p.url, branch: p.headRefName });
    added.push(id);
  }
  // shortcut: only local branches count as session work; a session on a remote-only branch is skipped until it has a PR.
  const unmerged = new Set(git('-C', repoPath, 'branch', '--no-merged', `origin/${base}`, '--format=%(refname:short)').split('\n').map((b) => b.trim()).filter(Boolean));
  const openHeads = new Set(prs.map((p) => p.headRefName));
  const done = new Set(doneBranches); // squash-merged branches still look unmerged to git
  const recent = new Date(Date.now() - 14 * 864e5).toISOString();
  for (const [branch, s] of Object.entries(sessions)) {
    if (ours(branch) || openHeads.has(branch) || done.has(branch) || byBranch.has(branch) || !unmerged.has(branch) || s.last < recent) continue;
    const id = `${repo}:${branch}`;
    importRun(id, { title: branch, source: s.agents.join('+') }, `Imported ${s.agents.join('+')} session on an unmerged branch with no PR yet.`);
    record(id, 'build', 'started', { branch });
    added.push(id);
  }
  // In-progress runs whose work ended outside the factory become "closed": a merge elsewhere is not a factory merge.
  const open = new Set(prs.map((p) => p.url));
  for (const r of runs) {
    if (r.outcome !== 'in-progress' || attached.includes(r.id)) continue;
    let reason;
    if (r.pr && !open.has(r.pr)) {
      const { state } = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'state'));
      if (state !== 'OPEN') reason = `PR ${state.toLowerCase()} outside the factory`;
    } else if (!r.pr && r.imported && r.branch && !openHeads.has(r.branch) && (done.has(r.branch) || !unmerged.has(r.branch))) {
      reason = `branch ${r.branch} was merged, closed or deleted`;
    }
    if (reason) { record(r.id, 'approve', 'closed', { reasons: [reason] }); closed.push(r.id); }
  }
  const links = sessionsFile();
  const prev = fs.existsSync(links) ? JSON.parse(fs.readFileSync(links, 'utf8')) : {};
  for (const r of Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') || r.id.startsWith(repo + ':'))) {
    if (r.branch && sessions[r.branch]) prev[r.id] = sessions[r.branch].sessions.sort((a, b) => b.last.localeCompare(a.last)).slice(0, 5);
  }
  fs.writeFileSync(links, JSON.stringify(prev, null, 2));
  render();
  return { repo, path: repoPath, added, attached, closed };
}

// Reads CI + diff facts from GitHub so the merge decision never depends on typed-in numbers.
export function facts(r) {
  const { repo, n } = parseRun(r.id);
  const association = gh('api', `repos/${repo}/issues/${n}`, '--jq', '.author_association').trim();
  const autoMerge = projects()[repo]?.autoMerge !== false;
  const policy = rules(repo).policy; // a broken config throws here, so decide/merge fail and the run escalates
  if (!r.pr) return { association, autoMerge, checks: 'none', additions: 0, deletions: 0, files: [], rules: policy };
  const diff = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'additions,deletions,files'));
  let checks = 'skipped'; // ci=skip: GitHub CI isn't even read
  if (policy.ci?.value !== 'skip') try {
    const b = JSON.parse(gh('pr', 'checks', r.pr, '-R', repo, '--json', 'bucket')).map((c) => c.bucket);
    checks = !b.length ? 'none' : b.some((x) => x === 'fail' || x === 'cancel') ? 'fail' : b.includes('pending') ? 'pending' : 'pass';
  } catch (e) {
    if (!/no checks reported/i.test(String(e.stderr))) throw e;
    checks = 'none';
  }
  return { association, autoMerge, checks, additions: diff.additions, deletions: diff.deletions, files: diff.files.map((f) => f.path), rules: policy };
}

// Stand-in for CI that F runs itself: the checks.commands rule (never repo or model text) in the run's worktree, on a clean commit.
// Records an owned build event with exit codes only; output goes to a file and its tail is printed.
// shortcut: weaker than CI. It runs in the worktree the builder prepared, with the user's environment, and the clean-tree
// check can't see ignored files (node_modules, .git/info/exclude), so a tampered node_modules/.bin would pass. Upgrade
// to a fresh clone of the reviewed sha plus a clean install if rules ever stand in for CI on untrusted code.
export function localChecks(run) {
  const { repo } = parseRun(run), w = wtInfo(run);
  if (!w || !fs.existsSync(w.path)) throw new Error(`no worktree for ${run}; run "worktree" first`);
  const cmds = rules(repo).policy['checks.commands']?.value;
  if (!cmds) throw new Error(`no checks.commands rule for ${repo}; the user can set one: rules set ${repo} checks.commands '["pnpm test"]' --reason "…"`);
  if (git('-C', w.path, 'status', '--porcelain').trim()) throw new Error('the worktree has uncommitted changes; commit first, so the checks cover the commit that gets reviewed');
  const sha = git('-C', w.path, 'rev-parse', 'HEAD').trim();
  const file = path.join(runDir(run), 'local-checks.log'), fd = fs.openSync(file, 'w'), commands = [];
  try {
    for (const cmd of cmds) {
      fs.writeSync(fd, `$ ${cmd}\n`);
      const t = Date.now();
      let exit = 0;
      try { execFileSync('/bin/sh', ['-c', cmd], { cwd: w.path, env: { ...process.env, CI: '1' }, stdio: ['ignore', fd, fd], timeout: 30 * 60e3 }); } // to a file: no maxBuffer limit
      catch (e) { exit = e.status ?? (e.signal ? 'timeout' : 1); }
      commands.push({ cmd, exit, ms: Date.now() - t });
    }
  } finally { fs.closeSync(fd); }
  const state = commands.every((c) => c.exit === 0) ? 'pass' : 'fail';
  record(run, 'build', state === 'pass' ? 'passed' : 'failed', { localChecks: { state, sha, commands } });
  const tail = state === 'fail' ? fs.readFileSync(file, 'utf8').split('\n').slice(-60).join('\n') : undefined;
  return { state, sha, commands, log: file, ...(tail && { tail }) };
}

// The only merge path: re-decides from live GitHub facts and merges exactly the reviewed commit.
export function merge(run) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  const f = r.imported ? {} : facts(r);
  const d = decide(r, f);
  record(run, 'approve', 'decided', { ...d, facts: f });
  if (d.action !== 'merge') return { merged: false, ...d };
  if (!r.reviewedSha) throw new Error('no reviewed commit recorded; refusing to merge');
  gh('pr', 'ready', r.pr, '-R', repo);
  gh('pr', 'merge', r.pr, '-R', repo, '--squash', '--delete-branch', '--match-head-commit', r.reviewedSha);
  record(run, 'approve', 'merged');
  try { gh('issue', 'edit', n, '-R', repo, '--remove-label', 'factory:in-progress', '--add-label', 'factory:merged'); } catch { /* label is cosmetic */ }
  return { merged: true, ...d };
}

// Spec approval: a trusted "/factory approve" (or "/factory reject") comment after the run started waiting.
export function approval(run) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  const since = [...r.events].reverse().find((e) => e.status === 'awaiting-approval')?.ts;
  if (!since) throw new Error(`${run} is not awaiting approval`);
  const comments = gh('api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[]').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const vote = comments.filter((c) => c.created_at > since && TRUSTED.includes(c.author_association))
    .map((c) => ({ by: c.user.login, m: /^\s*\/factory\s+(approve|reject)\b/i.exec(c.body || '') })).filter((x) => x.m).pop();
  return vote ? { decision: vote.m[1].toLowerCase(), by: vote.by } : { decision: 'waiting' };
}

// After a merge: CI on the merge commit of the base branch.
export function postmerge(run) {
  const r = getRun(run);
  const { repo } = parseRun(run);
  const sha = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'mergeCommit')).mergeCommit?.oid;
  if (!sha) return { state: 'not-merged' };
  const ci = rules(repo).policy.ci?.value;
  if (ci === 'skip') return { sha, state: 'skipped', reason: 'rule ci=skip: CI on the base branch is not watched, so it never triggers a revert' };
  const runs = JSON.parse(gh('run', 'list', '-R', repo, '--commit', sha, '--json', 'status,conclusion,name,url'));
  const failed = runs.filter((x) => ['failure', 'cancelled', 'timed_out'].includes(x.conclusion)).map((x) => x.url);
  const state = !runs.length ? 'none' : failed.length ? 'fail' : runs.some((x) => x.status !== 'completed') ? 'pending' : 'pass';
  return { sha, state, failed, ...(ci === 'advisory' && { advisory: true }) }; // advisory: report red, don't revert on it
}

// Opens (never merges) a revert PR for a merged run whose main CI went red.
export function revert(run, reason) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  const pm = postmerge(run);
  if (!pm.sha) throw new Error('run has no merge commit');
  const repoPath = projects()[repo]?.path;
  if (!repoPath) throw new Error(`no local clone registered for ${repo}`);
  const base = gh('repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name').trim();
  const branch = `factory/revert-${n}`, wt = path.join(runDir(run), 'revert');
  git('-C', repoPath, 'fetch', '-q', 'origin', base);
  git('-C', repoPath, 'worktree', 'add', '-q', '-B', branch, wt, `origin/${base}`);
  try {
    git('-C', wt, 'revert', '--no-edit', pm.sha);
    git('-C', wt, 'push', '-q', '-u', 'origin', branch);
    const url = gh('pr', 'create', '-R', repo, '--base', base, '--head', branch, '--title', `Revert: ${r.title}`,
      '--body', `Reverts ${r.pr} (#${n}): ${reason}\n\nOpened by the software factory. Needs a human to merge.`, '--label', 'factory:needs-human').trim();
    record(run, 'approve', 'reverted', { pr: url, reason });
    return { pr: url };
  } finally {
    try { git('-C', repoPath, 'worktree', 'remove', '--force', wt); git('-C', repoPath, 'branch', '-D', branch); } catch { /* best effort */ }
  }
}

// Work queue for scheduled/triage runs: ready issues not yet in the log, and untriaged open issues.
export function queue(repo) {
  const known = new Set(Object.keys(derive(read())));
  const list = (...a) => JSON.parse(gh('issue', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,labels', ...a));
  const fresh = (i) => !known.has(`${repo}#${i.number}`);
  return {
    ready: list('--label', 'factory:ready').filter(fresh).map((i) => ({ run: `${repo}#${i.number}`, title: i.title })),
    untriaged: list().filter((i) => fresh(i) && !i.labels.some((l) => l.name.startsWith('factory:'))).map((i) => ({ run: `${repo}#${i.number}`, title: i.title })),
  };
}

const archiveFile = () => path.join(DIR, 'archive.jsonl');
const sessionsFile = () => path.join(DIR, 'sessions.json');
const readArchive = () => { try { return fs.readFileSync(archiveFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// Moves finished runs older than `days` out of the live log into compact summaries, so derive/render stay fast.
export function archive(days = 14) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const events = read();
  const runs = derive(events);
  const old = Object.values(runs).filter((r) => TERMINAL.includes(r.outcome) && r.updated < cutoff && !wtInfo(r.id));
  if (!old.length) return { archived: 0 };
  const ids = new Set(old.map((r) => r.id));
  fs.appendFileSync(archiveFile(), old.map((r) => JSON.stringify({ ...r, events: r.events.slice(-5), archived: true })).join('\n') + '\n');
  const tmp = log() + '.tmp'; // write-then-rename so a crash never leaves a half log
  fs.writeFileSync(tmp, events.filter((e) => !ids.has(e.run)).map((e) => JSON.stringify(e)).join('\n') + (events.length > ids.size ? '\n' : ''));
  fs.copyFileSync(log(), log() + '.bak');
  fs.renameSync(tmp, log());
  render();
  return { archived: old.length };
}

// Runs intake on each golden fixture with a headless Claude session (costs tokens; user-triggered) and scores the outcome.
export function evals(only) {
  const dir = path.join(HERE, 'evals', 'golden');
  const ids = ls(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((n) => !only || n === only).sort((a, b) => a - b);
  const results = [];
  for (const n of ids) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-eval-'));
    const run = `eval/golden#${n}`;
    try {
      execFileSync('claude', ['-p', `/software-factory ${run} --dry-run --intake-only`, '--allowedTools', 'Bash(node:*)', 'Read', 'Grep', 'Glob'],
        { env: { ...process.env, FACTORY_DIR: tmp, FACTORY_FIXTURES: dir }, stdio: 'ignore', timeout: 600_000 });
    } catch { /* scored below from whatever was recorded */ }
    const prevDir = DIR; DIR = tmp;
    const r = derive(read())[run];
    DIR = prevDir;
    const last = r?.events.filter((e) => e.stage === 'intake' || e.status === 'split').pop()?.status;
    const got = { passed: 'pass', 'needs-info': 'needs-info', rejected: 'reject', split: 'split' }[last] || 'no-outcome';
    results.push({ fixture: n, expect: fx.expect, got, ok: got === fx.expect });
  }
  return { score: `${results.filter((r) => r.ok).length}/${results.length}`, results };
}

export function metrics(runs) {
  const count = (o) => runs.filter((r) => r.outcome === o).length;
  const merged = count('merged'), escalated = count('escalated');
  const built = runs.filter((r) => !r.imported && ['merged', 'escalated'].includes(r.outcome));
  const cycles = built.map((r) => r.durationMs).sort((a, b) => a - b);
  const reverts = runs.filter((r) => r.reverted).length;
  const costUsd = +runs.reduce((s, r) => s + (r.costUsd || 0), 0).toFixed(2);
  return {
    runs: runs.length, inProgress: count('in-progress'), merged, escalated, rejected: count('rejected'), needsInfo: count('needs-info'),
    closed: count('closed'), awaitingApproval: count('awaiting-approval'), split: count('split'),
    mergeRate: merged + escalated ? +(merged / (merged + escalated)).toFixed(3) : null,
    avgIterations: built.length ? +(built.reduce((s, r) => s + r.iteration, 0) / built.length).toFixed(2) : null,
    medianCycleMs: cycles.length ? cycles[Math.floor(cycles.length / 2)] : null,
    reverts, revertRate: merged ? +(reverts / merged).toFixed(3) : null,
    costUsd, costPerMergeUsd: merged ? +(costUsd / merged).toFixed(2) : null,
  };
}

export function render() {
  const live = Object.values(derive(read()));
  const archived = readArchive().filter((a) => !live.some((r) => r.id === a.id));
  for (const a of archived) for (const c of a.children || []) { const child = live.find((r) => r.id === c); if (child) child.parent = a.id; }
  const runs = [...live, ...archived].sort((a, b) => b.updated.localeCompare(a.updated));
  let links = {};
  try { links = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')); } catch { /* no sync yet */ }
  for (const r of runs) if (links[r.id]) r.sessions = [...(r.sessions || []), ...links[r.id].filter((x) => !(r.sessions || []).some((y) => y.id === x.id))];
  const repoOf = (id) => id.split(/[#:]/)[0];
  const byProject = {};
  for (const p of new Set(runs.map((r) => repoOf(r.id)))) byProject[p] = metrics(runs.filter((r) => repoOf(r.id) === p));
  const ruleData = { rules: {}, ruleHistory: read().filter((e) => e.stage === 'rules').slice(-100) };
  try { const cfg = readSkills(); for (const p of new Set([...Object.keys(byProject), ...Object.keys(projects())])) ruleData.rules[p] = rules(p, cfg); }
  catch (e) { ruleData.rulesError = e.message; } // render runs after every record(): a bad config must not half-fail the event
  const data = JSON.stringify({ generated: new Date().toISOString(), cap: CAP, costCap: COST_CAP, projects: Object.keys(projects()), metrics: { all: metrics(runs), byProject }, runs, ...ruleData }).replace(/</g, '\\u003c');
  const html = fs.readFileSync(path.join(HERE, 'dashboard.html'), 'utf8').replace('__FACTORY_DATA__', () => data);
  fs.mkdirSync(DIR, { recursive: true });
  const out = path.join(DIR, 'dashboard.html');
  fs.writeFileSync(out, html);
  return out;
}

// Fixture runs covering every outcome; used by `demo` and `test`.
export function demo() {
  let t = Date.parse('2026-11-20T09:00:00Z');
  const ev = (run, stage, status, p = {}) => {
    const e = { ts: new Date((t += 97_000)).toISOString(), ...p, run, stage, status };
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(log(), JSON.stringify(e) + '\n');
  };
  const intake = (run, title, n, association = 'OWNER') =>
    ev(run, 'intake', 'started', { title, url: `https://github.com/acme/shop/issues/${n}`, author: association === 'OWNER' ? 'acme' : 'drive-by', association });
  const pass = (run, axes) => axes.forEach((axis) => ev(run, 'review', 'passed', { axis, findings: [] }));
  const g = (run, extra) => { const { status, ...p } = gate(getRun(run)); ev(run, 'gate', status, { ...p, ...extra }); };
  const d = (run, facts) => { const x = decide(getRun(run), facts); ev(run, 'approve', 'decided', x); return x; };

  let R = 'acme/shop#41';
  intake(R, 'Make the site support crypto payments', 41, 'NONE');
  ev(R, 'intake', 'rejected', { reason: 'Out of scope: the roadmap excludes payment providers and the issue has no user need behind it.' });

  R = 'acme/shop#42';
  intake(R, 'Search is slow', 42);
  ev(R, 'intake', 'needs-info', { questions: ['Which page: product search or admin search?', 'Roughly how slow, and on what data size?'] });

  R = 'acme/shop#43';
  intake(R, 'Add newsletter signup to footer', 43);
  ev(R, 'intake', 'passed', { summary: 'Worth building: small, clear value, fits existing Subscribe component.' });
  ev(R, 'spec', 'passed', { spec: 'Footer form reusing Subscribe; inline success/error; no new deps.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/90', branch: 'factory/issue-43' });
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'] });
  pass(R, ['code', 'security', 'seo']);
  ev(R, 'review', 'failed', { axis: 'ux', tokens: 41000, costUsd: 0.31, findings: [{ severity: 'high', file: 'components/Footer.tsx', issue: 'Spec never says what happens for an already-subscribed email.', route: 'spec' }] });
  ev(R, 'review', 'passed', { axis: 'ui', findings: [] });
  g(R);
  ev(R, 'spec', 'passed', { spec: 'Adds: already-subscribed shows a neutral "You are on the list" message.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed');
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'] });
  pass(R, ['code', 'ux', 'ui', 'seo']);
  ev(R, 'review', 'failed', { axis: 'security', tokens: 52000, costUsd: 0.44, findings: [
    { severity: 'medium', file: 'app/api/subscribe/route.ts', issue: 'Email is not validated server-side.', route: 'build' },
    { severity: 'high', file: 'app/api/subscribe/route.ts', issue: 'Possible SSRF via webhook URL.', route: 'build', dismissed: 'No outbound request uses user input; the URL is a constant in lib/mail.ts:8.' }] });
  g(R);
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed');
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'] });
  pass(R, ['code', 'security', 'ux', 'ui', 'seo']);
  g(R);
  d(R, { checks: 'pass', additions: 84, deletions: 6, files: ['components/Footer.tsx', 'app/api/subscribe/route.ts', 'components/Footer.test.tsx'] });
  ev(R, 'approve', 'merged');
  ev(R, 'approve', 'reverted', { pr: 'https://github.com/acme/shop/pull/93', reason: 'main CI: e2e footer test failed after merge' });

  R = 'acme/shop#46';
  intake(R, 'Epic: accounts', 46);
  ev(R, 'intake', 'split', { children: ['acme/shop#47', 'acme/shop#48'] });
  intake('acme/shop#47', 'Sign up with email', 47);
  intake('acme/shop#48', 'Password reset by email', 48);

  R = 'acme/shop#49';
  intake(R, 'Add Stripe checkout', 49, 'CONTRIBUTOR');
  ev(R, 'intake', 'passed', { summary: 'Clear, but touches payments.' });
  ev(R, 'spec', 'awaiting-approval', { spec: 'Checkout via existing payments module.', reasons: ['author association "CONTRIBUTOR" is not trusted', 'plans to touch sensitive paths: lib/payments/checkout.ts'] });

  R = 'acme/shop#44';
  intake(R, 'Let users log in with GitHub', 44);
  ev(R, 'intake', 'passed', { summary: 'Clear request from the owner.' });
  ev(R, 'spec', 'passed', { spec: 'OAuth via existing auth lib, GitHub provider only.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/91', branch: 'factory/issue-44' });
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui'] });
  pass(R, ['code', 'security', 'ux', 'ui']);
  g(R);
  d(R, { checks: 'pass', additions: 140, deletions: 12, files: ['lib/auth/github.ts', 'package.json'] });
  ev(R, 'approve', 'escalated');

  R = 'acme/shop#45';
  intake(R, 'Fix typo on pricing page', 45);
  ev(R, 'intake', 'passed', { summary: 'Trivial, clearly worth it.' });
  ev(R, 'spec', 'passed', { spec: 'Correct "recieve" to "receive" in pricing copy.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/92', branch: 'factory/issue-45' });
  ev(R, 'review', 'started', { axes: ['code', 'security', 'ux', 'ui', 'seo'] });
  pass(R, ['code', 'security']);

  // Custom and provider runners: what `skills set` would make F stamp on each event.
  R = 'acme/shop#50';
  const who = { spec: { use: 'skill', name: 'my-planner' }, build: { use: 'provider', harness: 'codex' }, verifier: { use: 'provider', harness: 'claude-code', name: 'pr-review-toolkit:code-reviewer' },
    code: { use: 'provider', harness: 'claude-code', name: 'code-review' }, ui: { use: 'skill', name: 'brand-review' }, a11y: { use: 'brief', path: '~/.claude/factory/briefs/a11y.md' } };
  const files = ['components/SizePicker.tsx', 'components/SizePicker.test.tsx'];
  const axes50 = axesFor(files, [{ axis: 'a11y', when: ['**/*.tsx'] }]);
  const review = (axis, text) => { const { status, payload } = reviewFromText(R, axis, text); ev(R, 'review', status, { ...payload, ...(who[axis] && { runner: who[axis] }) }); };
  const ok = (axis) => review(axis, JSON.stringify({ axis, verdict: 'passed', findings: [] }));
  intake(R, 'Add an accessible size picker to the product page', 50);
  ev(R, 'intake', 'passed', { summary: 'Clear and small: a radio-group picker replacing the select.' });
  ev(R, 'spec', 'passed', { spec: 'Radio-group size picker with keyboard support; reuses Button tokens.', runner: who.spec });
  ev(R, 'build', 'started', { runner: who.build });
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/94', branch: 'factory/issue-50', runner: who.build });
  ev(R, 'review', 'started', { axes: axes50 });
  axes50.filter((a) => a !== 'a11y').forEach(ok);
  review('a11y', 'Looks accessible to me. Ship it!'); // prose instead of the JSON contract
  g(R, { runner: who.verifier });
  ev(R, 'build', 'started', { runner: who.build });
  ev(R, 'build', 'passed', { runner: who.build });
  ev(R, 'review', 'started', { axes: axes50 });
  axes50.filter((a) => a !== 'a11y').forEach(ok);
  review('a11y', JSON.stringify({ axis: 'a11y', verdict: 'passed', findings: [{ severity: 'low', file: 'components/SizePicker.tsx', line: 31, issue: 'Focus ring uses the default outline instead of the focus token.', route: 'build' }] }));
  g(R, { runner: who.verifier });
  d(R, { checks: 'pass', additions: 96, deletions: 14, files });
  ev(R, 'approve', 'merged');

  // A billing rule: GitHub Actions can't run for acme/shop, so CI is skipped and F's own local checks stand in for it.
  // Only acme/shop's entry in skills.json is touched, in case FACTORY_DIR points at a real config.
  const cfg = readSkills(), rule = (value, reason, until) => ({ value, reason, setBy: 'acme', setAt: new Date(t).toISOString(), ...(until && { until }) });
  cfg['acme/shop'] = { ...cfg['acme/shop'], rules: {
    ci: rule('skip', 'GitHub Actions billing is failing', dayOf(Date.now() + 30 * 864e5)),
    'checks.commands': rule(['pnpm test', 'pnpm lint'], 'stands in for CI while Actions is off'),
    diffCap: rule(150, 'release freeze', dayOf(Date.now() - 864e5)), // expired: shows the warning
  } };
  cfg['acme/shop'].rules['checks.commands'].until = dayOf(Date.now() + 2 * 864e5); // ending soon: shows the warning
  cfg['acme/shop'].guide = { build: 'use pnpm, never npm' };
  writeSkills(cfg);
  ev('acme/shop', 'rules', 'set', { key: 'ci', value: 'advisory', reason: 'Actions runners are flaky', setBy: 'acme' });
  for (const [key, { setAt: _s, ...x }] of Object.entries(cfg['acme/shop'].rules)) ev('acme/shop', 'rules', 'set', { key, ...x });
  ev('acme/shop', 'rules', 'set', { key: 'guide.build', value: 'use pnpm, never npm', setBy: 'acme' });
  R = 'acme/shop#51';
  const sha = '5e1f0c2a9d3b', files51 = ['components/CartTotal.tsx', 'components/CartTotal.test.tsx'], axes51 = axesFor(files51);
  intake(R, 'Show a delivery estimate under the cart total', 51);
  ev(R, 'intake', 'passed', { summary: 'Small and clear: one line under the cart total.' });
  ev(R, 'spec', 'passed', { spec: 'Delivery estimate from the existing shipping helper; no new deps.' });
  ev(R, 'build', 'started');
  ev(R, 'build', 'passed', { localChecks: { state: 'pass', sha, commands: [{ cmd: 'pnpm test', exit: 0, ms: 48210 }, { cmd: 'pnpm lint', exit: 0, ms: 9120 }] } });
  ev(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/95', branch: 'factory/issue-51' });
  ev(R, 'review', 'started', { axes: axes51, sha });
  pass(R, axes51);
  g(R);
  d(R, { checks: 'skipped', additions: 58, deletions: 4, files: files51, rules: rules('acme/shop').policy });
  ev(R, 'approve', 'merged');
  return render();
}

function test() {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  demo();
  const runs = derive(read());
  assert.equal(runs['acme/shop#41'].outcome, 'rejected');
  assert.equal(runs['acme/shop#42'].outcome, 'needs-info');
  const loop = runs['acme/shop#43'];
  assert.equal(loop.outcome, 'merged');
  assert.equal(loop.iteration, 3);
  assert.deepEqual(loop.loopbacks.map((l) => l.route), ['spec', 'build']);
  assert.equal(loop.decision.action, 'merge');
  assert.equal(runs['acme/shop#44'].decision.action, 'escalate');
  assert.match(runs['acme/shop#44'].decision.reasons.join(), /sensitive paths/);
  assert.equal(runs['acme/shop#45'].outcome, 'in-progress');
  assert.throws(() => gate(runs['acme/shop#45']), /missing review verdicts: ux, ui, seo/);
  // Cap: a failing review at the cap goes to approve, never another loop.
  const capped = { iteration: CAP, axes: { [CAP]: ['code'] }, reviews: { [CAP]: { code: { verdict: 'failed', findings: [{ route: 'build' }] } } } };
  assert.equal(gate(capped).next, 'approve');
  // Untrusted author, red CI, big diff each force escalation.
  const ok = { association: 'OWNER', iteration: 1, pr: 'x', axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'passed' } } } };
  const facts = { checks: 'pass', additions: 10, deletions: 0, files: ['src/a.ts', 'src/a.test.ts'] };
  assert.equal(decide(ok, facts).action, 'merge');
  assert.equal(decide({ ...ok, association: 'CONTRIBUTOR' }, facts).action, 'escalate');
  assert.equal(decide(ok, { ...facts, checks: 'none' }).action, 'escalate');
  assert.equal(decide(ok, { ...facts, additions: 400 }).action, 'escalate');
  assert.equal(decide(ok, { ...facts, files: ['.github/workflows/ci.yml'] }).action, 'escalate');
  assert.match(decide(ok, { ...facts, files: ['src/a.ts'] }).reasons.join(), /no test change/);
  assert.equal(decide(ok, { ...facts, files: ['README.md'] }).action, 'merge'); // docs-only needs no test
  assert.match(decide({ ...ok, costUsd: 9 }, facts).reasons.join(), /budget/);
  assert.match(decide({ ...ok, tokens: 4e6 }, facts).reasons.join(), /budget/);
  assert.match(decide({ ...ok, origin: 'x#1', originAssociation: 'NONE' }, facts).reasons.join(), /split from x#1/);
  assert.match(decide(ok, { ...facts, association: 'NONE' }).reasons.join(), /not trusted/); // live value wins
  assert.match(decide(ok, { ...facts, autoMerge: false }).reasons.join(), /auto-merge is turned off/);
  assert.match(decide(ok, { ...facts, files: ['.claude/skills/review/SKILL.md', 'src/a.test.ts'] }).reasons.join(), /sensitive paths/); // a branch's own agent config
  // Demo run 50: custom/provider runners are stamped, and prose from a custom reviewer fails the axis instead of passing.
  const r50 = runs['acme/shop#50'];
  assert.equal(r50.outcome, 'merged');
  assert.deepEqual(r50.runners, { spec: { use: 'skill', name: 'my-planner' }, build: { use: 'provider', harness: 'codex' }, gate: { use: 'provider', harness: 'claude-code', name: 'pr-review-toolkit:code-reviewer' } });
  assert.match(r50.reviews[1].a11y.findings[0].issue, /^reviewer output invalid/);
  assert.equal(r50.reviews[1].a11y.verdict, 'failed');
  assert.equal(r50.reviews[2].ui.runner.name, 'brand-review');
  // Demo run 51: merged under ci=skip because F's local checks passed on the reviewed commit; the reason names the rule.
  assert.equal(runs['acme/shop#51'].decision.action, 'merge');
  assert.match(runs['acme/shop#51'].decision.reasons.join(' | '), /CI not required by rule ci=skip, set by acme on 2026-11-20: GitHub Actions billing is failing\. Local checks: pass \(pnpm test, pnpm lint\)/);
  assert.equal(runs['acme/shop'], undefined); // rule events are not runs
  assert.deepEqual(rules('acme/shop').expired.map((x) => x.key), ['diffCap']);
  // Verifier-dismissed findings don't block; the cost cap stops looping.
  const dis = { iteration: 1, axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'passed', findings: [{ severity: 'high', route: 'build', dismissed: 'not reachable' }] } } } };
  assert.equal(gate(dis).next, 'approve');
  const pricey = { iteration: 1, costUsd: 6, axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'failed', findings: [{ severity: 'high', route: 'build' }] } } } };
  assert.equal(gate(pricey).next, 'approve');
  assert.deepEqual(risk({ association: 'OWNER' }, ['src/a.ts']), { risky: false, reasons: [] });
  assert.ok(risk({ association: 'NONE' }, ['lib/auth/x.ts']).reasons.length === 2);
  assert.deepEqual(axesFor(['app/api/x/route.ts']), ['code', 'security', 'docs']);
  // Eval fixtures are served offline, without GitHub.
  process.env.FACTORY_FIXTURES = path.join(HERE, 'evals', 'golden');
  assert.equal(intake('eval/golden#4').association, 'NONE');
  delete process.env.FACTORY_FIXTURES;
  // Archive moves finished runs out of the live log; the dashboard and metrics still include them.
  // Before archiving: the new states derive correctly.
  const pre = derive(read());
  assert.deepEqual(pre['acme/shop#47'].parent, 'acme/shop#46');
  assert.equal(pre['acme/shop#49'].outcome, 'awaiting-approval');
  assert.equal(pre['acme/shop#43'].reverted.pr, 'https://github.com/acme/shop/pull/93');
  assert.equal(pre['acme/shop#43'].pr, 'https://github.com/acme/shop/pull/90');
  assert.equal(pre['acme/shop#43'].tokens, 93000);
  assert.deepEqual(archive(0), { archived: 6 }); // 41 rejected, 43 merged, 44 escalated, 46 split, 50 + 51 merged
  assert.deepEqual(Object.keys(derive(read())).sort(), ['acme/shop#42', 'acme/shop#45', 'acme/shop#47', 'acme/shop#48', 'acme/shop#49', 'eval/golden#4']);
  assert.equal(read().filter((e) => e.stage === 'rules').length, 5); // the rule audit trail survives archiving
  const page = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');
  assert.match(page, /"merged":3,/); // metrics.all counts the archived merges
  assert.equal(page.split('__FACTORY_DATA__').length, 1);
  assert.match(page, /"ruleHistory":\[\{[^\]]*"key":"ci","value":"skip"/);
  assert.match(page, /"id":"acme\/shop#47"[^]*?"parent":"acme\/shop#46"/); // parent survives archiving
  assert.deepEqual(axesFor(['lib/x.ts']), ['code', 'security']);
  assert.deepEqual(axesFor(['app/blog/page.tsx']), ['code', 'security', 'ux', 'ui', 'seo']);
  // Dashboard must not break out of its JSON script tag.
  record('evil/x#1', 'intake', 'started', { title: '</script><script>alert(1)</script>' });
  const html = fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8');
  assert.ok(!html.includes('</script><script>alert'));
  discoverTest();
  cliTest();
  console.log(`ok - all checks passed (${DIR})`);
}

function discoverTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-discover-'));
  const clone = (rel, url, worktrees = 0) => {
    const d = path.join(root, rel, '.git');
    fs.mkdirSync(path.join(d, 'worktrees'), { recursive: true });
    for (let i = 0; i < worktrees; i++) fs.mkdirSync(path.join(d, 'worktrees', `w${i}`));
    fs.writeFileSync(path.join(d, 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  };
  clone('work/shop', 'git@github.com:acme/shop.git', 2);
  clone('old/shop-copy', 'https://github.com/acme/shop');
  clone('work/site', 'https://github.com/acme/site.git/');
  clone('work/gitlab-thing', 'git@gitlab.com:acme/thing.git');
  clone('work/app/node_modules/dep', 'git@github.com:evil/dep.git');
  clone('.hidden/secret', 'git@github.com:acme/secret.git');
  clone('work/umbrella', 'git@github.com:acme/umbrella.git');
  clone('work/umbrella/nested', 'git@github.com:acme/nested.git'); // a clone inside another repo
  fs.mkdirSync(path.join(root, 'work/shop/.claude/worktrees/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'work/shop/.claude/worktrees/x/.git'), 'gitdir: ../../.git/worktrees/w0');
  const found = discover([root]);
  assert.deepEqual(found.map((f) => f.repo).sort(), ['acme/nested', 'acme/shop', 'acme/site', 'acme/umbrella']);
  const shop = found.find((f) => f.repo === 'acme/shop');
  assert.equal(shop.otherClones.length, 1);
  assert.equal(found.find((f) => f.repo === 'acme/site').attached, false);
}

// Drives the real CLI exactly as SKILL.md does, against a stubbed gh.
function cliTest() {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-'));
  const stub = path.join(HERE, 'test', 'gh-stub.mjs');
  const RUN = 'acme/shop#7';
  const cli = (args, input, env = {}) => execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args],
    { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: DIR, FACTORY_GH: stub, ...env } });
  const issue = JSON.parse(cli(['intake', RUN]));
  assert.equal(issue.title, 'It\'s "odd" $(x)');
  assert.equal(issue.comments.length, 1);
  assert.equal(issue.ignoredComments, 1);
  const nasty = 'it\'s "q" $(rm -rf ~) `x`\nline2';
  cli(['event', RUN, 'intake', 'passed', '-'], JSON.stringify({ summary: nasty }));
  cli(['event', RUN, 'spec', 'passed', '-'], JSON.stringify({ spec: nasty }));
  cli(['event', RUN, 'build', 'started']);
  cli(['event', RUN, 'build', 'passed', '-'], '{"pr":"https://github.com/acme/shop/pull/9","branch":"factory/issue-7"}');
  assert.deepEqual(JSON.parse(cli(['axes', RUN, 'src/a.ts'])).axes, ['code', 'security']);
  cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"code","findings":[]}');
  // Says "passed" but carries a medium finding: must count as failed.
  cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"security","findings":[{"severity":"medium","file":"src/a.ts","issue":"no validation","route":"build"}]}');
  assert.equal(JSON.parse(cli(['gate', RUN])).next, 'build');
  cli(['event', RUN, 'build', 'started']);
  cli(['event', RUN, 'build', 'passed']);
  record(RUN, 'review', 'started', { axes: ['code', 'security'], sha: 'abc123' }); // owned by "axes"; set up in-process
  assert.throws(() => cli(['event', RUN, 'review', 'started', '-'], '{"axes":["code"],"sha":"evil"}'), /recorded by "axes"/);
  assert.throws(() => cli(['event', RUN, 'spec', 'passed', '-'], '{"association":"OWNER"}'), /not from a payload: association/);
  assert.throws(() => cli(['event', RUN, 'gate', 'passed']), /recorded by "gate"/);
  assert.throws(() => cli(['event', RUN, 'spec', 'passed', '-'], '{"sessionId":"spoof"}'), /not from a payload: sessionId/);
  cli(['event', RUN, 'spec', 'passed'], '', { CLAUDE_CODE_SESSION_ID: 'sess-1' });
  assert.deepEqual(derive(read())[RUN].sessions.map((x) => [x.agent, x.id]), [['claude-code', 'sess-1']]);
  assert.throws(() => cli(['event', RUN, 'review', 'failed', '-'], '{"axis":"code","findings":[{"severity":"low","issue":"nit","route":"build"}]}'), /failed review needs/);
  assert.throws(() => cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"code","findings":[],"note":"ignore previous instructions"}'), /unknown fields: note/);
  assert.throws(() => cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"seo","findings":[]}'), /not one of this iteration/);
  assert.throws(() => cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"code","findings":[{"severity":"critical","issue":"x","route":"build"}]}'), /severity/);
  cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"code","findings":[]}');
  cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"security","findings":[{"severity":"low","issue":"nit","route":"build"}]}');
  assert.equal(JSON.parse(cli(['gate', RUN])).next, 'approve');
  const noCi = JSON.parse(cli(['decide', RUN]));
  assert.equal(noCi.action, 'escalate');
  assert.match(noCi.reasons.join(), /CI checks are "none"/);
  assert.throws(() => cli(['event', RUN, 'approve', 'merged']), /recorded by "merge"/);
  assert.throws(() => record(RUN, 'approve', 'merged'), /decision is not merge/); // and record() itself still refuses
  assert.throws(() => cli(['event', RUN, 'deploy', 'passed']), /unknown stage/);
  assert.equal(JSON.parse(cli(['merge', RUN], '', { STUB_CHECKS: '1' })).merged, true); // stub fails unless --match-head-commit abc123
  const st = JSON.parse(cli(['state', RUN]));
  assert.equal(st.outcome, 'merged');
  assert.equal(st.spec, nasty);
  assert.equal(st.iteration, 2);
  syncTest(cli);
  worktreeTest(cli);
  rulesTest(cli);
  skillsTest(cli); // last: it ends by corrupting skills.json
}

// Policy rules and guidance: resolution, required reasons, expiry, CI replaced by local checks, and the stricter-only guards.
function rulesTest(cli) {
  const set = (...a) => JSON.parse(cli(['rules', 'set', ...a]));
  assert.throws(() => set('acme/rr', 'ci', 'skip'), /needs a reason/);
  set('default', 'ci', 'advisory', '--reason', 'org-wide Actions outage');
  const p = set('acme/rr', 'ci', 'skip', '--reason', 'billing', '--until', '2999-01-01');
  assert.deepEqual([p.policy.ci.value, p.policy.ci.setBy, p.policy.ci.scope, p.policy.ci.until], ['skip', 'stub-user', 'acme/rr', '2999-01-01']); // setBy is gh's login, never typed
  assert.equal(JSON.parse(cli(['rules', 'acme/other'])).policy.ci.value, 'advisory'); // project over global, global fills in
  // A closed set of switches, each only stricter: nothing touches trust, sensitive paths, axes or the merge checks.
  for (const [k, v, re] of [
    ['trusted', '["NONE"]', /unknown rule "trusted"/], ['sensitive', '[]', /unknown rule "sensitive"/], ['axes', 'code', /unknown rule/],
    ['review.security', 'off', /unknown rule/], ['matchHeadCommit', 'off', /unknown rule/], ['imported', 'merge', /unknown rule/],
    ['ci', 'off', /required\|advisory\|skip/], ['diffCap', '400', /can only lower/], ['diffCap', '0', /can only lower/],
    ['checks.commands', '[]', /1-10/], ['checks.commands', '["a\\nb"]', /1-10/], ['guide.deploy', 'x', /unknown step "deploy"/],
  ]) assert.throws(() => set('acme/rr', k, v, '--reason', 'x'), re);
  assert.throws(() => set('acme/rr', 'ci', 'skip', '--reason', 'x', '--until', '2020-01-01'), /--until/);
  assert.throws(() => set('acme/rr', 'ci', 'skip', '--reason', 'x', '--until', '2026-13-40'), /--until/);
  assert.throws(() => cli(['skills', 'set', 'acme/rr', 'rules', '{"ci":{"value":"skip","reason":"x","setBy":"me","setAt":"2026-01-01"}}']), /set with "rules set"/);
  // Rule changes are owned events: recorded by "rules", refused from "event", and never runs.
  assert.throws(() => cli(['event', 'acme/rr', 'rules', 'set', '-'], '{"key":"ci","value":"skip"}'), /recorded by "rules"/);
  assert.throws(() => cli(['event', 'acme/rr#1', 'build', 'passed', '-'], '{"localChecks":{"state":"pass","sha":"abc123","commands":[]}}'), /not from a payload: localChecks/);
  assert.deepEqual(read().filter((e) => e.stage === 'rules' && e.run !== 'acme/wt').map((e) => [e.run, e.status, e.key, e.value, e.setBy]), [['default', 'set', 'ci', 'advisory', 'stub-user'], ['acme/rr', 'set', 'ci', 'skip', 'stub-user']]);
  assert.equal(derive(read())['acme/rr'], undefined);
  // Guidance: free text per step, whole-flow first, global before project; it shows up in the resolved stage output.
  set('default', 'guide.*', 'Keep PRs small.');
  set('acme/rr', 'guide.build', 'use pnpm, never npm');
  set('acme/rr', 'guide.review.ui', 'follow our brand tokens');
  const sk = JSON.parse(cli(['skills', 'acme/rr']));
  assert.deepEqual(sk.guide.build, ['Keep PRs small.', 'use pnpm, never npm']);
  assert.deepEqual(sk.guide['review.ui'], ['Keep PRs small.', 'follow our brand tokens']);
  assert.deepEqual(sk.guide.spec, ['Keep PRs small.']);
  assert.deepEqual(JSON.parse(cli(['rules', 'acme/rr'])).guide.build, sk.guide.build);
  // Expiry, on a fixed clock: a project rule applies through its until day, then the global rule takes over, with a warning.
  const at = '2026-01-01T00:00:00Z', cfg = { default: { rules: { ci: { value: 'advisory', reason: 'g', setBy: 'a', setAt: at } } }, 'acme/rr': { rules: { ci: { value: 'skip', reason: 'billing', setBy: 'a', setAt: at, until: '2026-11-20' } } } };
  const live = rules('acme/rr', cfg, Date.parse('2026-11-20T23:00:00Z'));
  assert.equal(live.policy.ci.value, 'skip');
  assert.match(live.warnings.join(), /expires on 2026-11-20/);
  const gone = rules('acme/rr', cfg, Date.parse('2026-11-21T00:00:00Z'));
  assert.deepEqual([gone.policy.ci.value, gone.expired[0].key], ['advisory', 'ci']);
  assert.match(gone.warnings.join(), /expired on 2026-11-20 and no longer applies/);
  assert.deepEqual(rules('x/y', { 'x/y': cfg['acme/rr'] }, Date.parse('2027-01-01')).policy, {}); // nothing left: CI required again
  // decide() under rules: not required is never green.
  const ok = { association: 'OWNER', iteration: 1, pr: 'x', reviewedSha: 's1', axes: { 1: ['code', 'security'] }, reviews: { 1: { code: { verdict: 'passed' }, security: { verdict: 'passed' } } } };
  const rule = (value) => ({ value, reason: 'billing', setBy: 'acme', setAt: '2026-11-20T10:00:00Z' });
  const pol = (ci, cmds, extra) => ({ ...(ci && { ci: rule(ci) }), ...(cmds && { 'checks.commands': rule(cmds) }), ...extra });
  const lc = (state, sha = 's1', cmds = ['pnpm test']) => ({ state, sha, commands: cmds.map((cmd) => ({ cmd, exit: state === 'pass' ? 0 : 1, ms: 1 })) });
  const D = (r, f) => decide(r, { checks: 'skipped', additions: 10, deletions: 0, files: ['src/a.ts', 'src/a.test.ts'], ...f });
  const skip = pol('skip', ['pnpm test']), green = { ...ok, localChecks: lc('pass') };
  const m = D(green, { rules: skip });
  assert.equal(m.action, 'merge');
  assert.match(m.reasons.join(' | '), /CI not required by rule ci=skip, set by acme on 2026-11-20: billing\. Local checks: pass \(pnpm test\)/);
  const none = D(green, { rules: pol('skip') }); // (b): nothing stands in, so escalate
  assert.deepEqual([none.action, /no checks.commands rule replaces CI/.test(none.reasons.join())], ['escalate', true]);
  assert.match(D(ok, { rules: skip }).reasons.join(), /Local checks: not run/);
  assert.match(D({ ...ok, localChecks: lc('fail') }, { rules: skip }).reasons.join(), /Local checks: fail \(pnpm test\)/);
  assert.match(D({ ...ok, localChecks: lc('pass', 's0') }, { rules: skip }).reasons.join(), /not the reviewed commit/); // a pass from an older iteration
  assert.match(D({ ...ok, localChecks: lc('pass', 's1', ['true']) }, { rules: skip }).reasons.join(), /different command list/);
  assert.equal(D(green, { checks: 'fail', rules: pol('advisory', ['pnpm test']) }).action, 'merge'); // advisory: red CI shown, not blocking
  assert.match(D(green, { checks: 'fail', rules: pol('advisory', ['pnpm test']) }).reasons.join(), /ci=advisory.*\(CI is "fail"\)/);
  assert.equal(D(green, { checks: 'fail', rules: pol(null, ['pnpm test']) }).action, 'escalate'); // CI required: local checks never rescue red CI
  assert.match(D(ok, { checks: 'pass', rules: pol(null, ['pnpm test']) }).reasons.join(), /Local checks: not run/); // ...but do add a requirement
  // The guards hold under ci=skip with passing local checks.
  assert.match(D({ ...green, association: 'NONE' }, { rules: skip }).reasons.join(), /not trusted/);
  assert.match(D(green, { rules: skip, files: ['lib/auth/x.ts', 'lib/auth/x.test.ts'] }).reasons.join(), /sensitive paths/);
  assert.match(D({ ...green, imported: true }, { rules: skip }).reasons.join(), /imported/);
  assert.match(D(green, { rules: { ...skip, diffCap: rule(50) }, additions: 60 }).reasons.join(), /max 50 by rule diffCap/);
  // End to end on acme/shop: the model's checks.json never stands in for CI; F's own check does, and merge still pins the reviewed commit.
  set('acme/shop', 'ci', 'skip', '--reason', 'Actions billing');
  set('acme/shop', 'checks.commands', '["pnpm test"]', '--reason', 'stands in for CI');
  const R = 'acme/shop#8';
  record(R, 'intake', 'started', { title: 't', association: 'OWNER' });
  record(R, 'build', 'passed', { pr: 'https://github.com/acme/shop/pull/8' });
  record(R, 'review', 'started', { axes: ['code', 'security'], sha: 'abc123' });
  record(R, 'review', 'passed', { axis: 'code', findings: [] });
  record(R, 'review', 'passed', { axis: 'security', findings: [] });
  fs.mkdirSync(runDir(R), { recursive: true });
  fs.writeFileSync(path.join(runDir(R), 'checks.json'),'{"lint":"pass","typecheck":"pass","tests":"pass","build":"pass"}');
  const no = JSON.parse(cli(['decide', R]));
  assert.equal(no.action, 'escalate');
  assert.match(no.reasons.join(), /Local checks: not run/);
  assert.equal(no.facts.checks, 'skipped'); // gh pr checks isn't even called (the stub would report none)
  record(R, 'build', 'passed', { localChecks: lc('pass', 'abc123') }); // what "F checks" records (tested for real in worktreeTest)
  assert.equal(JSON.parse(cli(['merge', R])).merged, true); // stub fails unless --match-head-commit abc123
  record('acme/shop#9', 'intake', 'started', { title: 'imp', association: 'OWNER', imported: true });
  assert.equal(JSON.parse(cli(['decide', 'acme/shop#9'])).action, 'escalate');
  // Re-enable: unset falls back to the global rule, then to the built-in; each unset is audited too.
  cli(['rules', 'unset', 'acme/shop', 'ci', '--reason', 'billing fixed']);
  cli(['rules', 'unset', 'acme/shop', 'checks.commands']);
  assert.equal(JSON.parse(cli(['rules', 'acme/shop'])).policy.ci.value, 'advisory');
  cli(['rules', 'unset', 'default', 'ci']);
  assert.deepEqual(JSON.parse(cli(['rules', 'acme/shop'])).policy, {});
  assert.throws(() => cli(['rules', 'unset', 'acme/shop', 'ci']), /no rule "ci"/);
  assert.match(cli(['rules', 'unset', 'acme/rr', 'guide.build']), /"guide"/);
  assert.deepEqual(read().filter((e) => e.stage === 'rules' && e.status === 'unset' && e.run === 'acme/shop').map((e) => [e.run, e.key, e.reason]).slice(0, 1), [['acme/shop', 'ci', 'billing fixed']]);
  // A hand-edited rule without a reason fails loudly, and the dashboard says so instead of failing every event.
  fs.writeFileSync(path.join(DIR, 'skills.json'), '{"acme/rr":{"rules":{"ci":{"value":"skip","setBy":"me","setAt":"2026-01-01"}}}}');
  assert.throws(() => cli(['rules', 'acme/rr']), /needs a reason/);
  record('acme/rr#2', 'intake', 'started', { title: 't' });
  assert.match(fs.readFileSync(path.join(DIR, 'dashboard.html'), 'utf8'), /"rulesError":"skills.json acme\/rr.rules.ci: needs a reason/);
  fs.rmSync(path.join(DIR, 'skills.json'));
}

// Per-step runners: config resolution and validation, extra axes, F-stamped runner, invalid output = failed review.
function skillsTest(cli) {
  const R = 'acme/kit#1';
  const set = (scope, key, v) => cli(['skills', 'set', scope, key, JSON.stringify(v)]);
  set('default', 'review.code', { use: 'skill', name: 'house-review' });
  set('default', 'spec', { use: 'skill', name: 'global-planner' });
  set('acme/kit', 'spec', { use: 'skill', name: 'my-planner' });
  set('acme/kit', 'build', { use: 'provider', harness: 'codex' });
  set('default', 'axes.extra', [{ axis: 'a11y', when: ['**/*.tsx'], use: 'brief', path: '~/.claude/factory/briefs/a11y.md' }]);
  set('acme/kit', 'axes.extra', [{ axis: 'perf', when: ['src/hot/**'], use: 'skill', name: 'perf-review' }]);
  const { plan, extra, required } = JSON.parse(cli(['skills', 'acme/kit']));
  assert.equal(plan.spec.name, 'my-planner'); // project beats global
  assert.equal(plan['review.code'].name, 'house-review'); // global fills the rest
  assert.deepEqual(plan['review.security'], { use: 'default' });
  assert.deepEqual(extra.map((x) => x.axis), ['a11y', 'perf']);
  assert.deepEqual(required, ['code', 'security']);
  assert.equal(JSON.parse(cli(['skills', 'acme/other'])).plan.spec.name, 'global-planner');
  // Refused: unknown steps, any way to switch an axis off, unknown harnesses, shell-ish names, in-tree briefs, extra fields, shadowing a built-in axis.
  for (const [key, v, re] of [
    ['review.lint', { use: 'default' }, /unknown step "review.lint"/],
    ['review.security', { use: 'off' }, /expected/],
    ['build', { use: 'provider', harness: 'cursor' }, /expected/],
    ['spec', { use: 'skill', name: 'x; rm -rf ~' }, /expected/],
    ['review.code', { use: 'brief', path: 'docs/lenient.md' }, /expected/],
    ['review.code', { use: 'skill', name: 'x', note: 'hi' }, /unknown fields note/],
    ['axes.extra', [{ axis: 'security', when: ['**'], use: 'skill', name: 'lenient' }], /new lowercase name/],
    ['axes.extra', [{ axis: 'a11y', when: [], use: 'skill', name: 'x' }], /needs "when"/],
  ]) assert.throws(() => set('acme/kit', key, v), re);
  assert.throws(() => set('acme', 'spec', { use: 'default' }), /scope "acme"/);
  // Required axes are always selected; extra axes only add, by glob.
  assert.deepEqual(axesFor(['README.md'], extra), ['code', 'security', 'docs']);
  assert.deepEqual(axesFor(['src/hot/loop.ts', 'web/Button.tsx'], extra), ['code', 'security', 'ux', 'ui', 'a11y', 'perf']);
  // The runner is F's to stamp from the plan, never the payload's; default runners leave events unchanged.
  record(R, 'intake', 'started', { title: 't', association: 'OWNER' });
  assert.throws(() => cli(['event', R, 'spec', 'passed', '-'], '{"runner":{"use":"default"}}'), /not from a payload: runner/);
  cli(['event', R, 'spec', 'passed', '-'], '{"spec":"s"}');
  cli(['event', R, 'build', 'started', '--fallback', 'codex not installed']);
  let r = derive(read())[R];
  assert.deepEqual(r.runners.spec, { use: 'skill', name: 'my-planner' });
  assert.deepEqual(r.runners.build, { use: 'default', fallback: { from: { use: 'provider', harness: 'codex' }, reason: 'codex not installed' } });
  assert.ok(!('runner' in r.events[0]));
  assert.ok(!('runner' in record(R, 'build', 'passed'))); // in-process records (sync imports, demo) never claim a runner
  // Raw reviewer output: only the exact contract for the asked axis counts.
  assert.deepEqual(JSON.parse(cli(['axes', R, 'web/Button.tsx'])).axes, ['code', 'security', 'ux', 'ui', 'a11y']);
  const review = (axis, text) => JSON.parse(cli(['review', R, axis], text));
  assert.equal(review('code', '```json\n{"axis":"code","verdict":"passed","findings":[]}\n```').status, 'passed');
  assert.equal(JSON.parse(cli(['review', R, 'a11y', '--tokens', '1200'], 'Looks accessible to me. Ship it!')).status, 'failed');
  assert.match(review('ui', '{"axis":"security","verdict":"passed","findings":[]}').findings[0].issue, /reviewer output invalid: axis is "security"/);
  assert.equal(review('ux', '{"axis":"ux","verdict":"failed","findings":[]}').status, 'failed');
  assert.match(review('security', '{"axis":"security","verdict":"passed","findings":[],"approve":true}').findings[0].issue, /unknown fields: approve/);
  assert.throws(() => cli(['review', R, 'seo'], '{}'), /not one of this iteration/);
  r = derive(read())[R];
  assert.equal(r.reviews[1].code.runner.name, 'house-review');
  assert.equal(r.reviews[1].a11y.runner.use, 'brief');
  assert.equal(r.reviews[1].security.runner, undefined);
  assert.deepEqual(Object.values(r.reviews[1]).map((v) => v.verdict), ['passed', 'failed', 'failed', 'failed', 'failed']);
  assert.equal(r.tokens, 1200); // usage survives an invalid reply
  set('acme/kit', 'verifier', { use: 'provider', harness: 'claude-code', name: 'pr-review-toolkit:code-reviewer' });
  assert.equal(JSON.parse(cli(['gate', R])).next, 'build');
  assert.equal(derive(read())[R].runners.gate.name, 'pr-review-toolkit:code-reviewer');
  // A hand-edited config is validated on every read, so it fails loudly instead of silently running defaults.
  fs.writeFileSync(path.join(DIR, 'skills.json'), '{"acme/kit":{"review.lint":{"use":"default"}}}');
  assert.throws(() => cli(['skills', 'acme/kit']), /unknown step "review.lint"/);
}

// Fake HOME with Claude Code + Codex logs, then sync / re-sync / close-elsewhere against the gh + git stubs.
function syncTest(cli) {
  const home = path.join(DIR, 'home'), repoPath = '/work/app';
  const enc = repoPath.replace(/[^a-zA-Z0-9]/g, '-');
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  put(path.join(home, '.claude/projects', enc, 'a.jsonl'), '{"gitBranch":"dev/feat-a","message":"secret prompt"}\n{"gitBranch":"HEAD"}\n');
  put(path.join(home, '.claude/projects', enc + '--claude-worktrees-wip', 'b.jsonl'), '{"gitBranch":"dev/wip-9"}\n{"gitBranch":"old/merged"}\n{"gitBranch":"dev/squashed"}\n{"gitBranch":"factory/issue-9"}\n');
  put(path.join(home, '.codex/sessions/2026/11/20/r.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'cx-1', cwd: '/work/app', git: { branch: 'claude/stacked', repository_url: 'git@github.com:acme/app.git' } } }) + '\n');
  put(path.join(home, '.codex/sessions/2026/11/20/other.jsonl'), JSON.stringify({ payload: { git: { branch: 'x', repository_url: 'git@github.com:acme/other.git' } } }) + '\n');
  const env = { HOME: home, FACTORY_GIT: path.join(HERE, 'test', 'git-stub.mjs') };
  // An existing factory run owns PR 13 / factory/issue-8.
  cli(['event', 'acme/app#8', 'build', 'passed', '-'], '{"pr":"https://github.com/acme/app/pull/13","branch":"factory/issue-8"}', env);
  const [first] = JSON.parse(cli(['sync', 'acme/app', repoPath], '', env));
  // factory/issue-9 (our own build mid-flight) and dev/squashed (merged PR) are not imported.
  assert.deepEqual(first.added.sort(), ['acme/app#10', 'acme/app#11', 'acme/app#12', 'acme/app#14', 'acme/app:dev/wip-9']);
  const runs = derive(read());
  assert.equal(runs['acme/app#10'].source, 'claude-code');
  assert.deepEqual(runs['acme/app#10'].issues, [5]);
  assert.deepEqual(runs['acme/app#11'].issues, [6, 7]);
  assert.equal(runs['acme/app#11'].source, 'none');
  assert.equal(runs['acme/app#12'].source, 'codex');
  assert.ok(!JSON.stringify(read()).includes('secret prompt'));
  const links = JSON.parse(fs.readFileSync(path.join(DIR, 'sessions.json'), 'utf8'));
  assert.deepEqual(links['acme/app#10'].map((x) => [x.agent, x.id]), [['claude-code', 'a']]);
  assert.deepEqual(links['acme/app#12'].map((x) => [x.agent, x.id]), [['codex', 'cx-1']]);
  assert.equal(JSON.parse(cli(['decide', 'acme/app#11'], '', env)).action, 'escalate');
  assert.deepEqual(JSON.parse(cli(['sync'], '', env))[0].added, []); // re-sync is idempotent and remembers the path
  const [later] = JSON.parse(cli(['sync', 'acme/app'], '', { ...env, STUB_CLOSED: '10', STUB_WIP_PR: '1' }));
  assert.deepEqual(later.closed, ['acme/app#10']);
  assert.deepEqual(later.attached, ['acme/app:dev/wip-9']); // session-only run picks up its new PR
  assert.equal(derive(read())['acme/app:dev/wip-9'].pr, 'https://github.com/acme/app/pull/15');
  const [last] = JSON.parse(cli(['sync', 'acme/app'], '', { ...env, STUB_CLOSED: '10,15' }));
  assert.deepEqual(last.closed, ['acme/app:dev/wip-9']); // ...and closes once that PR merges
  assert.equal(derive(read())['acme/app#10'].outcome, 'closed');
  // Intake: issue 5 is claimed by open PR 10 (exact closing ref) -> stop, record nothing; issue 8's only PR is the factory's own.
  const busy = JSON.parse(cli(['intake', 'acme/app#5'], '', env));
  assert.deepEqual(busy.inProgress, ['https://github.com/acme/app/pull/10']);
  assert.equal(derive(read())['acme/app#5'], undefined);
  assert.ok(!JSON.parse(cli(['intake', 'acme/app#8'], '', env)).inProgress);
  assert.deepEqual(JSON.parse(cli(['intake', 'acme/app#20'], '', env)).mentions.map((m) => m.url), ['https://github.com/acme/app/pull/14']);
  assert.deepEqual(JSON.parse(cli(['intake', 'acme/app#2'], '', env)).mentions, []); // #20 is not #2
  assert.match(JSON.parse(cli(['intake', 'acme/app#30'], '', env)).notAnIssue, /closed/);
  // Spec approval: only a trusted "/factory approve" after the wait started counts.
  record('acme/app#21', 'intake', 'started', { title: 't', association: 'NONE' });
  cli(['event', 'acme/app#21', 'spec', 'awaiting-approval'], '', env);
  assert.deepEqual(JSON.parse(cli(['approval', 'acme/app#21'], '', env)), { decision: 'approve', by: 'acme' });
  cli(['event', 'acme/app#21', 'spec', 'passed', '-'], '{"approvedBy":"acme"}', env);
  assert.equal(derive(read())['acme/app#21'].outcome, 'in-progress');
  // A split child inherits its untrusted parent's association even though the child issue was opened by the owner.
  record('acme/app#22', 'intake', 'started', { title: 'epic', association: 'NONE' });
  record('acme/app#22', 'intake', 'split', { children: ['acme/app#23'] });
  cli(['intake', 'acme/app#23'], '', env);
  const child = derive(read())['acme/app#23'];
  assert.deepEqual([child.association, child.origin, child.originAssociation], ['OWNER', 'acme/app#22', 'NONE']);
  assert.ok(risk(child, []).risky);
  const q = JSON.parse(cli(['queue', 'acme/app'], '', env));
  assert.deepEqual(q.ready.map((x) => x.run), ['acme/app#40']);
  assert.deepEqual(q.untriaged.map((x) => x.run), ['acme/app#41', 'acme/app#7']);
  assert.equal(derive(read())['acme/app#30'], undefined);
}

// Real git: a bare origin + clone, then worktree -> deps -> axes -> guarded cleanup -> resume -> gc.
function worktreeTest(cli) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wt-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = path.join(root, 'origin.git'), clone = path.join(root, 'clone');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(root, 'clone', '-q', origin, clone);
  fs.writeFileSync(path.join(clone, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(clone, 'package.json'), '{"name":"x"}');
  fs.writeFileSync(path.join(clone, 'package-lock.json'), '{"lockfileVersion":3}');
  g(clone, 'add', '.'); g(clone, 'commit', '-qm', 'init'); g(clone, 'push', '-q', 'origin', 'HEAD:main');
  fs.mkdirSync(path.join(clone, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'node_modules', 'dep', 'index.js'), 'module.exports = 1');
  const R = 'acme/wt#3', env2 = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const w = JSON.parse(cli(['worktree', R, clone], '', env2));
  assert.equal(w.branch, 'factory/issue-3');
  assert.ok(fs.existsSync(path.join(w.path, 'package.json')));
  assert.match(cli(['deps', R], '', env2), process.platform === 'darwin' ? /cloned copy-on-write/ : /./);
  assert.ok(fs.existsSync(path.join(w.path, 'node_modules', 'dep', 'index.js')));
  // F checks: the checks.commands rule runs in the worktree on a clean HEAD; exit codes are recorded, output goes to a file.
  assert.throws(() => cli(['checks', R], '', env2), /no checks.commands rule/);
  cli(['rules', 'set', 'acme/wt', 'checks.commands', '["test -f package.json","echo checked-$((40+2))"]', '--reason', 'Actions billing'], '', env2);
  const c1 = JSON.parse(cli(['checks', R], '', env2));
  assert.deepEqual([c1.state, c1.sha, c1.commands.map((c) => c.exit)], ['pass', g(w.path, 'rev-parse', 'HEAD').trim(), [0, 0]]);
  assert.match(fs.readFileSync(c1.log, 'utf8'), /checked-42/);
  assert.ok(!JSON.stringify(read()).includes('checked-42')); // output stays out of the log
  fs.writeFileSync(path.join(w.path, 'wip.txt'), 'x');
  assert.throws(() => cli(['checks', R], '', env2), /uncommitted changes/);
  fs.rmSync(path.join(w.path, 'wip.txt'));
  cli(['rules', 'set', 'acme/wt', 'checks.commands', '["test -f missing.txt","true"]', '--reason', 'Actions billing'], '', env2);
  const c2 = JSON.parse(cli(['checks', R], '', env2));
  assert.deepEqual([c2.state, c2.commands.map((c) => c.exit)], ['fail', [1, 0]]);
  assert.equal(derive(read())[R].localChecks.state, 'fail');
  cli(['rules', 'unset', 'acme/wt', 'checks.commands'], '', env2);
  cli(['event', R, 'build', 'started'], '', env2);
  fs.mkdirSync(path.join(w.path, 'src')); fs.writeFileSync(path.join(w.path, 'src', 'b.tsx'), 'x');
  g(w.path, 'add', '.'); g(w.path, 'commit', '-qm', 'b');
  const a1 = JSON.parse(cli(['axes', R], '', env2));
  assert.deepEqual(a1.files, ['src/b.tsx']);
  assert.deepEqual(a1.axes, ['code', 'security', 'ux', 'ui']);
  for (const ax of ['code', 'security', 'ux']) cli(['event', R, 'review', 'passed', '-'], `{"axis":"${ax}","findings":[]}`, env2);
  cli(['event', R, 'review', 'failed', '-'], '{"axis":"ui","findings":[{"severity":"high","issue":"x","route":"build"}]}', env2);
  // Next iteration: only a non-UI file changes, but the failed ui axis must be re-run; passed ux is not.
  cli(['event', R, 'build', 'started'], '', env2);
  fs.writeFileSync(path.join(w.path, 'src', 'c.ts'), 'y'); g(w.path, 'add', '.'); g(w.path, 'commit', '-qm', 'c');
  const a2 = JSON.parse(cli(['axes', R], '', env2));
  assert.deepEqual(a2.files, ['src/c.ts']);
  assert.deepEqual(a2.axes, ['code', 'security', 'ui']);
  // Unpushed work survives the end of the run...
  cli(['event', R, 'approve', 'escalated'], '', env2);
  assert.ok(fs.existsSync(w.path), 'unpushed worktree must be kept');
  // ...and goes once pushed, along with the local branch.
  g(w.path, 'push', '-q', '-u', 'origin', 'factory/issue-3');
  assert.deepEqual(JSON.parse(cli(['gc'], '', env2)), { [R]: 'removed' });
  assert.ok(!fs.existsSync(w.path));
  assert.equal(g(clone, 'branch', '--list', 'factory/issue-3').trim(), '');
  // Resume recreates it from the pushed branch, using the remembered clone path.
  const again = JSON.parse(cli(['worktree', R], '', env2));
  assert.ok(fs.existsSync(path.join(again.path, 'src', 'c.ts')));
  assert.deepEqual(JSON.parse(cli(['gc'], '', env2)), { [R]: 'removed' });
  // Post-merge: red CI on the merge commit -> a revert PR is opened (never merged) and the run is marked reverted.
  fs.writeFileSync(path.join(clone, 'feature.txt'), 'f'); g(clone, 'add', '.'); g(clone, 'commit', '-qm', 'feature'); g(clone, 'push', '-q', 'origin', 'HEAD:main');
  const sha = g(clone, 'rev-parse', 'HEAD').trim();
  cli(['event', R, 'build', 'passed', '-'], '{"pr":"https://github.com/acme/wt/pull/3"}', env2);
  const env3 = { ...env2, STUB_MERGE_SHA: sha };
  cli(['rules', 'set', 'acme/wt', 'ci', 'skip', '--reason', 'Actions billing'], '', env3);
  assert.equal(JSON.parse(cli(['postmerge', R], '', env3)).state, 'skipped'); // a billing-red main must not trigger reverts
  cli(['rules', 'set', 'acme/wt', 'ci', 'advisory', '--reason', 'Actions flaky'], '', env3);
  assert.deepEqual(JSON.parse(cli(['postmerge', R], '', env3)), { sha, state: 'fail', failed: ['https://github.com/acme/wt/actions/runs/1'], advisory: true }); // shown, never reverted on
  cli(['rules', 'unset', 'acme/wt', 'ci'], '', env3);
  assert.equal(JSON.parse(cli(['postmerge', R], '', env3)).state, 'fail');
  assert.equal(JSON.parse(cli(['revert', R, 'main CI failed'], '', env3)).pr, 'https://github.com/acme/wt/pull/99');
  g(clone, 'fetch', '-q', 'origin');
  assert.match(g(clone, 'log', '-1', '--format=%s', 'origin/factory/revert-3'), /^Revert "feature"/);
  const rr = derive(read())[R];
  assert.equal(rr.reverted.pr, 'https://github.com/acme/wt/pull/99');
  assert.equal(rr.pr, 'https://github.com/acme/wt/pull/3'); // the revert PR doesn't replace the run's PR
  assert.ok(!fs.existsSync(path.join(runDir(R), 'revert')));
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, run, ...rest] = process.argv.slice(2);
  const fb = rest.indexOf('--fallback'), fallback = fb < 0 ? undefined : rest.splice(fb, 2)[1] || 'configured runner unavailable'; // the configured runner couldn't run; the built-in did
  // "-" reads the JSON payload from stdin (use a quoted heredoc) so untrusted text never touches shell quoting.
  const json = (s) => (s === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : s ? JSON.parse(s) : {});
  const out = (x) => console.log(JSON.stringify(x, null, 2));
  try {
    switch (cmd) {
      case 'event': {
        const [stage, status] = rest, p = json(rest[2]);
        const owned = { 'intake:started': 'intake', 'review:started': 'axes', 'approve:decided': 'merge', 'approve:merged': 'merge', 'approve:reverted': 'revert', 'approve:closed': 'sync' };
        const owner = owned[`${stage}:${status}`] || { gate: 'gate', rules: 'rules' }[stage];
        if (owner) throw new Error(`"${stage} ${status}" is recorded by "${owner}", not by hand`);
        const typed = ['association', 'originAssociation', 'origin', 'author', 'sha', 'imported', 'source', 'action', 'harness', 'sessionId', 'cwd', 'runner', 'localChecks'].filter((k) => k in p);
        if (typed.length) throw new Error(`these fields come from GitHub or git, not from a payload: ${typed.join(', ')}`);
        record(run, stage, status, p, { fallback }); break;
      }
      case 'review': { // raw reviewer output on stdin, from any runner; invalid output is recorded as a failed review
        const { status, payload } = reviewFromText(run, rest[0], fs.readFileSync(0, 'utf8'));
        for (const [flag, k] of [['--tokens', 'tokens'], ['--cost-usd', 'costUsd']]) { // the orchestrator's usage numbers, kept even when the reply is invalid
          const i = rest.indexOf(flag), v = i < 0 ? undefined : Number(rest[i + 1]);
          if (i >= 0 && !(v >= 0)) throw new Error(`${flag} needs a number`);
          if (i >= 0) payload[k] = v;
        }
        record(run, 'review', status, payload, { fallback });
        out({ status, findings: payload.findings }); break;
      }
      case 'skills': { // skills <owner/repo> | skills set <owner/repo|default> <step> <json>
        if (run !== 'set') { out(skills(run || '')); break; }
        const [scope, key, spec] = rest;
        if (!scope || !key || !spec) throw new Error('usage: skills set <owner/repo|default> <step> <json runner>');
        out(setSkill(scope, key, json(spec))); break;
      }
      case 'rules': { // rules <owner/repo> | rules set <scope> <key> <value> --reason "…" [--until YYYY-MM-DD] | rules unset <scope> <key> [--reason "…"]
        const flag = (f) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest.splice(i, 2)[1] ?? ''; };
        const reason = flag('--reason'), until = flag('--until');
        const [scope, key, value] = rest;
        if (run === 'set' && scope && key && value !== undefined) out(setRule(scope, key, value, { reason, until }));
        else if (run === 'unset' && scope && key) out(unsetRule(scope, key, { reason }));
        else if (run && run !== 'set' && run !== 'unset') out(rules(run));
        else throw new Error('usage: rules <owner/repo|default> | rules set <owner/repo|default> <ci|checks.commands|diffCap|guide.<step>> <value> --reason "…" [--until YYYY-MM-DD] | rules unset <owner/repo|default> <key> [--reason "…"]');
        break;
      }
      case 'checks': out(localChecks(run)); break;
      case 'automerge': { // per-project switch; decide() escalates everything when off
        if (!['on', 'off'].includes(rest[0])) throw new Error('usage: automerge <owner/repo> on|off');
        if (!projects()[run]) throw new Error(`${run} is not attached; run sync first`);
        fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [run]: { ...projects()[run], autoMerge: rest[0] === 'on' } }, null, 2));
        out(projects()[run]); break;
      }
      case 'axes': { // no files: diff the run's worktree since the last reviewed commit (or the base branch)
        const r = getRun(run), w = wtInfo(run);
        let files = rest, range = null;
        if (!files.length) {
          if (!w) throw new Error(`no worktree for ${run}; pass changed files or run "worktree" first`);
          range = `${r.reviewedSha || `origin/${w.base}`}...HEAD`;
          files = git('-C', w.path, 'diff', '--name-only', range).split('\n').filter(Boolean);
        }
        const sha = w && fs.existsSync(w.path) ? git('-C', w.path, 'rev-parse', 'HEAD').trim() : undefined;
        const axes = reviewAxes(r, files, skills(run.split(/[#:]/)[0]).extra);
        record(run, 'review', 'started', { axes, sha, range });
        out({ axes, range, files }); break;
      }
      case 'worktree': out(worktree(run, rest[0])); break;
      case 'deps': console.log(deps(run)); break;
      case 'gc': out(gc()); break;
      case 'gate': { const { status, ...p } = gate(getRun(run)); record(run, 'gate', status, p, { fallback }); out({ status, ...p }); break; }
      case 'intake': out(intake(run)); break;
      case 'sync': { // `sync` alone re-syncs every attached project
        const list = run ? [[run, rest[0]]] : Object.entries(projects()).map(([k, v]) => [k, v.path]);
        out(list.map(([k, p]) => sync(k, p))); break;
      }
      case 'projects': out(projects()); break;
      case 'discover': out(discover([run, ...rest].filter(Boolean))); break;
      case 'decide': { const r = getRun(run); const f = r.imported ? {} : facts(r); const d = decide(r, f); record(run, 'approve', 'decided', { ...d, facts: f }); out({ ...d, facts: f }); break; }
      case 'merge': out(merge(run)); break;
      case 'risk': out(risk(getRun(run), rest)); break;
      case 'approval': out(approval(run)); break;
      case 'postmerge': out(postmerge(run)); break;
      case 'revert': out(revert(run, rest.join(' ') || 'CI failed on the base branch after merge')); break;
      case 'queue': out(queue(run)); break;
      case 'archive': out(archive(run ? Number(run) : 14)); break;
      case 'eval': out(evals(run)); break;
      case 'state': out(getRun(run)); break;
      case 'dir': console.log(runDir(run)); break;
      case 'render': console.log(render()); break;
      case 'demo': // never pollute the real log with fixtures
        if (!process.env.FACTORY_DIR) DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-demo-'));
        console.log(demo()); break;
      case 'test': test(); break;
      default:
        console.log(`usage: factory.mjs <command>
  discover [roots...]                     find local GitHub clones for onboarding (default: ~/Development, ~/code, ...)
  sync   [owner/repo] [local clone path]  attach a project and import open PRs + agent sessions (no args: all)
  projects                                list attached projects
  intake <run>                            fetch issue, record intake start, print issue + trusted comments
  event  <run> <stage> <status> [json|-] [--fallback why]  record an event ("-" = JSON on stdin)
  worktree <run> [clone path]            create/reuse the run's git worktree (prints its path)
  deps   <run>                            cheapest node_modules for the worktree
  axes   <run> [changed files...]         pick + record review axes (default: worktree diff since last review)
  review <run> <axis> [--tokens n] [--cost-usd x] [--fallback why]  record a reviewer's raw reply from stdin (invalid = failed review)
  skills <owner/repo>                     print who runs each step (default, skill, brief or provider)
  skills set <owner/repo|default> <step> <json>  configure one step (intake, spec, build, review.<axis>, verifier, postmerge, axes.extra)
  rules  <owner/repo>                     print the policy rules, warnings and per-step guidance that apply
  rules set <owner/repo|default> <key> <value> --reason "…" [--until YYYY-MM-DD]  ci required|advisory|skip, checks.commands '[…]', diffCap n, guide.<step> "text"
  rules unset <owner/repo|default> <key> [--reason "…"]  remove one (back to the global rule, or the built-in)
  checks <run>                            run the checks.commands rule in the worktree on its HEAD commit (the CI stand-in)
  gc                                      remove worktrees of finished runs
  gate   <run>                            compute + record gate verdict
  decide <run>                            fetch CI + diff, compute + record merge/escalate
  merge  <run>                            re-decide, then merge the reviewed commit (the only merge path)
  risk   <run> <planned files...>         does the spec need human approval before building?
  approval <run>                          trusted "/factory approve|reject" comment since waiting?
  postmerge <run>                         CI state of the merge commit on the base branch
  revert <run> [reason]                   open a revert PR (never merged by the factory)
  queue  <owner/repo>                     factory:ready issues + untriaged open issues not in the log
  automerge <owner/repo> on|off           allow or forbid auto-merge for a project
  archive [days=14]                       compact finished runs older than N days
  eval   [fixture]                        score intake on evals/golden with headless claude (costs tokens)
  state  <run>                            print derived run state
  dir    <run>                            print the run's artifact folder
  render | demo | test`);
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`factory: ${e.message}`);
    process.exitCode = 1;
  }
}
