#!/usr/bin/env node
// Software factory state: append-only event log -> derived run state -> dashboard.html.
// Every state change goes through this script; never hand-edit events.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { harnesses } from './harnesses/index.mjs';
import * as project from './project.mjs'; // also handed whole to the idea-to-app test
import { PROJECT_EVENTS, newProject, issuesCreate, projectStatus, loop, queue, startIdea, retireIdea, ideas } from './project.mjs';
import { CAP, COST_CAP, DOCS, FINDING_KEYS, MAX_DIFF, MAX_ISSUES_PER_SESSION, OUTCOMES, PROJECT_BUDGET_USD, REVIEW_KEYS, SEO, SEVERITIES, SOURCE, STAGES, STATUSES, TERMINAL, TEST, TOKEN_CAP, TRUSTED, UI, USAGE_KEYS, VERIFIER_KEYS, blocking, costOf, isSensitive, sensitive } from '../core/src/constants.ts';
import { archive, factoryDir, io, log, read, record, runDir, stateDir } from '../core/src/log.ts';
import { INVALID, addBurn, allRuns, assertReviewOpen, budget, budgetWhy, burnOf, derive, finishBurn, getRun, validateReview, validateUsage } from '../core/src/derive.ts';
import { SUB_AXIS, measure, usageFile, withMeasured } from '../core/src/burn.ts';
import { axesFor, decide, gate, metrics, reviewAxes, risk } from '../core/src/gate.ts';
export { axesFor, decide, gate, metrics, reviewAxes, risk };
export { measure, withMeasured };
export { allRuns, budget, derive, validateReview, validateUsage };
export { archive, factoryDir, io, read, record, runDir };
export { CAP, COST_CAP, MAX_DIFF, MAX_ISSUES_PER_SESSION, PROJECT_BUDGET_USD, TOKEN_CAP, costOf, isSensitive };

const HERE = path.dirname(fileURLToPath(import.meta.url));
// render() lives with the server after the split; code bound for core calls dashboard.render().
export const dashboard = { render: () => render() };

// Who does each step: the built-in brief, the user's own skill or brief, or a harness's tool.
// User-local only (io.dir/skills.json): a repo, and so a PR, can never pick its own reviewers.
const BUILTIN_AXES = ['code', 'security', 'ux', 'ui', 'seo', 'docs'];
export const REQUIRED_AXES = ['code', 'security']; // axesFor always selects them; config can swap who reviews, never drop them
export const STEP_KEYS = ['intake', 'spec', 'build', ...BUILTIN_AXES.map((a) => `review.${a}`), 'verifier', 'postmerge'];
const harnessIds = () => harnesses.map((h) => h.id);
const NAME = /^[\w.-]+(:[\w.-]+)?$/; // skill, plugin:skill or agent type; it ends up in a command line
const skillsFile = () => path.join(stateDir(), 'skills.json');

function checkRunner(s, at, more = []) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at}: a runner must be a JSON object`);
  const bad = Object.keys(s).filter((k) => !['use', 'name', 'path', 'harness', ...more].includes(k));
  if (bad.length) throw new Error(`${at}: unknown fields ${bad.join(', ')}`);
  const ok = s.use === 'default' && !s.name && !s.path && !s.harness
    || s.use === 'skill' && NAME.test(s.name || '') && !s.path && !s.harness
    || s.use === 'brief' && /^(\/|~\/).*\.md$/.test(s.path || '') && !s.name && !s.harness // outside any worktree, so a branch can't supply it
    || s.use === 'provider' && harnessIds().includes(s.harness) && (s.name === undefined || NAME.test(s.name)) && !s.path;
  if (!ok) throw new Error(`${at}: expected {"use":"default"}, {"use":"skill","name"}, {"use":"brief","path":"/abs/or/~/….md"} or {"use":"provider","harness":"${harnessIds().join('|')}","name"?}`);
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
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(skillsFile() + '.tmp', JSON.stringify(cfg, null, 2));
  fs.renameSync(skillsFile() + '.tmp', skillsFile());
}

// value === undefined removes the step from that scope, so a project inherits the global choice again.
export function setSkill(scope, key, value) {
  if (key === 'rules' || key === 'guide') throw new Error(`"${key}" is set with "rules set", which records who changed it and why`);
  if (scope !== 'default' && !/^[\w.-]+\/[\w.-]+$/.test(scope || '')) throw new Error(`scope "${scope}" must be "default" or owner/repo`);
  const cfg = readSkills();
  cfg[scope] = { ...cfg[scope], [key]: value };
  if (value === undefined) { if (!STEP_KEYS.includes(key) && key !== 'axes.extra') throw new Error(`unknown step "${key}"`); delete cfg[scope][key]; }
  if (!Object.keys(cfg[scope]).length) delete cfg[scope];
  writeSkills(cfg);
  return cfg[scope] || {};
}

// Every runner the picker can offer, by where it comes from. Descriptions come from front matter and are display-only.
const front = (file) => {
  let t = '';
  try { t = fs.readFileSync(file, 'utf8').slice(0, 6000); } catch { return ''; }
  const m = /^---\r?\n([^]*?)\r?\n---/.exec(t);
  const d = m && /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/m.exec(m[1]);
  return d ? d[1].replace(/^[|>][-+]?\s*/, '').replace(/\s+/g, ' ').replace(/^(["'])(.*)\1$/, '$2').trim().slice(0, 240) : '';
};
const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };

function pluginItems(dir, source, group) {
  let name = path.basename(dir).replace(/~.*$/, '');
  try { name = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).name || name; } catch { /* no manifest: folder name */ }
  const out = [];
  const add = (n, kind, file, runner) => NAME.test(`${name}:${n}`) && out.push({ source, group: group || `plugin: ${name}`, name: `${name}:${n}`, kind, desc: front(file), runner });
  for (const s of dirs(path.join(dir, 'skills'))) { const f = path.join(dir, 'skills', s, 'SKILL.md'); if (fs.existsSync(f)) add(s, 'skill', f, { use: 'skill', name: `${name}:${s}` }); }
  for (const c of ls(path.join(dir, 'commands')).filter((f) => f.endsWith('.md'))) add(c.slice(0, -3), 'command', path.join(dir, 'commands', c), { use: 'skill', name: `${name}:${c.slice(0, -3)}` });
  const host = harnesses.find((h) => h.host)?.id; // plugin agents run on the harness that hosts this skill
  if (host) for (const a of ls(path.join(dir, 'agents')).filter((f) => f.endsWith('.md'))) add(a.slice(0, -3), 'agent', path.join(dir, 'agents', a), { use: 'provider', harness: host, name: `${name}:${a.slice(0, -3)}` });
  return out;
}

let globalCatalog; // one disk scan per process: render() runs on every record()
function scanGlobal() {
  const home = os.homedir(), claude = path.join(home, '.claude'), out = [];
  const skillDir = (root, source, group, runnerOf) => {
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
  skillDir(path.join(home, '.agents', 'skills'), 'global', '~/.agents/skills', (n, f) => !mine.has(n) && /^[^'"\s]+$/.test(f) && { use: 'brief', path: tilde(f) }); // other harnesses' skills run as a brief
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { /* no plugins */ }
  for (const list of Object.values(installed)) for (const e of list) if (e.scope === 'user' && e.installPath) out.push(...pluginItems(e.installPath, 'global'));
  for (const b of dirs(path.join(claude, 'plugins', 'synced'))) for (const p of dirs(path.join(claude, 'plugins', 'synced', b))) out.push(...pluginItems(path.join(claude, 'plugins', 'synced', b, p), 'global'));
  for (const f of ls(path.join(stateDir(), 'briefs')).filter((f) => f.endsWith('.md'))) {
    const p = path.join(stateDir(), 'briefs', f);
    if (/^[^'"\s]+$/.test(p)) out.push({ source: 'yours', group: tilde(path.join(stateDir(), 'briefs')), name: f, kind: 'brief', desc: front(p), runner: { use: 'brief', path: tilde(p) } });
  }
  return out;
}

// Project skills come from the attached clone's checkout. Picking one for a review lets the repo supply the reviewer;
// a PR that changes it touches .claude/, which is SENSITIVE, so it can never auto-merge.
function scanProject(repo) {
  const clone = projects()[repo]?.path;
  if (!clone) return [];
  const out = [], root = path.join(clone, '.claude', 'skills');
  for (const n of dirs(root)) { const f = path.join(root, n, 'SKILL.md'); if (fs.existsSync(f) && NAME.test(n)) out.push({ source: 'project', group: '.claude/skills', name: n, kind: 'skill', desc: front(f), runner: { use: 'skill', name: n } }); }
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { /* none */ }
  for (const list of Object.values(installed)) for (const e of list) if (['project', 'local'].includes(e.scope) && e.projectPath === clone && e.installPath) out.push(...pluginItems(e.installPath, 'project'));
  return out;
}

export function catalog(repos = []) {
  globalCatalog ??= scanGlobal();
  return { global: globalCatalog, projects: Object.fromEntries(repos.map((r) => [r, scanProject(r)])) };
}

// Everything the Skills sheet needs: raw config (to tell "set here" from "inherited"), resolved plans and the catalog.
export function skillsData(repos = []) {
  try {
    const cfg = readSkills();
    const scopes = [...new Set([...Object.keys(projects()), ...repos, ...Object.keys(cfg)])].filter((s) => s !== 'default').sort();
    return { steps: STEP_KEYS, required: REQUIRED_AXES, config: cfg, scopes,
      plans: Object.fromEntries(['default', ...scopes].map((s) => [s, skills(s === 'default' ? '' : s, cfg)])), catalog: catalog(scopes) };
  } catch (e) { return { error: e.message }; } // a bad skills.json must not break rendering an event that was already appended
}

// `F ui`: the dashboard on a loopback port, where the Skills sheet can save. Pure, so the self-test can drive it.
const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function uiHandle({ method, url, headers = {}, body = '' }, { token, port }) {
  const reply = (status, x) => ({ status, type: 'application/json', body: JSON.stringify(x) });
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(headers.host)) return reply(403, { error: 'unexpected Host header' }); // DNS rebinding
  const u = new URL(url, 'http://local');
  if (method === 'GET' && u.pathname === '/') {
    if (!same(u.searchParams.get('t'), token)) return reply(403, { error: 'open the URL that `F ui` printed' });
    return { status: 200, type: 'text/html; charset=utf-8', body: page({ ui: { token } }) };
  }
  const route = u.pathname.startsWith('/api/') ? u.pathname.slice(4) : u.pathname; // /api/<p> and the original <p> are one route
  if (method === 'GET' && u.pathname.startsWith('/api/')) { // reads: same token; browsers omit Origin on same-origin GETs, so only a foreign one is refused
    if (!same(headers['x-factory-token'], token)) return reply(403, { error: 'missing or wrong token' });
    if (headers.origin !== undefined && !hosts.some((h) => headers.origin === `http://${h}`)) return reply(403, { error: 'cross-origin request' });
    if (route === '/runs') return reply(200, { runs: runsData() });
    const m = route.match(/^\/runs\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!m) return reply(404, { error: 'not found' });
    const [, owner, repo, n] = m; // raw segments: the checks below admit no %-escapes
    if (!LOGIN.test(owner) || !/^[\w.-]{1,100}$/.test(repo) || !/^\d{1,9}$/.test(n)) return reply(400, { error: 'expected /api/runs/<owner>/<repo>/<issue number>' });
    const run = runsData().find((r) => r.id === `${owner}/${repo}#${n}`);
    return run ? reply(200, { run }) : reply(404, { error: `no run ${owner}/${repo}#${n}` });
  }
  if (method === 'POST' && Object.hasOwn(UI_ROUTES, route)) { // every write (and the onboarding read) passes the same checks
    if (!same(headers['x-factory-token'], token)) return reply(403, { error: 'missing or wrong token' });
    if (!hosts.some((h) => headers.origin === `http://${h}`)) return reply(403, { error: 'cross-origin request' });
    if (!/^application\/json\b/.test(headers['content-type'] || '')) return reply(415, { error: 'expected application/json' });
    try {
      const x = JSON.parse(body || '{}');
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('expected a JSON object');
      return reply(200, UI_ROUTES[route](x));
    } catch (e) { return reply(400, { error: e.message }); }
  }
  return reply(404, { error: 'not found' });
}

// Each route calls the same validated function as its CLI command.
const UI_ROUTES = {
  '/skills': ({ scope, step, runner }) => { setSkill(scope, step, runner === null ? undefined : runner); return skillsData(runRepos()); },
  // Records the idea only: repo and issue creation stay in the Claude session, behind its checkpoints. Returns an id, never
  // the idea text, since `next` is pasted into a terminal.
  '/idea': ({ repo, idea, stack }) => { const p = startIdea({ repo, idea, stack }); return { run: p.id, next: `/software-factory new ${p.repo}` }; },
  '/onboard': () => onboardState(),
  '/onboard/sync': ({ repo, path: p }) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(path.join(p, '.git'))) throw new Error('path must be the absolute path of a local clone');
    sync(repo, p);
    return onboardConfig();
  },
  '/onboard/ship': ({ scope, ship }) => { setShip(scope, ship); return onboardConfig(); },
  '/onboard/rule': ({ scope, key, value, reason, until, unset }) => {
    if (typeof key !== 'string') throw new Error('key must be a string');
    if (unset) unsetRule(scope, key, { reason });
    else setRule(scope, key, typeof value === 'string' ? value : JSON.stringify(value), { reason, until: until || undefined });
    return onboardConfig();
  },
  '/onboard/automerge': ({ repo, on }) => { setAutoMerge(repo, on); return onboardConfig(); },
};

export function ui(port = 0) {
  const token = crypto.randomBytes(24).toString('base64url');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let r;
      try { r = uiHandle({ method: req.method, url: req.url, headers: req.headers, body }, { token, port: server.address().port }); } catch (e) { r = { status: 500, type: 'application/json', body: JSON.stringify({ error: e.message }) }; }
      res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
      res.end(r.body);
    });
  });
  server.listen(port, '127.0.0.1', () => console.log(`factory ui: http://127.0.0.1:${server.address().port}/?t=${token}\nOnly this URL can change settings (skills.json, rules, projects). Ctrl-C to stop.`));
  return server;
}

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
const RULES = {
  ci: [(v) => ['required', 'advisory', 'skip'].includes(v), 'required|advisory|skip'],
  'checks.commands': [(v) => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((c) => typeof c === 'string' && c.trim() && c.length <= 300 && !/[\r\n\0]/.test(c)), 'a JSON array of 1-10 one-line commands'],
  diffCap: [(v) => Number.isInteger(v) && v >= 1 && v <= MAX_DIFF, `an integer 1-${MAX_DIFF} (it can only lower the cap)`],
  'project.budgetUsd': [(v) => typeof v === 'number' && v > 0 && v <= PROJECT_BUDGET_USD, `dollars, above 0 and at most ${PROJECT_BUDGET_USD} (it can only lower the cap)`],
  'project.maxIssuesPerSession': [(v) => Number.isInteger(v) && v >= 1 && v <= MAX_ISSUES_PER_SESSION, `an integer 1-${MAX_ISSUES_PER_SESSION} (it can only lower the cap)`],
  'deploy.preview': [(v) => ['required', 'advisory', 'off'].includes(v), 'required|advisory|off (off is the built-in; required adds a merge condition)'],
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
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(log(), JSON.stringify({ ts: new Date().toISOString(), ...e, run: scope, stage: 'rules', status }) + '\n');
  dashboard.render();
}

const checkScope = (scope) => { if (scope !== 'default' && !/^[\w.-]+\/[\w.-]+$/.test(scope || '')) throw new Error(`scope "${scope}" must be "default" or owner/repo`); };

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

// Pinned unattended flags come from the harness that runs the skill (claude-code.mjs: `claude -p`), so F names no harness.
// `share`: how many headless runs spend the remaining budget at once (parallel reviewers). Each gets an equal cut,
// in whole cents rounded down, so together they can't spend more than is left.
export const MIN_SHARE_USD = 0.05;
export function headlessArgs({ share = 1, ...opts } = {}) {
  const h = harnesses.find((x) => x.host && x.headlessArgs);
  if (!h) throw new Error('no host harness with headlessArgs() is registered');
  if (!Number.isInteger(share) || share < 1) throw new Error(`share must be a positive integer (got ${share})`);
  const cents = Math.floor(Number(opts.budget) * 100 + 1e-9); // a spent or invalid budget is left for the harness to refuse
  if (share > 1 && opts.budget != null && cents > 0) {
    const each = Math.floor(cents / share) / 100;
    if (each < MIN_SHARE_USD) throw new Error(`budget share $${each} per reviewer is below $${MIN_SHARE_USD}; escalate instead of running`);
    opts = { ...opts, budget: each };
  }
  return h.headlessArgs(opts);
}

// F, not the payload, says who did the work. Default runners leave events unchanged; a fallback can only downgrade to default.
export function runnerStamp(run, stage, axis, fallback) {
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
  assertReviewOpen(r, axis); // before the catch: a frozen review is refused, not turned into an "invalid" one
  try {
    const p = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n([^]*)\n```$/, '$1'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not a JSON object');
    if (p.axis !== axis) throw new Error(`axis is "${p.axis}", expected "${axis}"`); // a reviewer can't overwrite another axis's cell
    if (!['passed', 'failed'].includes(p.verdict)) throw new Error('verdict must be passed|failed');
    validateReview(run, p, p.verdict);
    return { status: (p.findings || []).some(blocking) ? 'failed' : 'passed', payload: p };
  } catch (e) {
    return { status: 'failed', payload: { axis, verdict: 'failed', findings: [{ severity: 'high', issue: `${INVALID}${e.message}`.slice(0, 300), route: 'build' }] } };
  }
}

const gh = (...args) => execFileSync(io.gh, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

const git = (...args) => execFileSync(io.git, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const adapterCtx = () => ({ gh, git }); // what host and tracker adapters get: the same stubbable gh and git
export const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const projectsFile = () => path.join(stateDir(), 'projects.json');
export const projects = () => { try { return JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); } catch { return {}; } };
const saveProject = (repo, p) => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], path: p, synced: projects()[repo]?.synced } }, null, 2)); };
const wtFile = (run) => path.join(runDir(run), 'worktree.json');
export const wtInfo = (run) => { try { return JSON.parse(fs.readFileSync(wtFile(run), 'utf8')); } catch { return null; } };

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
  const q = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){defaultBranchRef{name} pullRequests(states:OPEN,first:100){nodes{number url title headRefName headRefOid authorAssociation author{login} closingIssuesReferences(first:20){nodes{number}}}} done: pullRequests(states:[MERGED,CLOSED],last:100){nodes{headRefName}}}}';
  const r = JSON.parse(gh('api', 'graphql', '-f', `query=${q}`, '-f', `o=${o}`, '-f', `n=${n}`)).data.repository;
  return { base: r.defaultBranchRef.name, prs: r.pullRequests.nodes, doneBranches: (r.done?.nodes || []).map((x) => x.headRefName) };
}

// branch -> { agents, last, sessions } from each harness's local logs (adapter sessions()). Branch names and file times only, never prompt text.
export function sessionsByBranch(repo, repoPath) {
  const out = {};
  for (const h of harnesses) for (const { branch, id, cwd, last } of h.sessions?.(repoPath, `https://github.com/${repo}.git`) || []) {
    if (!branch || branch === 'HEAD') continue;
    const s = (out[branch] ??= { agents: [], last: '', sessions: [] });
    if (!s.agents.includes(h.id)) s.agents.push(h.id);
    if (last > s.last) s.last = last;
    if (id && !s.sessions.some((x) => x.id === id)) s.sessions.push({ agent: h.id, id, cwd, last });
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

// packages/ship, when it sits next to the factory (the repo layout). Optional: without it F works, and deploy.preview=required escalates.
let SHIP = null;
async function loadShip() {
  const file = path.join(HERE, '..', 'ship', 'ship.mjs');
  if (!fs.existsSync(file)) return null;
  try { const m = await import(pathToFileURL(file).href); await m.ready(); return m; } catch (e) { console.error(`factory: ship harness failed to load: ${e.message}`); return null; }
}
// Records deploy state through record(). A failed lookup is reported in the result, never thrown: it must not break sync or merge.
function shipTrack(pairs) {
  if (!SHIP || !pairs.length) return undefined;
  try { return SHIP.track(pairs, { runs: derive(read()), record }); } catch (e) { return { recorded: [], errors: [{ error: e.message }] }; }
}

// Registers the repo and imports work already in flight: open PRs, plus recent agent sessions on unmerged branches.
// Imported runs are tracked, never driven: decide() always escalates them.
export function sync(repo, repoPath) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error(`repo must look like owner/repo, got "${repo}"`);
  repoPath = path.resolve(repoPath || projects()[repo]?.path || '.');
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], path: repoPath, synced: new Date().toISOString() } }, null, 2));
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
    if (ours(branch) || branch === 'project' || openHeads.has(branch) || done.has(branch) || byBranch.has(branch) || !unmerged.has(branch) || s.last < recent) continue;
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
  const head = new Map(prs.map((p) => [p.url, p.headRefOid])); // deploy state of each in-progress run's PR head (finished runs aren't polled)
  const ship = shipTrack(Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') && r.outcome === 'in-progress' && head.get(r.pr)).map((r) => ({ run: r.id, repo, sha: head.get(r.pr), path: repoPath })));
  dashboard.render();
  return { repo, path: repoPath, added, attached, closed, ...(ship && { ship }) };
}

// Reads CI + diff facts from GitHub so the merge decision never depends on typed-in numbers.
export function facts(r) {
  const { repo, n } = parseRun(r.id);
  const association = gh('api', `repos/${repo}/issues/${n}`, '--jq', '.author_association').trim();
  const autoMerge = projects()[repo]?.autoMerge !== false;
  const policy = rules(repo).policy; // a broken config throws here, so decide/merge fail and the run escalates
  const pv = policy['deploy.preview']?.value, dep = {};
  if (pv && pv !== 'off') { // live, like CI: record the reviewed commit's deploy state now, then decide on what the log says
    shipTrack([{ run: r.id, repo, sha: r.reviewedSha, path: projects()[repo]?.path }]);
    dep.deploys = derive(read())[r.id]?.deploys || [];
  }
  if (!r.pr) return { association, autoMerge, checks: 'none', additions: 0, deletions: 0, files: [], rules: policy, ...dep };
  const diff = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'additions,deletions,files'));
  let checks = 'skipped'; // ci=skip: GitHub CI isn't even read
  if (policy.ci?.value !== 'skip') try {
    const b = JSON.parse(gh('pr', 'checks', r.pr, '-R', repo, '--json', 'bucket')).map((c) => c.bucket);
    checks = !b.length ? 'none' : b.some((x) => x === 'fail' || x === 'cancel') ? 'fail' : b.includes('pending') ? 'pending' : 'pass';
  } catch (e) {
    if (!/no checks reported/i.test(String(e.stderr))) throw e;
    checks = 'none';
  }
  return { association, autoMerge, checks, additions: diff.additions, deletions: diff.deletions, files: diff.files.map((f) => f.path), rules: policy, ...dep };
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
  const ship = shipTrack([{ run, repo, sha, path: projects()[repo]?.path }]), deploys = ship?.recorded.length ? { deploys: ship.recorded } : {}; // production deploy of the merge commit, when a connector reports one
  const ci = rules(repo).policy.ci?.value;
  if (ci === 'skip') return { sha, state: 'skipped', reason: 'rule ci=skip: CI on the base branch is not watched, so it never triggers a revert', ...deploys };
  const runs = JSON.parse(gh('run', 'list', '-R', repo, '--commit', sha, '--json', 'status,conclusion,name,url'));
  const failed = runs.filter((x) => ['failure', 'cancelled', 'timed_out'].includes(x.conclusion)).map((x) => x.url);
  const state = !runs.length ? 'none' : failed.length ? 'fail' : runs.some((x) => x.status !== 'completed') ? 'pending' : 'pass';
  return { sha, state, failed, ...(ci === 'advisory' && { advisory: true }), ...deploys }; // advisory: report red, don't revert on it
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

export const archiveFile = () => path.join(stateDir(), 'archive.jsonl');
const sessionsFile = () => path.join(stateDir(), 'sessions.json');
export const readArchive = () => { try { return fs.readFileSync(archiveFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

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
    const prevDir = io.dir; io.dir = tmp;
    const r = derive(read())[run];
    io.dir = prevDir;
    const last = r?.events.filter((e) => e.stage === 'intake' || e.status === 'split').pop()?.status;
    const got = { passed: 'pass', 'needs-info': 'needs-info', rejected: 'reject', split: 'split' }[last] || 'no-outcome';
    results.push({ fixture: n, expect: fx.expect, got, ok: got === fx.expect });
  }
  return { score: `${results.filter((r) => r.ok).length}/${results.length}`, results };
}

const runRepos = () => [...new Set([...Object.keys(derive(read())), ...readArchive().map((a) => a.id)].map((id) => id.split(/[#:]/)[0]))];

export function render() {
  const out = path.join(stateDir(), 'dashboard.html');
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(out, page()); // never carries a ui token: that exists only in what `F ui` serves
  return out;
}

// The run list the dashboard embeds and GET /api/runs returns: live + archived, linked sessions, worktree path.
export function runsData(events = read()) {
  const live = Object.values(withMeasured(derive(events), events));
  const archived = readArchive().filter((a) => !live.some((r) => r.id === a.id));
  for (const a of archived) for (const c of a.children || []) { const child = live.find((r) => r.id === c); if (child) child.parent = a.id; }
  const runs = [...live, ...archived].sort((a, b) => b.updated.localeCompare(a.updated));
  let links = {};
  try { links = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')); } catch { /* no sync yet */ }
  for (const r of runs) if (links[r.id]) r.sessions = [...(r.sessions || []), ...links[r.id].filter((x) => !(r.sessions || []).some((y) => y.id === x.id))];
  for (const r of runs) { const w = wtInfo(r.id); if (w?.path) r.worktree = w.path; } // the dashboard's "Open in Claude" cwd
  return runs;
}

export function page(extra = {}) {
  const events = read();
  const runs = runsData(events);
  const repoOf = (id) => id.split(/[#:]/)[0];
  const byProject = {};
  for (const p of new Set(runs.map((r) => repoOf(r.id)))) byProject[p] = metrics(runs.filter((r) => repoOf(r.id) === p));
  const ruleData = { rules: {}, ruleHistory: read().filter((e) => e.stage === 'rules').slice(-100) };
  try { const cfg = readSkills(); for (const p of new Set([...Object.keys(byProject), ...Object.keys(projects())])) ruleData.rules[p] = rules(p, cfg); }
  catch (e) { ruleData.rulesError = e.message; } // render runs after every record(): a bad config must not half-fail the event
  let idea = {};
  try { idea = { ideas: ideas(events, Object.fromEntries(runs.map((r) => [r.id, r]))) }; } catch (e) { idea = { ideasError: e.message }; } // never fail the event that triggered the render
  const data = JSON.stringify({ generated: new Date().toISOString(), cap: CAP, costCap: COST_CAP, tokenCap: TOKEN_CAP, projects: Object.keys(projects()), metrics: { all: metrics(runs), byProject }, runs, ...ruleData, skills: skillsData(Object.keys(byProject)),
    harnesses: harnesses.map(({ id, label, install }) => ({ id, label, install })), hooks: hooks(), onboard: readOnboard(), ...idea, ...extra }).replace(/</g, '\\u003c');
  return fs.readFileSync(path.join(HERE, 'dashboard.html'), 'utf8').replace('__FACTORY_DATA__', () => data);
}

// ---- Onboarding: the wizard (dashboard, via `F ui`) and `F onboard`. What spawns CLIs or walks the disk runs only
// when asked for, never in page(), which runs on every record().
const F_CMD = 'node ~/.claude/skills/software-factory/factory.mjs';
const shq = (x) => (/^[\w@%+=:,./~-]+$/.test(String(x)) ? String(x) : "'" + String(x).replace(/'/g, "'\\''") + "'");
const onboardFile = () => path.join(stateDir(), 'onboard.json');
export const SHIP_KINDS = ['web', 'mobile', 'database'];
export const readOnboard = () => { try { return JSON.parse(fs.readFileSync(onboardFile(), 'utf8')); } catch { return {}; } };

// "What you ship" is only stored for now; packages/ship reads it once it exists.
export function setShip(scope, kinds) {
  checkScope(scope);
  if (!Array.isArray(kinds) || !kinds.every((k) => SHIP_KINDS.includes(k))) throw new Error(`ship must be a list of ${SHIP_KINDS.join('|')}`);
  const o = readOnboard();
  o[scope] = { ...o[scope], ship: SHIP_KINDS.filter((k) => kinds.includes(k)) }; // canonical order, so a re-run writes the same file
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(onboardFile() + '.tmp', JSON.stringify(o, null, 2));
  fs.renameSync(onboardFile() + '.tmp', onboardFile());
  dashboard.render();
  return o[scope];
}

// Hooks for parallel work: "Create from an idea" turns on once F has a `new` command; the ship step lists
// packages/ship's connectors once that package exists.
// shortcut: `new` is detected by its CLI case in this file; switch to an exported function once idea-to-app lands.
const SHIP_FILE = path.join(HERE, '..', 'ship', 'ship.mjs');
let hasNew;
const hooks = () => ({ create: (hasNew ??= /^\s+case 'new':/m.test(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'))), ship: fs.existsSync(SHIP_FILE) });

// packages/ship's own connector registry, loaded by the CLI (onboard, ui) through loadShip(). Never a hardcoded provider list.
let SHIP_LIST = null;
const shipConnectors = () => SHIP_LIST;

// The cheap part, returned after every wizard write.
export function onboardConfig() {
  const ps = projects(), scopes = ['default', ...Object.keys(ps)];
  let ruleMap = {}, rulesError;
  try { const cfg = readSkills(); ruleMap = Object.fromEntries(scopes.map((s) => [s, rules(s, cfg)])); } catch (e) { rulesError = e.message; }
  return { projects: ps, ship: readOnboard(), skills: skillsData(Object.keys(ps)), rules: ruleMap, ...(rulesError && { rulesError }) };
}

export function onboardState() {
  const hs = harnesses.map((h) => {
    const d = h.detect() || {};
    return { id: h.id, label: h.label, install: h.install, installed: !!d.installed, version: d.version || null,
      login: d.installed ? h.login() : null, notes: d.installed ? h.notes?.() || [] : [], headless: h.headless?.() || null };
  });
  return { harnesses: hs, repos: discover(), hooks: { ...hooks(), connectors: shipConnectors() }, ...onboardConfig() };
}

export function onboardText(s) {
  const mark = (b) => (b ? '✓' : b === null || b === undefined ? '?' : '✗'), L = [], scopes = ['default', ...Object.keys(s.projects)];
  L.push('1. Local AI');
  for (const h of s.harnesses) {
    L.push(`   ${mark(h.installed)} ${h.label}${h.version ? ' ' + h.version : ''}${h.installed ? '' : `   install: ${h.install}`}`);
    if (h.login) L.push(`     ${mark(h.login.ok)} login: ${h.login.hint}`);
    for (const n of h.notes) L.push(`     ${mark(n.ok)} ${n.label}: ${n.hint}`);
  }
  L.push('', '2. Repo');
  for (const [r, p] of Object.entries(s.projects)) L.push(`   ✓ ${r}  ${p.path}`);
  for (const r of s.repos.filter((r) => !r.attached)) L.push(`   · ${r.repo}   ${F_CMD} sync ${r.repo} ${shq(r.path)}`);
  if (!s.repos.length && !Object.keys(s.projects).length) L.push(`   no GitHub clones found: ${F_CMD} discover <folder>`);
  L.push(`   ${s.hooks.create ? '·' : '-'} Create from an idea: ${s.hooks.create ? `/software-factory new: <idea>  (or ${F_CMD} new "<idea>" --dry-run)` : 'coming soon'}`);
  L.push('', '3. What you ship');
  for (const sc of scopes) L.push(`   ${sc}: ${(s.ship[sc]?.ship || []).join(', ') || 'not chosen'}   ${F_CMD} onboard ship ${sc} web,mobile,database`);
  const c = s.hooks.connectors;
  L.push(`   connectors: ${Array.isArray(c) ? c.map((x) => `${x.label} (${x.kind})`).join(', ') || 'none yet' : c?.error ? 'error: ' + c.error : 'coming soon'}`);
  L.push('', '4. Workflow');
  for (const sc of scopes) {
    const plan = s.skills.plans?.[sc]?.plan || {}, set = Object.entries(plan).filter(([, r]) => r.use !== 'default');
    L.push(`   ${sc}: ${set.map(([k, r]) => `${k}=${r.name || r.harness || r.path}`).join(', ') || 'factory defaults'}`);
  }
  L.push(`   ${F_CMD} skills set <scope> <step> '{"use":"provider","harness":"${s.harnesses[0]?.id || '<harness>'}"}'   (catalog: ${F_CMD} skills catalog)`);
  L.push('', '5. Rules');
  for (const sc of scopes) {
    const pol = Object.entries(s.rules[sc]?.policy || {}).filter(([, x]) => x.scope === sc);
    const am = sc === 'default' ? '' : `   auto-merge ${s.projects[sc]?.autoMerge === false ? 'off' : 'on'}`;
    L.push(`   ${sc}: ${pol.map(([k, x]) => `${k}=${JSON.stringify(x.value)}`).join(', ') || 'built-in'}${am}`);
  }
  L.push(`   ${F_CMD} rules set <scope> ci required|advisory|skip --reason "…"   ·   ${F_CMD} automerge <owner/repo> on|off`);
  L.push('', '6. Start', '   In Claude Code: /software-factory <owner/repo>#<issue>', `   What's ready: ${F_CMD} queue <owner/repo>   ·   Live setup: ${F_CMD} ui`);
  return L.join('\n');
}

// Fixture runs covering every outcome; used by `demo` and `test`.
export function demo() {
  let t = Date.parse('2026-11-20T09:00:00Z');
  const S = { harness: 'claude-code', sessionId: 'demo-session', cwd: '/work/shop' }, MEASURED = ['acme/shop#43', 'acme/shop#45'];
  const ev = (run, stage, status, p = {}) => {
    const e = { ts: new Date((t += 97_000)).toISOString(), ...p, ...(MEASURED.includes(run) && stage !== 'ship' ? S : {}), run, stage, status };
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(log(), JSON.stringify(e) + '\n');
  };
  const intake = (run, title, n, association = 'OWNER') =>
    ev(run, 'intake', 'started', { title, url: `https://github.com/acme/shop/issues/${n}`, author: association === 'OWNER' ? 'acme' : 'drive-by', association });
  const pass = (run, axes, usage) => axes.forEach((axis, i) => ev(run, 'review', 'passed', { axis, findings: [], ...(usage ? { usage: { input: 9 + i, output: 2400 + 300 * i, cacheRead: 38000, cacheWrite: 9000 }, model: 'claude-sonnet-5-5', tokens: 49409 + 301 * i } : {}) }));
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
  pass(R, ['code', 'security', 'ux', 'ui'], true); // reported: copied from each subagent's usage
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
  // Deploy state, as a packages/ship connector records it: a preview per PR head, production for a merge.
  const dep = (run, env, state, status, sha, url, detail) => ev(run, 'ship', status, { connector: 'demo-host', kind: 'web-deploy', env, state, url, sha, at: new Date(t).toISOString(), detail, creator: 'deploy-bot' });
  dep('acme/shop#51', 'preview', 'ready', 'passed', sha, 'https://shop-pr-95.preview.example', 'Deployment has completed');
  dep('acme/shop#51', 'production', 'ready', 'passed', '9a7c41d2e0b8', 'https://shop.acme.dev', 'Deployment has completed');
  dep('acme/shop#45', 'preview', 'ready', 'passed', 'c0ffee12ab34', 'https://shop-pr-92.preview.example', 'Deployment has completed');
  dep('acme/shop#44', 'preview', 'error', 'failed', 'd15ea5e0b1a2', 'https://shop-pr-91.preview.example', 'Build failed: Type error in lib/auth/github.ts');
  demoTranscripts(read().filter((e) => e.sessionId === S.sessionId));
  return dashboard.render();
}

// Fake Claude Code transcripts for the demo session: an orchestrator message before each event, one subagent per review axis.
function demoTranscripts(events) {
  io.projects = path.join(stateDir(), 'claude-projects');
  const dir = path.join(io.projects, '-work-shop'), subs = path.join(dir, 'demo-session', 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  const SIZE = { intake: [900, 5000], spec: [2600, 2500], build: [3200, 6000], review: [1200, 800], gate: [300, 200], approve: [700, 300] };
  let n = 0;
  const line = (ts, model, out, read, write) => JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), sessionId: 'demo-session',
    message: { id: `msg_demo_${n++}`, model, usage: { input_tokens: 6, output_tokens: out, cache_read_input_tokens: read, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write } } } }) + '\n';
  let main = '', ctx = 30000;
  for (const e of events) {
    const at = Date.parse(e.ts), [out, write] = SIZE[e.stage];
    ctx += write;
    main += line(at - 40_000, 'claude-opus-5-5', out, ctx, write);
    if (e.stage === 'build' && e.status === 'passed') main += line(at - 20_000, 'claude-opus-5-5', out * 2, ctx, write);
    if (e.stage === 'review' && e.status === 'started') {
      for (const [j, axis] of [...e.axes, 'verifier'].entries()) {
        const f = path.join(subs, `agent-${n}`), model = ['ui', 'seo', 'docs', 'verifier'].includes(axis) ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
        fs.writeFileSync(f + '.meta.json', JSON.stringify({ description: axis === 'verifier' ? 'verifier acme/shop' : `${axis} review acme/shop` }));
        fs.writeFileSync(f + '.jsonl', [1, 2, 3].map((k) => line(at + 5_000 + k * 9_000, model, 700 + k * 120 + j * 90, (11000 - j * 1500) * k, k === 1 ? 6000 : 1500)).join(''));
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'demo-session.jsonl'), main);
}

async function test() {
  delete process.env.CLAUDE_CODE_SESSION_ID; // in-process record() would stamp the outer session's id
  process.env.FACTORY_TEST = '1'; // inherited by every F the tests spawn: none may touch the real state dir
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
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
  for (const f of ['.mcp.json', 'pkg/.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/pre.sh', '.claude/agents/x.md']) // claude -p runs these untrusted
    assert.equal(decide(ok, { ...facts, files: [f, 'src/a.test.ts'] }).action, 'escalate', f);
  assert.equal(decide(ok, { ...facts, files: ['docs/mcp.json.md', 'src/a.test.ts'] }).action, 'merge');
  // Headless runner flags: pinned, never --bare, read-only for reviews, budget in whole cents, a spent budget refuses.
  const ha = headlessArgs({ budget: 3.456, write: true });
  assert.deepEqual(ha.slice(ha.indexOf('--permission-mode'), ha.indexOf('--permission-mode') + 4), ['--permission-mode', 'auto', '--permission-prompts', 'none']);
  for (const f of [['--output-format', 'json'], ['--max-budget-usd', '3.45'], ['--setting-sources', 'user']]) assert.equal(ha[ha.indexOf(f[0]) + 1], f[1]);
  assert.ok(ha.includes('--strict-mcp-config') && !ha.includes('--bare') && !ha.includes('--json-schema') && !ha.includes('--allowedTools'));
  const ro = headlessArgs(); // verifier, intake, spec: read-only by default
  assert.equal(ro[ro.indexOf('--permission-mode') + 1], 'manual');
  assert.deepEqual(ro.slice(ro.indexOf('--allowedTools')), ['--allowedTools', 'Bash(git diff:*)', 'Bash(git log:*)', 'Read', 'Grep', 'Glob']);
  assert.ok(!headlessArgs().includes('--max-budget-usd')); // unknown budget: no flag
  const hr = headlessArgs({ schema: { type: 'object' } });
  assert.equal(hr[hr.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.equal(hr[hr.indexOf('--permission-mode') + 1], 'manual');
  for (const b of [0, -1, 0.004, NaN, 'x']) assert.throws(() => headlessArgs({ budget: b }), /no run budget left/);
  // Parallel reviewers split the remaining budget, whole cents rounded down; a share under the minimum refuses.
  const usdOf = (o) => { const x = headlessArgs(o); return x[x.indexOf('--max-budget-usd') + 1]; };
  assert.equal(usdOf({ budget: 5, share: 6 }), '0.83');
  assert.deepEqual(headlessArgs({ budget: 3.456, share: 1 }), headlessArgs({ budget: 3.456 }));
  assert.equal(usdOf({ budget: 0.58, share: 2 }), '0.29'); // no float drift (0.29 * 100 is 28.999…)
  assert.equal(usdOf({ budget: 0.3, share: 6 }), '0.05'); // exactly the minimum still runs
  assert.throws(() => headlessArgs({ budget: 0.29, share: 6 }), /budget share \$0\.04 per reviewer is below \$0\.05/);
  for (const n of [0, -2, 1.5, NaN, '3']) assert.throws(() => headlessArgs({ budget: 5, share: n }), /share must be a positive integer/);
  assert.ok(!headlessArgs({ share: 6 }).includes('--max-budget-usd')); // unknown budget: still no flag
  assert.throws(() => headlessArgs({ budget: 0, share: 6 }), /no run budget left/);
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
  assert.deepEqual(runs['acme/shop#51'].deploys.map((d) => [d.env, d.state]), [['preview', 'ready'], ['production', 'ready']]); // latest per connector and env
  assert.deepEqual([runs['acme/shop#44'].outcome, runs['acme/shop#44'].stage, runs['acme/shop#44'].url], ['escalated', 'approve', 'https://github.com/acme/shop/issues/44']); // deploys move nothing
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
  assert.equal(pre['acme/shop#44'].burn.byAxis.security.tokens, 49710); // reported per axis
  assert.equal(getRun('acme/shop#43').burn.measured, true);
  assert.equal(getRun('acme/shop#44').burn.measured, false);
  assert.deepEqual(archive(0), { archived: 6 }); // 41 rejected, 43 merged, 44 escalated, 46 split, 50 + 51 merged
  assert.equal(readArchive().find((a) => a.id === 'acme/shop#43').burn.measured, true); // survives losing its events
  assert.deepEqual(Object.keys(derive(read())).sort(), ['acme/shop#42', 'acme/shop#45', 'acme/shop#47', 'acme/shop#48', 'acme/shop#49', 'eval/golden#4']);
  assert.equal(read().filter((e) => e.stage === 'rules').length, 5); // the rule audit trail survives archiving
  const page = fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8');
  assert.match(page, /"merged":3,/); // metrics.all counts the archived merges
  assert.equal(page.split('__FACTORY_DATA__').length, 1);
  assert.match(page, /"ruleHistory":\[\{[^\]]*"key":"ci","value":"skip"/);
  assert.match(page, /"id":"acme\/shop#47"[^]*?"parent":"acme\/shop#46"/); // parent survives archiving
  fs.mkdirSync(runDir('acme/shop#45'), { recursive: true });
  fs.writeFileSync(wtFile('acme/shop#45'), JSON.stringify({ path: '/w/shop-45', branch: 'factory/issue-45' }));
  assert.match(fs.readFileSync(render(), 'utf8'), /"id":"acme\/shop#45"[^]*?"worktree":"\/w\/shop-45"/); // the "Open in Claude" cwd
  assert.deepEqual(axesFor(['lib/x.ts']), ['code', 'security']);
  assert.deepEqual(axesFor(['app/blog/page.tsx']), ['code', 'security', 'ux', 'ui', 'seo']);
  // Dashboard must not break out of its JSON script tag.
  record('evil/x#1', 'intake', 'started', { title: '</script><script>alert(1)</script>' });
  const html = fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8');
  assert.ok(!html.includes('</script><script>alert'));
  discoverTest();
  usageTest();
  cliTest();
  await (await import('./test/project.mjs')).projectTest({ uiHandle, read, project }); // idea-to-app: new, issues create, queue, loop, adapter contracts
  console.log(`ok - all checks passed (${io.dir})`);
}

// Measured burn from a fake transcript: attribution windows, dedupe, subagent axes, unknown model, cache, bad usage.
function usageTest() {
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-usage-'));
  io.projects = path.join(io.dir, 'projects');
  const sid = 'sess-u', R = 'acme/u#1', t0 = Date.parse('2026-11-21T10:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const P = 'acme/u#0', I = 'acme/u:dev/x'; // an earlier in-progress run, and an imported run synced after R ended
  const evs = [[-80, 'intake', 'started', {}, P], [0, 'intake', 'started'], [100, 'intake', 'passed'], [200, 'spec', 'passed'], [300, 'build', 'started'], [400, 'build', 'passed'],
    [500, 'review', 'started', { axes: ['code'] }], [600, 'review', 'passed', { axis: 'code', findings: [], tokens: 5000 }], [700, 'gate', 'passed'], [800, 'approve', 'escalated'],
    [850, 'intake', 'started', { imported: true }, I], [850, 'intake', 'passed', {}, I], [850, 'build', 'started', {}, I]];
  fs.writeFileSync(log(), evs.map(([s, stage, status, p, run = R]) => JSON.stringify({ ts: at(s), ...p, harness: 'claude-code', sessionId: sid, cwd: '/w/u', run, stage, status })).join('\n') + '\n');
  const u = (input, output, read = 0, w1 = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 } });
  const msg = (s, id, model, usage) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { id, model, content: [{ type: 'text', text: 'secret prompt' }], usage } }) + '\n';
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const main = path.join(io.projects, '-w-u', `${sid}.jsonl`), subs = path.join(io.projects, '-w-u', sid, 'subagents');
  put(main, [
    msg(-300, 'mx', 'claude-opus-5-5', u(4242, 0)), // before the session's first event: not factory work
    msg(-50, 'm0', 'claude-opus-5-5', u(1000, 0)), // after P's "intake started": P
    msg(50, 'm1', 'claude-opus-5-5', u(1_000_000, 0)), // after "intake started": intake, $4
    msg(150, 'm2', 'claude-opus-5-5', u(0, 100_000)), // intake passed -> spec passed: spec, $2
    msg(250, 'm3', 'claude-opus-5-5', u(0, 0, 1_000_000, 1_000_000)), // spec passed -> build started: build, $0.20 + $8
    msg(350, 'm4', 'claude-mystery-9', u(500, 500)), // unknown model: tokens, no cost
    msg(350, 'm4', 'claude-mystery-9', u(500, 500)), // streamed duplicate
    msg(360, 'm5', 'claude-opus-5-5', { ...u(0, 0), iterations: [{ type: 'message' }, { type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 100_000 }] }), // $0.80 of Fable
    msg(900, 'm6', 'claude-opus-5-5', u(7777, 0)), // after the imported run's "build started": not factory work
    '{"type":"user","message":{"content":"secret prompt","usage":1}}\n',
    '{"type":"assistant","usage":', // half-written line
  ].join(''));
  put(path.join(subs, 'agent-a.meta.json'), '{"description":"Code review acme/u#1"}');
  put(path.join(subs, 'agent-a.jsonl'), msg(520, 's1', 'claude-sonnet-5-5', u(0, 100_000)) + msg(650, 's2', 'claude-sonnet-5-5', u(100_000, 0))); // whole file: review
  put(path.join(subs, 'agent-b.meta.json'), '{"description":"Verify blocking findings"}');
  put(path.join(subs, 'agent-b.jsonl'), msg(560, 'v1', 'claude-sonnet-5-5', u(0, 10_000)));
  put(path.join(subs, 'agent-c.jsonl'), msg(570, 'o1', 'claude-sonnet-5-5', u(10_000, 0))); // no meta: "other"
  const b = getRun(R).burn;
  assert.equal(b.measured, true);
  assert.deepEqual(Object.fromEntries(Object.entries(b.byStage).map(([k, c]) => [k, [c.tokens, c.costUsd]])),
    { intake: [1_000_000, 4], spec: [100_000, 2], build: [2_101_000, 9], review: [220_000, 1.32] });
  assert.deepEqual([b.total.tokens, b.total.costUsd, b.total.cacheRead, b.total.unpriced], [3_421_000, 16.32, 1_000_000, 1000]);
  assert.deepEqual(Object.fromEntries(Object.entries(b.byIteration).map(([k, c]) => [k, c.tokens])), { 0: 1_100_000, 1: 2_321_000 });
  assert.deepEqual(Object.fromEntries(Object.entries(b.byAxis).map(([k, c]) => [k, c.tokens])), { code: 200_000, verifier: 10_000, other: 10_000 });
  assert.equal(b.reported.tokens, 5000);
  assert.equal(getRun(P).burn.total.tokens, 1000);
  assert.equal(getRun(I).burn, undefined);
  assert.ok(!fs.readFileSync(usageFile(), 'utf8').includes('secret prompt'));
  const facts = { checks: 'pass', additions: 1, deletions: 0, files: ['a.md'] };
  assert.match(decide({ ...getRun(R), association: 'OWNER', pr: 'x' }, facts).reasons.join(), /budget exceeded \(\$16\.32, .* measured\)/);
  // Appended lines are read incrementally; a deleted transcript keeps its measured rows.
  fs.appendFileSync(main, '{"type":"assistant","usage":1}\n' + msg(380, 'm7', 'claude-opus-5-5', u(0, 50_000)));
  assert.equal(getRun(R).burn.byStage.build.costUsd, 10);
  assert.equal(costOf('claude-fable-5-2', [0, 0, 1e6, 0, 0]), 0.2); // Fable cache reads list at $0.20/MTok (#15)
  assert.equal(costOf('claude-fable-5-2', [1e6, 1e6, 1e6, 1e6, 1e6]).toFixed(2), '74.20'); // 8 + 40 + 0.2 + 10 + 16
  fs.rmSync(main);
  assert.equal(getRun(R).burn.total.tokens, 3_471_000);
  // Caps: measured dollars win over tokens; without a price, cache reads don't count toward the token cap.
  const m = (tokens, cacheRead, costUsd) => budget({ burn: { measured: true, total: { tokens, cacheRead, costUsd } } }).over;
  assert.equal(m(9e6, 8.9e6, 1), false);
  assert.equal(m(5e6, 1e6, null), true);
  assert.equal(m(5e6, 4.5e6, null), false);
  // Usage payloads are validated; tokens becomes their sum.
  assert.equal(record(R, 'build', 'passed', { usage: { input: 10, output: 5 }, model: 'claude-opus-5-5' }).tokens, 15);
  for (const [p, re] of [[{ usage: { input: -1 } }, /non-negative integer/], [{ usage: { input: 1.5 } }, /non-negative integer/], [{ usage: { prompt: 'x' } }, /unknown fields: prompt/],
    [{ usage: [1] }, /must be an object/], [{ model: 'x'.repeat(65) }, /short model id/], [{ model: 'a b' }, /short model id/], [{ tokens: '9' }, /tokens must be/]]) assert.throws(() => record(R, 'build', 'passed', p), re);
  record(R, 'review', 'passed', { role: 'verifier', tokens: 10, model: 'claude-sonnet-5-5' });
  assert.throws(() => record(R, 'review', 'passed', { role: 'judge' }), /role must be/);
  assert.throws(() => record(R, 'review', 'passed', { role: 'verifier', findings: [] }), /unknown fields: findings/);
  assert.equal(derive(read())[R].burn.byAxis.verifier.tokens, 10);
  // Archiving R drops its events; its stubs keep its messages from falling to P, the session's earlier run.
  assert.equal(archive(0).archived, 1);
  assert.equal(getRun(P).burn.total.tokens, 1000);
  assert.equal(getRun(R).burn.total.tokens, 3_471_000); // from the archive summary
  io.projects = null;
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
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cli-'));
  const stub = path.join(HERE, 'test', 'gh-stub.mjs');
  const RUN = 'acme/shop#7';
  const cli = (args, input, env = {}) => execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args],
    { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: stub, ...env } });
  // FACTORY_TEST: with no FACTORY_DIR, F refuses the home state dir (here a temp HOME's) for reads and writes alike (#20)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-home-')), real = { HOME: home, FACTORY_TEST: '1', FACTORY_DIR: '' };
  for (const args of [['rules', 'set', 'acme/x', 'ci', 'skip', '--reason', 'x'], ['skills', 'set', 'acme/x', 'spec', '{"use":"default"}'], ['render'], ['event', 'acme/x#1', 'intake', 'rejected'], ['new', 'an app', '--name', 'acme/x', '--dry-run']])
    assert.throws(() => cli(args, '', real), /FACTORY_TEST is set: refusing the real state dir/, args.join(' '));
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'factory')));
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
  cli(['review', RUN, 'code'], '{"axis":"code","verdict":"passed","findings":[]}');
  // Says "passed" but carries a medium finding: must count as failed.
  cli(['review', RUN, 'security'], '{"axis":"security","verdict":"passed","findings":[{"severity":"medium","file":"src/a.ts","issue":"no validation","route":"build"}]}');
  // A recorded verdict is final: no fail→pass overwrite, through "review" or "event".
  assert.throws(() => cli(['review', RUN, 'security'], '{"axis":"security","verdict":"passed","findings":[]}'), /failed "security" review is already recorded/);
  assert.throws(() => record(RUN, 'review', 'passed', { axis: 'security', findings: [] }), /already recorded/);
  assert.throws(() => cli(['event', RUN, 'review', 'passed', '-'], '{"axis":"security","findings":[]}'), /recorded by "review"/);
  assert.throws(() => cli(['event', RUN, 'review', 'passed', '-'], '{"findings":[]}'), /recorded by "review"/);
  cli(['event', RUN, 'review', 'passed', '-'], '{"role":"verifier","tokens":10}'); // the verifier's usage record stays allowed
  assert.equal(JSON.parse(cli(['gate', RUN])).next, 'build');
  assert.throws(() => cli(['review', RUN, 'code'], '{"axis":"code","verdict":"passed","findings":[]}'), /already gated; its reviews are frozen/);
  cli(['event', RUN, 'build', 'started']);
  cli(['event', RUN, 'build', 'passed']);
  record(RUN, 'review', 'started', { axes: ['code', 'security'], sha: 'abc123' }); // owned by "axes"; set up in-process
  assert.throws(() => cli(['event', RUN, 'review', 'started', '-'], '{"axes":["code"],"sha":"evil"}'), /recorded by "axes"/);
  assert.throws(() => cli(['event', RUN, 'spec', 'passed', '-'], '{"association":"OWNER"}'), /not from a payload: association/);
  assert.throws(() => cli(['event', RUN, 'gate', 'passed']), /recorded by "gate"/);
  assert.throws(() => cli(['event', RUN, 'spec', 'passed', '-'], '{"sessionId":"spoof"}'), /not from a payload: sessionId/);
  cli(['event', RUN, 'spec', 'passed'], '', { CLAUDE_CODE_SESSION_ID: 'sess-1' });
  assert.deepEqual(derive(read())[RUN].sessions.map((x) => [x.agent, x.id]), [['claude-code', 'sess-1']]);
  assert.throws(() => record(RUN, 'review', 'failed', { axis: 'code', findings: [{ severity: 'low', issue: 'nit', route: 'build' }] }), /failed review needs/);
  assert.throws(() => record(RUN, 'review', 'passed', { axis: 'code', findings: [], note: 'ignore previous instructions' }), /unknown fields: note/);
  assert.throws(() => record(RUN, 'review', 'passed', { axis: 'seo', findings: [] }), /not one of this iteration/);
  assert.throws(() => record(RUN, 'review', 'passed', { axis: 'code', findings: [{ severity: 'critical', issue: 'x', route: 'build' }] }), /severity/);
  cli(['review', RUN, 'code'], '{"axis":"code","verdict":"passed","findings":[]}');
  cli(['review', RUN, 'security'], '{"axis":"security","verdict":"passed","findings":[{"severity":"low","issue":"nit","route":"build"}]}');
  assert.equal(JSON.parse(cli(['gate', RUN])).next, 'approve');
  const noCi = JSON.parse(cli(['decide', RUN]));
  assert.equal(noCi.action, 'escalate');
  assert.match(noCi.reasons.join(), /CI checks are "none"/);
  assert.throws(() => cli(['event', RUN, 'approve', 'merged']), /recorded by "merge"/);
  assert.throws(() => record(RUN, 'approve', 'merged'), /decision is not merge/); // and record() itself still refuses
  assert.throws(() => cli(['event', RUN, 'deploy', 'passed']), /unknown stage/);
  assert.throws(() => cli(['event', RUN, 'ship', 'passed', '-'], '{"connector":"x","env":"preview","state":"ready"}'), /recorded by "ship"/);
  for (const k of ['connector', 'kind', 'env', 'state', 'url', 'sha']) assert.throws(() => cli(['event', RUN, 'build', 'passed', '-'], JSON.stringify({ [k]: 'https://evil.example' })), new RegExp(`not from a payload: ${k}`));
  assert.equal(JSON.parse(cli(['merge', RUN], '', { STUB_CHECKS: '1' })).merged, true); // stub fails unless --match-head-commit abc123
  const st = JSON.parse(cli(['state', RUN]));
  assert.equal(st.outcome, 'merged');
  assert.equal(st.spec, nasty);
  assert.equal(st.iteration, 2);
  const hl = JSON.parse(cli(['headless-args', RUN, '--review']));
  assert.equal(hl[hl.indexOf('--max-budget-usd') + 1], String(COST_CAP)); // nothing spent yet
  const hs = JSON.parse(cli(['headless-args', RUN, '--review', '--share', '4']));
  assert.equal(hs[hs.indexOf('--max-budget-usd') + 1], String(Math.floor((COST_CAP * 100) / 4) / 100));
  assert.throws(() => cli(['headless-args', RUN, '--share', 'x']), /share must be a positive integer/);
  assert.deepEqual(JSON.parse(hl[hl.indexOf('--json-schema') + 1]), JSON.parse(fs.readFileSync(path.join(HERE, 'references', 'review.schema.json'), 'utf8')));
  assert.ok(hl.every((a) => !a.includes("'"))); // SKILL.md single-quotes every element
  assert.equal((x => x[x.indexOf('--permission-mode') + 1])(JSON.parse(cli(['headless-args', RUN, '--write']))), 'auto');
  record('acme/hl#1', 'intake', 'started', { imported: true });
  assert.throws(() => cli(['headless-args', 'acme/hl#1']), /imported/);
  syncTest(cli);
  worktreeTest(cli);
  harnessTest(cli);
  onboardTest(cli);
  rulesTest(cli);
  skillsTest(cli); // last: it ends by corrupting skills.json
}

// The shared harness contract, run against every adapter in the registry with its stub binary from test/bin; then a fake
// third harness, added as one file in a temp registry, flows through the real CLI with no core change.
function harnessTest(cli) {
  const bin = path.join(HERE, 'test', 'bin'), node = path.dirname(process.execPath), empty = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-nobin-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-hhome-'));
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, STUB_LOGGED_OUT: process.env.STUB_LOGGED_OUT };
  const withEnv = (env, fn) => { Object.assign(process.env, env); try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); } };
  const files = ls(path.join(HERE, 'harnesses')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && f !== 'index.mjs').sort();
  assert.deepEqual(harnesses.map((h) => h.id + '.mjs'), files); // auto-loaded, template skipped, id = file name
  for (const h of harnesses) {
    const at = (m) => `${h.id}: ${m}`;
    withEnv({ PATH: `${bin}:${node}`, HOME: home }, () => {
      const d = h.detect();
      assert.equal(d.installed, true, at('needs a stub binary in test/bin'));
      assert.match(d.version, /^\d+\.\d+/, at('version'));
      const l = h.login();
      assert.deepEqual([l.ok, typeof l.hint], [true, 'string'], at('login'));
      for (const t of h.providerTools?.() || []) {
        assert.ok(typeof t.name === 'string' && typeof t.desc === 'string', at('tool needs name and desc'));
        checkRunner({ use: 'provider', harness: h.id, ...(t.tool !== undefined && { name: t.tool }) }, at(t.name));
      }
      assert.deepEqual(h.sessions?.('/no/such/clone', 'https://github.com/acme/none.git') || [], [], at('sessions on an empty HOME'));
      for (const n of h.notes?.() || []) assert.ok(typeof n.label === 'string' && [true, false, null].includes(n.ok) && typeof n.hint === 'string', at('note shape'));
      const hl = h.headless?.();
      if (hl) assert.ok(typeof hl.cmd === 'string' && Array.isArray(hl.args), at('headless shape'));
    });
    withEnv({ PATH: `${bin}:${node}`, STUB_LOGGED_OUT: '1' }, () => {
      const l = h.login();
      assert.equal(l.ok, false, at('logged out'));
      assert.ok(l.hint.length > 0, at('a logged-out hint is the login command'));
    });
    withEnv({ PATH: empty }, () => { // not installed: no throw, nothing claimed
      assert.deepEqual(h.detect(), { installed: false, version: null }, at('missing binary'));
      assert.equal(h.login().ok, false, at('login without binary'));
    });
  }
  // A third harness: one file plus its stub binary, in a temp registry dir next to copies of the real adapters.
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-reg-')), fbin = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fbin-'));
  for (const f of ls(path.join(HERE, 'harnesses')).filter((f) => f !== 'index.mjs')) fs.copyFileSync(path.join(HERE, 'harnesses', f), path.join(reg, f));
  const tpl = fs.readFileSync(path.join(HERE, 'harnesses', '_template.mjs'), 'utf8');
  fs.writeFileSync(path.join(reg, 'fake-agent.mjs'), tpl.replaceAll('my-agent', 'fake-agent').replaceAll('My Agent', 'Fake Agent')
    .replace('current: () => null', 'current: () => process.env.FAKE_SESSION || null')
    .replace('sessions: (repoPath, remoteUrl) => []', "sessions: (repoPath, remoteUrl) => remoteUrl.endsWith('/acme/app.git') ? [{ branch: 'dev/feat-a', id: 'fk-1', cwd: repoPath, last: new Date().toISOString() }] : []"));
  fs.writeFileSync(path.join(fbin, 'fake-agent'), "#!/usr/bin/env node\nconst a = process.argv.slice(2).join(' ');\nif (a === '--version') console.log('fake-agent 0.0.1');\nelse if (a === 'auth status') console.log('ok');\nelse process.exit(2);\n", { mode: 0o755 });
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fake-'));
  const env = { FACTORY_DIR: fdir, FACTORY_HARNESSES: reg, PATH: `${fbin}:${bin}:${node}`, HOME: home, FACTORY_GIT: path.join(HERE, 'test', 'git-stub.mjs') };
  const st = JSON.parse(cli(['onboard', '--json'], '', env));
  assert.deepEqual(st.harnesses.map((h) => [h.id, h.installed, h.login?.ok]), [['claude-code', true, true], ['codex', true, true], ['fake-agent', true, true]]);
  assert.match(cli(['onboard'], '', env), /✓ Fake Agent 0\.0\.1/);
  assert.ok(st.hooks.ship && st.hooks.connectors.some((c) => c.id === 'github-deployments' && c.kind === 'web-deploy'), 'ship connectors come from packages/ship\'s registry');
  assert.deepEqual(JSON.parse(cli(['skills', 'catalog'], '', env)).global.find((e) => e.group === 'Fake Agent').runner, { use: 'provider', harness: 'fake-agent' });
  assert.throws(() => cli(['skills', 'set', 'acme/fk', 'build', '{"use":"provider","harness":"fake-agent"}'], '', { FACTORY_DIR: fdir }), /claude-code\|codex"/); // unknown without its file
  assert.equal(JSON.parse(cli(['skills', 'set', 'acme/fk', 'build', '{"use":"provider","harness":"fake-agent"}'], '', env)).build.harness, 'fake-agent');
  cli(['sync', 'acme/app', '/work/app'], '', env);
  assert.equal(derive(JSON.parse(`[${fs.readFileSync(path.join(fdir, 'events.jsonl'), 'utf8').trim().split('\n').join(',')}]`))['acme/app#10'].source, 'fake-agent');
  cli(['event', 'acme/app#10', 'spec', 'passed'], '', { ...env, FAKE_SESSION: 'fs-1' });
  assert.deepEqual(JSON.parse(cli(['state', 'acme/app#10'], '', env)).sessions.map((x) => [x.agent, x.id]), [['fake-agent', 'fs-1']]);
  cli(['event', 'acme/fk#2', 'spec', 'passed'], '', env);
  assert.match(JSON.parse(cli(['risk', 'acme/fk#2', '.fake-agent/rules.md'], '', env)).reasons.join(), /sensitive paths: \.fake-agent\/rules\.md/); // its configDirs join the sensitive paths
}

// Onboarding endpoints: the same checks as /skills, the same validated functions as the CLI, and a re-run that changes nothing.
function onboardTest(cli) {
  const prevDir = io.dir, prev = { GH: io.gh, GIT: io.git, PATH: process.env.PATH, HOME: process.env.HOME };
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-onboard-'));
  const home = path.join(io.dir, 'home'), clone = path.join(home, 'Development', 'app');
  fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
  fs.writeFileSync(path.join(clone, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/app.git\n');
  io.gh = path.join(HERE, 'test', 'gh-stub.mjs'); io.git = path.join(HERE, 'test', 'git-stub.mjs');
  Object.assign(process.env, { PATH: `${path.join(HERE, 'test', 'bin')}:${path.dirname(process.execPath)}`, HOME: home });
  try {
    const tok = 'o'.repeat(32), ctx = { token: tok, port: 4343 }, H = { host: 'localhost:4343', origin: 'http://localhost:4343', 'content-type': 'application/json', 'x-factory-token': tok };
    const post = (url, body, h = {}) => uiHandle({ method: 'POST', url, headers: { ...H, ...h }, body: JSON.stringify(body) }, ctx);
    const err = (url, body) => { const r = post(url, body); assert.equal(r.status, 400, r.body); return JSON.parse(r.body).error; };
    const ok = (url, body) => { const r = post(url, body); assert.equal(r.status, 200, `${url}: ${r.body}`); return JSON.parse(r.body); };
    for (const url of ['/onboard', '/onboard/sync', '/onboard/ship', '/onboard/rule', '/onboard/automerge'].flatMap((u) => [u, '/api' + u])) {
      assert.equal(post(url, {}, { 'x-factory-token': 'x'.repeat(32) }).status, 403);
      assert.equal(post(url, {}, { origin: 'http://evil.test' }).status, 403);
      assert.equal(post(url, {}, { host: 'evil.test:4343' }).status, 403);
      assert.equal(post(url, {}, { 'content-type': 'text/plain' }).status, 415);
    }
    assert.equal(uiHandle({ method: 'GET', url: '/onboard', headers: H }, ctx).status, 404);
    assert.equal(post('/onboard/__proto__', {}).status, 404);
    assert.equal(uiHandle({ method: 'POST', url: '/onboard', headers: H, body: '[]' }, ctx).status, 400);
    assert.equal(post('/api/onboard/__proto__', {}).status, 404);
    assert.deepEqual(ok('/api/onboard', {}), ok('/onboard', {}));
    const s = ok('/onboard', {});
    assert.deepEqual(s.harnesses.map((h) => [h.id, h.installed, h.login.ok]), [['claude-code', true, true], ['codex', true, true]]);
    assert.deepEqual(s.repos.map((r) => [r.repo, r.path, r.attached]), [['acme/app', clone, false]]);
    assert.deepEqual([s.hooks.create, s.hooks.connectors], [hooks().create, null]); // connectors are listed only when the CLI loaded packages/ship (F onboard, F ui)
    // Writes: invalid input is refused and changes nothing.
    assert.match(err('/onboard/sync', { repo: 'acme/app', path: 'Development/app' }), /absolute path of a local clone/);
    assert.match(err('/onboard/sync', { repo: 'acme/app', path: home }), /local clone/);
    assert.match(err('/onboard/sync', { repo: 'acme', path: clone }), /owner\/repo/);
    assert.match(err('/onboard/ship', { scope: 'acme/app', ship: ['web', 'desktop'] }), /web\|mobile\|database/);
    assert.match(err('/onboard/ship', { scope: '__proto__', ship: [] }), /scope/);
    assert.match(err('/onboard/rule', { scope: 'acme/app', key: 'ci', value: 'skip' }), /needs a reason/);
    assert.match(err('/onboard/rule', { scope: '__proto__', key: 'ci', value: 'skip', reason: 'x' }), /scope "__proto__"/);
    assert.match(err('/onboard/rule', { scope: 'acme/app', key: 'trusted', value: '[]', reason: 'x' }), /unknown rule/);
    assert.match(err('/onboard/automerge', { repo: 'acme/app', on: false }), /not attached/);
    assert.deepEqual([fs.existsSync(path.join(io.dir, 'skills.json')), fs.existsSync(path.join(io.dir, 'onboard.json')), read().length], [false, false, 0]);
    // The wizard's happy path, then the same again.
    const run = () => {
      ok('/onboard/sync', { repo: 'acme/app', path: clone });
      ok('/onboard/ship', { scope: 'acme/app', ship: ['database', 'web', 'web'] });
      ok('/onboard/rule', { scope: 'acme/app', key: 'ci', value: 'skip', reason: 'Actions billing is failing' });
      ok('/onboard/rule', { scope: 'acme/app', key: 'checks.commands', value: ['pnpm test'], reason: 'the CI stand-in' });
      return ok('/onboard/automerge', { repo: 'acme/app', on: false });
    };
    const first = run(), ship1 = fs.readFileSync(path.join(io.dir, 'onboard.json'), 'utf8'), runs1 = Object.keys(derive(read())).sort();
    assert.deepEqual(first.ship['acme/app'].ship, ['web', 'database']);
    assert.deepEqual([first.rules['acme/app'].policy.ci.value, first.rules['acme/app'].policy.ci.setBy, first.rules['acme/app'].policy['checks.commands'].value], ['skip', 'stub-user', ['pnpm test']]);
    assert.equal(first.projects['acme/app'].autoMerge, false);
    const again = run();
    assert.equal(fs.readFileSync(path.join(io.dir, 'onboard.json'), 'utf8'), ship1);
    assert.deepEqual(Object.keys(derive(read())).sort(), runs1); // re-sync imports nothing new
    assert.equal(again.projects['acme/app'].autoMerge, false); // ...and keeps the project's settings
    assert.equal(again.rules['acme/app'].policy.ci.value, 'skip');
    const txt = cli(['onboard'], '', { FACTORY_DIR: io.dir, HOME: home, PATH: process.env.PATH });
    for (const re of [/✓ acme\/app {2}/, /acme\/app: web, database/, /acme\/app: ci="skip", checks\.commands=\["pnpm test"\] {3}auto-merge off/, hooks().create ? /Create from an idea: .*factory\.mjs new/ : /Create from an idea: coming soon/]) assert.match(txt, re);
    assert.deepEqual(JSON.parse(cli(['onboard', 'ship', 'default', 'mobile'], '', { FACTORY_DIR: io.dir })), { ship: ['mobile'] });
    assert.throws(() => cli(['onboard', 'ship', 'default', 'tv'], '', { FACTORY_DIR: io.dir }), /web\|mobile\|database/);
    // The static page carries the wizard's cheap data, never the slow or private parts.
    const pg = page();
    assert.match(pg, /"harnesses":\[\{"id":"claude-code","label":"Claude Code","install":/);
    assert.ok(!pg.includes('"repos":') && !pg.includes('Development/app"'), 'discover results are served only to F ui');
    assert.equal(pg.split('__FACTORY_DATA__').length, 1);
  } finally {
    io.dir = prevDir; io.gh = prev.GH; io.git = prev.GIT; process.env.PATH = prev.PATH; process.env.HOME = prev.HOME;
  }
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
    ['deploy.preview', 'maybe', /required\|advisory\|off/], ['deploy.production', 'required', /unknown rule/],
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
  // deploy.preview: required needs a ready https preview of the reviewed commit from any web-deploy connector; advisory only notes it.
  const S1 = 's1', dp = (x) => ({ connector: 'any-host', kind: 'web-deploy', env: 'preview', state: 'ready', sha: S1, url: 'https://p.example', ...x });
  const P = (v, deploys, r = ok) => D(r, { checks: 'pass', rules: { 'deploy.preview': rule(v) }, deploys });
  assert.deepEqual(D(ok, { checks: 'pass' }), D(ok, { checks: 'pass', rules: { 'deploy.preview': rule('off') } })); // off = built-in
  assert.equal(P('required', [dp()]).action, 'merge');
  assert.match(P('required', [dp()]).reasons.join(), /preview ready: https:\/\/p\.example \(any-host\)/);
  for (const bad of [[], [dp({ sha: 's0' })], [dp({ state: 'building' })], [dp({ env: 'neon-audit' })], [dp({ kind: 'database' })], [dp({ url: 'http://p.example' })]]) {
    const x = P('required', bad);
    assert.deepEqual([x.action, /no ready preview deploy for the reviewed commit s1 \(rule deploy.preview=required, set by acme/.test(x.reasons.join())], ['escalate', true]);
  }
  assert.equal(P('required', undefined, { ...ok, deploys: [dp()] }).action, 'merge'); // from the run's recorded deploys when facts carry none
  assert.deepEqual([P('advisory', []).action, /no ready preview.*advisory/.test(P('advisory', []).reasons.join())], ['merge', true]);
  assert.match(P('required', [dp()], { ...ok, association: 'NONE' }).reasons.join(), /not trusted/); // a ready preview never loosens a guard
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
  // End to end: under deploy.preview=required, F decide asks the ship harness for the reviewed commit's deploys, records them, then decides.
  set('acme/app', 'deploy.preview', 'required', '--reason', 'reviewers look at the running app');
  const P10 = 'acme/app#60', head10 = '10'.padStart(40, '0');
  record(P10, 'intake', 'started', { title: 't', association: 'OWNER' });
  record(P10, 'build', 'passed', { pr: 'https://github.com/acme/app/pull/60' });
  record(P10, 'review', 'started', { axes: ['code', 'security'], sha: head10 });
  record(P10, 'review', 'passed', { axis: 'code', findings: [] });
  record(P10, 'review', 'passed', { axis: 'security', findings: [] });
  const gated = JSON.parse(cli(['decide', P10], '', { STUB_CHECKS: '1' }));
  assert.equal(gated.action, 'merge');
  assert.match(gated.reasons.join(), /preview ready: https:\/\/deploy-10\.example\.app \([\w-]+\)/);
  assert.equal(derive(read())[P10].deploys[0].state, 'ready');
  record(P10, 'build', 'started'); // a new commit is a new iteration: the first one's reviews stay as recorded
  record(P10, 'review', 'started', { axes: ['code', 'security'], sha: 'e'.repeat(40) }); // a new commit with no preview
  record(P10, 'review', 'passed', { axis: 'code', findings: [] });
  record(P10, 'review', 'passed', { axis: 'security', findings: [] });
  assert.match(JSON.parse(cli(['decide', P10], '', { STUB_CHECKS: '1' })).reasons.join(), /no ready preview deploy for the reviewed commit eeeeeee/);
  assert.match(JSON.parse(cli(['decide', P10], '', { STUB_CHECKS: '1', STUB_DEPLOY_FAIL: '1' })).action, /escalate/); // lookup down: escalate, never crash
  cli(['rules', 'unset', 'acme/app', 'deploy.preview']);
  // A hand-edited rule without a reason fails loudly, and the dashboard says so instead of failing every event.
  fs.writeFileSync(path.join(io.dir, 'skills.json'), '{"acme/rr":{"rules":{"ci":{"value":"skip","setBy":"me","setAt":"2026-01-01"}}}}');
  assert.throws(() => cli(['rules', 'acme/rr']), /needs a reason/);
  record('acme/rr#2', 'intake', 'started', { title: 't' });
  assert.match(fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8'), /"rulesError":"skills.json acme\/rr.rules.ci: needs a reason/);
  fs.rmSync(path.join(io.dir, 'skills.json'));
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
  // Usage flags go through record()'s usage checks; the reviewer's own text can't set them.
  cli(['review', R, 'ui', '--tokens', '5', '--model', 'claude-sonnet-5-5', '--usage', '{"input":10,"output":20,"cacheRead":30,"cacheWrite":40}'], '{"axis":"ui","verdict":"passed","findings":[],"tokens":0,"usage":{"input":0}}');
  assert.deepEqual([derive(read())[R].tokens, derive(read())[R].burn.byAxis.ui.tokens], [1300, 100]);
  assert.throws(() => cli(['review', R, 'ui'], '{"axis":"ui","verdict":"passed","findings":[]}'), /already recorded/); // invalid→valid once, then final
  assert.throws(() => cli(['review', R, 'ux', '--usage', '{"prompt":1}'], '{}'), /usage has unknown fields: prompt/); // ux is still invalid, so replaceable
  assert.throws(() => cli(['review', R, 'ux', '--model', 'a b'], '{}'), /short model id/);
  assert.equal(SUB_AXIS.exec('a11y review acme/u#1')[1], 'a11y'); // extra axes get their subagent's measured burn
  set('acme/kit', 'verifier', { use: 'provider', harness: 'claude-code', name: 'pr-review-toolkit:code-reviewer' });
  assert.equal(JSON.parse(cli(['gate', R])).next, 'build');
  assert.equal(derive(read())[R].runners.gate.name, 'pr-review-toolkit:code-reviewer');
  // Catalog: every source the picker offers, and every runner it offers passes F's own validation.
  const home = path.join(io.dir, 'skhome'), clone = path.join(io.dir, 'kitclone');
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const md = (desc) => `---\nname: x\ndescription: ${desc}\n---\nbody`;
  put(path.join(home, '.claude/skills/house-review/SKILL.md'), '---\nname: house-review\ndescription: |\n  Our house\n  review rules\n---\n');
  put(path.join(home, '.claude/skills/synced/b1/xlsx/SKILL.md'), md('"Spreadsheets"'));
  put(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'tk@m': [{ scope: 'user', installPath: path.join(home, 'plug/tk') }],
    'pj@m': [{ scope: 'project', projectPath: clone, installPath: path.join(home, 'plug/pj') }],
    'other@m': [{ scope: 'project', projectPath: '/elsewhere', installPath: path.join(home, 'plug/other') }] } }));
  put(path.join(home, 'plug/tk/.claude-plugin/plugin.json'), '{"name":"tk"}');
  put(path.join(home, 'plug/tk/agents/hunter.md'), md('Hunts silent failures'));
  put(path.join(home, 'plug/tk/commands/review-pr.md'), md('Reviews a PR'));
  put(path.join(home, 'plug/pj/skills/pjs/SKILL.md'), md('Project plugin skill'));
  put(path.join(home, 'plug/other/skills/nope/SKILL.md'), md('Another project'));
  put(path.join(home, '.claude/plugins/synced/b1/design~g2/skills/accessibility-review/SKILL.md'), md('WCAG audit'));
  put(path.join(home, '.agents/skills/find-skills/SKILL.md'), md('Finds skills'));
  put(path.join(home, '.agents/skills/house-review/SKILL.md'), md('duplicate of the Claude skill'));
  put(path.join(io.dir, 'briefs/a11y.md'), md('Our a11y brief'));
  put(path.join(clone, '.claude/skills/kit-review/SKILL.md'), md('Repo review'));
  saveProject('acme/kit', clone);
  const cat = JSON.parse(cli(['skills', 'catalog', 'acme/kit'], '', { HOME: home }));
  const by = (n) => cat.global.find((e) => e.name === n);
  assert.equal(by('house-review').desc, 'Our house review rules');
  assert.equal(by('anthropic-skills:xlsx').desc, 'Spreadsheets');
  assert.deepEqual(by('tk:hunter').runner, { use: 'provider', harness: 'claude-code', name: 'tk:hunter' });
  assert.deepEqual(by('tk:review-pr').runner, { use: 'skill', name: 'tk:review-pr' });
  assert.equal(by('design:accessibility-review').group, 'plugin: design');
  assert.deepEqual(by('find-skills').runner, { use: 'brief', path: '~/.agents/skills/find-skills/SKILL.md' });
  assert.equal(cat.global.filter((e) => e.name === 'house-review').length, 1);
  assert.equal(cat.global.find((e) => e.source === 'yours').runner.path, path.join(io.dir, 'briefs/a11y.md'));
  assert.deepEqual(cat.projects['acme/kit'].map((e) => e.name).sort(), ['kit-review', 'pj:pjs']);
  for (const e of [...cat.global, ...cat.projects['acme/kit']]) checkRunner(e.runner, e.name);
  // F ui: only the printed URL reads the page, only a same-origin JSON POST with the token writes, and invalid writes change nothing.
  const tok = 't'.repeat(32), ctx = { token: tok, port: 4242 }, H = { host: '127.0.0.1:4242' };
  const post = (h, body) => uiHandle({ method: 'POST', url: '/skills', headers: { ...H, origin: 'http://127.0.0.1:4242', 'content-type': 'application/json', 'x-factory-token': tok, ...h }, body: JSON.stringify(body) }, ctx);
  const ui1 = { scope: 'acme/kit', step: 'review.ui', runner: { use: 'skill', name: 'brand-review' } };
  assert.equal(uiHandle({ method: 'GET', url: '/?t=' + tok, headers: { host: 'evil.test:4242' } }, ctx).status, 403);
  assert.equal(uiHandle({ method: 'GET', url: '/', headers: H }, ctx).status, 403);
  assert.ok(uiHandle({ method: 'GET', url: '/?t=' + tok, headers: H }, ctx).body.includes(tok));
  const before = fs.readFileSync(path.join(io.dir, 'skills.json'), 'utf8');
  assert.equal(post({ 'x-factory-token': 'u'.repeat(32) }, ui1).status, 403);
  assert.equal(post({ origin: 'https://evil.test' }, ui1).status, 403);
  assert.equal(post({ 'content-type': 'text/plain' }, ui1).status, 415);
  assert.equal(post({}, { ...ui1, step: 'review.lint' }).status, 400);
  assert.equal(post({}, { ...ui1, scope: '__proto__' }).status, 400);
  assert.equal(fs.readFileSync(path.join(io.dir, 'skills.json'), 'utf8'), before);
  const saved = post({}, ui1);
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).plans['acme/kit'].plan['review.ui'].name, 'brand-review');
  assert.deepEqual(JSON.parse(post({}, { ...ui1, runner: null }).body).plans['acme/kit'].plan['review.ui'], { use: 'default' }); // unset -> inherits
  assert.equal(JSON.parse(cli(['skills', 'unset', 'acme/kit', 'build'])).build, undefined);
  assert.ok(!fs.readFileSync(render(), 'utf8').includes(tok), 'the written dashboard never carries the ui token');
  // /api/*: the same routes and checks under one prefix, plus token-guarded reads of the run list.
  assert.equal(post({}, ui1).body, uiHandle({ method: 'POST', url: '/api/skills', headers: { ...H, origin: 'http://127.0.0.1:4242', 'content-type': 'application/json', 'x-factory-token': tok }, body: JSON.stringify(ui1) }, ctx).body);
  const get = (url, h = {}) => uiHandle({ method: 'GET', url, headers: { ...H, 'x-factory-token': tok, ...h } }, ctx);
  const all = get('/api/runs');
  assert.equal(all.status, 200);
  assert.deepEqual(JSON.parse(all.body).runs.map((r) => r.id), runsData().map((r) => r.id));
  const issueRun = runsData().find((r) => /^[\w-]+\/[\w.-]+#\d+$/.test(r.id));
  assert.ok(issueRun, 'fixture has an issue run');
  const [o, rp, n] = issueRun.id.split(/[/#]/);
  const one = get(`/api/runs/${o}/${rp}/${n}`);
  assert.equal(one.status, 200);
  assert.equal(JSON.parse(one.body).run.id, issueRun.id);
  for (const r of [all, one]) assert.ok(!r.body.includes(tok), 'API reads never carry the ui token');
  assert.equal(get(`/api/runs/${o}/${rp}/999999`).status, 404);
  assert.equal(get(`/api/runs/${o}/${rp}/x1`).status, 400);
  assert.equal(get('/api/runs/-bad/repo/1').status, 400);
  assert.equal(get('/api/runs/a/b/%zz').status, 400);
  assert.equal(get('/api/nope').status, 404);
  assert.equal(get('/api/runs', { 'x-factory-token': undefined }).status, 403);
  assert.equal(get('/api/runs', { 'x-factory-token': 'u'.repeat(32) }).status, 403);
  assert.equal(get('/api/runs', { origin: 'https://evil.test' }).status, 403);
  assert.equal(get('/api/runs', { origin: 'http://127.0.0.1:4242' }).status, 200);
  assert.equal(get('/api/runs', { host: 'evil.test:4242' }).status, 403);
  assert.equal(get('/runs').status, 404, 'reads live only under /api');
  assert.equal(uiHandle({ method: 'DELETE', url: '/api/runs', headers: { ...H, 'x-factory-token': tok } }, ctx).status, 404);
  // A hand-edited config is validated on every read, so it fails loudly instead of silently running defaults.
  fs.writeFileSync(path.join(io.dir, 'skills.json'), '{"acme/kit":{"review.lint":{"use":"default"}}}');
  assert.throws(() => cli(['skills', 'acme/kit']), /unknown step "review.lint"/);
}

// Fake HOME with Claude Code + Codex logs, then sync / re-sync / close-elsewhere against the gh + git stubs.
function syncTest(cli) {
  const home = path.join(io.dir, 'home'), repoPath = '/work/app';
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
  const links = JSON.parse(fs.readFileSync(path.join(io.dir, 'sessions.json'), 'utf8'));
  assert.deepEqual(links['acme/app#10'].map((x) => [x.agent, x.id]), [['claude-code', 'a']]);
  assert.deepEqual(links['acme/app#12'].map((x) => [x.agent, x.id]), [['codex', 'cx-1']]);
  assert.equal(JSON.parse(cli(['decide', 'acme/app#11'], '', env)).action, 'escalate');
  // Ship: sync records each in-progress PR head's deploy state through record(); only PR 10's head has a preview.
  assert.deepEqual(first.ship.recorded.map((x) => [x.run, x.env, x.state, x.url]), [['acme/app#10', 'preview', 'ready', 'https://deploy-10.example.app']]);
  assert.deepEqual(first.ship.errors, []);
  assert.deepEqual(derive(read())['acme/app#10'].deploys.map((d) => [d.env, d.sha]), [['preview', '10'.padStart(40, '0')]]);
  assert.equal(derive(read())['acme/app#10'].url, 'https://github.com/acme/app/pull/10');
  const failing = JSON.parse(cli(['sync', 'acme/app'], '', { ...env, STUB_DEPLOY_FAIL: '1' }))[0]; // a failed lookup never breaks sync
  assert.match(failing.ship.errors[0].error, /HTTP 502/);
  assert.deepEqual(failing.added, []);
  assert.deepEqual(JSON.parse(cli(['sync'], '', env))[0].added, []); // re-sync is idempotent and remembers the path
  assert.equal(read().filter((e) => e.stage === 'ship').length, 1); // the same state for the same sha is recorded once
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
  for (const ax of ['code', 'security', 'ux']) cli(['review', R, ax], `{"axis":"${ax}","verdict":"passed","findings":[]}`, env2);
  cli(['review', R, 'ui'], '{"axis":"ui","verdict":"failed","findings":[{"severity":"high","issue":"x","route":"build"}]}', env2);
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
  const skipped = JSON.parse(cli(['postmerge', R], '', env3));
  assert.equal(skipped.state, 'skipped'); // a billing-red main must not trigger reverts
  assert.deepEqual(skipped.deploys.map((d) => [d.env, d.state, d.sha, d.url]), [['production', 'ready', sha, 'https://deploy-11.example.app']]); // the merge commit's deploy, recorded
  assert.deepEqual(derive(read())[R].deploys.map((d) => [d.env, d.sha]), [['production', sha]]);
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
    if (['sync', 'postmerge', 'revert', 'decide', 'merge', 'ship', 'onboard', 'ui'].includes(cmd)) SHIP = await loadShip();
    if (SHIP && ['onboard', 'ui'].includes(cmd)) SHIP_LIST = (await SHIP.ready()).connectors.map((c) => ({ id: c.id, kind: c.kind, label: c.label || c.id }));
    switch (cmd) {
      case 'event': {
        const [stage, status] = rest, p = json(rest[2]);
        const owned = { 'intake:started': 'intake', 'review:started': 'axes', 'approve:decided': 'merge', 'approve:merged': 'merge', 'approve:reverted': 'revert', 'approve:closed': 'sync', 'idea:retired': 'retire' };
        const owner = owned[`${stage}:${status}`] || { gate: 'gate', rules: 'rules', idea: 'new', plan: 'new', repo: 'new', issues: 'issues create', loop: 'loop', ship: 'ship' }[stage];
        if (owner) throw new Error(`"${stage} ${status}" is recorded by "${owner}", not by hand`);
        if (stage === 'review' && p.role !== 'verifier') throw new Error('axis verdicts are recorded by "review", not by hand; "event" only takes the verifier usage record ({"role":"verifier",…})');
        const typed = ['association', 'originAssociation', 'origin', 'author', 'sha', 'imported', 'source', 'action', 'harness', 'sessionId', 'cwd', 'runner', 'localChecks',
          'connector', 'kind', 'env', 'state', 'url', 'detail', 'creator', 'at'].filter((k) => k in p); // the last row: set by ship connectors only
        if (typed.length) throw new Error(`these fields come from GitHub, git or a ship connector, not from a payload: ${typed.join(', ')}`);
        record(run, stage, status, p, { fallback }); break;
      }
      case 'review': { // raw reviewer output on stdin, from any runner; invalid output is recorded as a failed review
        const { status, payload } = reviewFromText(run, rest[0], fs.readFileSync(0, 'utf8'));
        for (const k of ['tokens', 'costUsd', 'usage', 'model']) delete payload[k]; // usage comes from the orchestrator's flags, never the reviewer's own text
        for (const [flag, k] of [['--tokens', 'tokens'], ['--cost-usd', 'costUsd']]) { // the orchestrator's usage numbers, kept even when the reply is invalid
          const i = rest.indexOf(flag), v = i < 0 ? undefined : Number(rest[i + 1]);
          if (i >= 0 && !(v >= 0)) throw new Error(`${flag} needs a number`);
          if (i >= 0) payload[k] = v;
        }
        const mi = rest.indexOf('--model'), ui = rest.indexOf('--usage'); // record() validates both, as for "F event"; usage replaces --tokens with its sum
        if (mi >= 0) payload.model = rest[mi + 1];
        if (ui >= 0) { try { payload.usage = JSON.parse(rest[ui + 1]); } catch { throw new Error('--usage needs JSON like {"input":1,"output":2,"cacheRead":3,"cacheWrite":4}'); } }
        record(run, 'review', status, payload, { fallback });
        out({ status, findings: payload.findings }); break;
      }
      case 'skills': { // skills <owner/repo> | skills set|unset <owner/repo|default> <step> [json] | skills catalog [owner/repo]
        if (run === 'catalog') { out(catalog(rest)); break; }
        if (run === 'unset') { out(setSkill(rest[0], rest[1], undefined)); break; }
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
        else throw new Error('usage: rules <owner/repo|default> | rules set <owner/repo|default> <ci|checks.commands|diffCap|deploy.preview|project.budgetUsd|project.maxIssuesPerSession|guide.<step>> <value> --reason "…" [--until YYYY-MM-DD] | rules unset <owner/repo|default> <key> [--reason "…"]');
        break;
      }
      case 'checks': out(localChecks(run)); break;
      case 'automerge': { // per-project switch; decide() escalates everything when off
        if (!['on', 'off'].includes(rest[0])) throw new Error('usage: automerge <owner/repo> on|off');
        out(setAutoMerge(run, rest[0] === 'on')); break;
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
      case 'onboard': { // onboard [--json] | onboard ship <owner/repo|default> web,mobile,database
        if (run === 'ship') { out(setShip(rest[0], (rest[1] || '').split(',').map((k) => k.trim()).filter(Boolean))); break; }
        const st = onboardState();
        if (run === '--json') out(st); else console.log(onboardText(st));
        break;
      }
      case 'ship': { // thin alias: ship.mjs connectors | detect <owner/repo> | status <owner/repo> [sha]  (reads only)
        if (!SHIP) throw new Error('the ship harness (packages/ship) is not installed next to the factory');
        out(await SHIP.main([run, ...rest].filter(Boolean), { path: projects()[rest[0]]?.path })); break;
      }
      case 'discover': out(discover([run, ...rest].filter(Boolean))); break;
      case 'decide': { const r = getRun(run); const f = r.imported ? {} : facts(r); const d = decide(r, f); record(run, 'approve', 'decided', { ...d, facts: f }); out({ ...d, facts: f }); break; }
      case 'merge': out(merge(run)); break;
      case 'risk': out(risk(getRun(run), rest)); break;
      case 'approval': out(approval(run)); break;
      case 'postmerge': out(postmerge(run)); break;
      case 'revert': out(revert(run, rest.join(' ') || 'CI failed on the base branch after merge')); break;
      case 'queue': out(await queue(run)); break;
      case 'new': { // new "<idea>" [--name owner/repo] [--stack id] [--dry-run] [--yes] [--out dir] [--path dir] [--public] [--host id] [--tracker id]
        const has = (f) => { const i = rest.indexOf(f); return i >= 0 && !!rest.splice(i, 1); };
        const opt = (f) => { const i = rest.indexOf(f); return i < 0 ? undefined : rest.splice(i, 2)[1]; };
        const o = { idea: run, name: opt('--name'), stack: opt('--stack'), out: opt('--out'), dest: opt('--path'), host: opt('--host'), tracker: opt('--tracker'), dryRun: has('--dry-run'), yes: has('--yes'), visibility: has('--public') ? 'public' : undefined };
        if (rest.length) throw new Error(`unknown arguments: ${rest.join(' ')}`);
        out(await newProject(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)))); break;
      }
      case 'issues': { // issues create <owner/repo> <file.json> [--yes]
        if (run !== 'create' || !rest[0] || !rest[1]) throw new Error('usage: issues create <owner/repo> <issues.json> [--yes]');
        out(await issuesCreate(rest[0], rest[1], { yes: rest.includes('--yes') })); break;
      }
      case 'project': { const s = projectStatus(run || ''); if (!s) throw new Error(`no project ${run}; start one with "new"`); out(s); break; }
      case 'loop': out(await loop(run)); break;
      case 'retire': { const ri = rest.indexOf('--reason'); out(retireIdea(run, ri < 0 ? '' : rest[ri + 1])); break; }
      case 'archive': out(archive(run ? Number(run) : 14)); break;
      case 'eval': out(evals(run)); break;
      case 'state': out(getRun(run)); break;
      case 'usage': { // measured (transcripts) or reported (payload) burn; no run: one line per run
        if (run) { const r = getRun(run); out({ run: r.id, ...(r.burn || { measured: false, total: null }), budget: budget(r) }); break; }
        const events = read();
        out(Object.fromEntries(Object.values(withMeasured(derive(events), events)).filter((r) => r.burn).map((r) => [r.id, { measured: r.burn.measured, ...r.burn.total }])));
        break;
      }
      case 'headless-args': { // the run's remaining budget; an imported checkout is someone else's code, so never -p there
        const r = getRun(run), b = budget(r);
        if (r.imported) throw new Error(`${run} is imported: never run claude -p in its checkout`);
        if (b.over) throw new Error(`run budget exceeded ${budgetWhy(b)}`);
        const si = rest.indexOf('--share'), share = si < 0 ? 1 : Number(rest[si + 1]);
        out(headlessArgs({ schema: rest.includes('--review') ? JSON.parse(fs.readFileSync(path.join(HERE, 'references', 'review.schema.json'), 'utf8')) : undefined, budget: COST_CAP - b.usd, write: rest.includes('--write'), share }));
        break;
      }
      case 'dir': console.log(runDir(run)); break;
      case 'render': console.log(render()); break;
      case 'ui': ui(Number(run) || 0); break;
      case 'demo': // never pollute the real log with fixtures
        if (!process.env.FACTORY_DIR) io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-demo-'));
        console.log(demo()); break;
      case 'test': await test(); break;
      default:
        console.log(`usage: factory.mjs <command>
  discover [roots...]                     find local GitHub clones for onboarding (default: ~/Development, ~/code, ...)
  sync   [owner/repo] [local clone path]  attach a project and import open PRs + agent sessions (no args: all)
  projects                                list attached projects
  onboard [--json]                        setup state, step by step, with the command for each fix (the wizard: F ui)
  onboard ship <owner/repo|default> <web,mobile,database>  store what the project ships
  ship   connectors | detect <owner/repo> | status <owner/repo> [sha]   deploy state from packages/ship connectors (read only)
  intake <run>                            fetch issue, record intake start, print issue + trusted comments
  event  <run> <stage> <status> [json|-] [--fallback why]  record an event ("-" = JSON on stdin)
  worktree <run> [clone path]            create/reuse the run's git worktree (prints its path)
  deps   <run>                            cheapest node_modules for the worktree
  axes   <run> [changed files...]         pick + record review axes (default: worktree diff since last review)
  review <run> <axis> [--tokens n] [--cost-usd x] [--model id] [--usage json] [--fallback why]  record a reviewer's raw reply from stdin (invalid = failed review)
  skills <owner/repo>                     print who runs each step (default, skill, brief or provider)
  skills set <owner/repo|default> <step> <json>  configure one step (intake, spec, build, review.<axis>, verifier, postmerge, axes.extra)
  skills unset <owner/repo|default> <step>       drop a step's choice (a project then inherits the global one)
  skills catalog [owner/repo...]          every runner on this machine: built-in, harness tools, global, project, your briefs
  ui     [port]                           serve the dashboard on 127.0.0.1 with a token, so the Skills sheet and setup wizard can save
  rules  <owner/repo>                     print the policy rules, warnings and per-step guidance that apply
  rules set <owner/repo|default> <key> <value> --reason "…" [--until YYYY-MM-DD]  ci required|advisory|skip, checks.commands '[…]', diffCap n, deploy.preview required|advisory|off, project.budgetUsd x, project.maxIssuesPerSession n, guide.<step> "text"
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
  queue  <owner/repo>                     factory:ready issues whose dependencies are merged (ready), the rest (blocked), untriaged open issues
  new    "<idea>" [--name owner/repo] [--stack next-web] [--dry-run] [--yes] [--path dir] [--out dir]
                                          idea-to-app: record the idea, validate PLAN.md + issues.json, then (with --yes) create the private repo + scaffold
  issues create <owner/repo> <file.json> [--yes]  validate and preview an issue batch; with --yes create it (idempotent by key)
  project <owner/repo>                    idea-to-app status: plan, milestones, next issue, dependency order, burn, loop
  retire <owner/repo> --reason "<why>"     hide an idea that never got a repo (a leaked fixture) with a recorded event; the log is never rewritten
  loop   <owner/repo>                     next issue to build, or stop (first escalation, project budget, session cap, empty queue)
  automerge <owner/repo> on|off           allow or forbid auto-merge for a project
  archive [days=14]                       compact finished runs older than N days
  eval   [fixture]                        score intake on evals/golden with headless claude (costs tokens)
  state  <run>                            print derived run state
  usage  [run]                            token burn by stage, iteration and axis: measured from transcripts, else reported
  headless-args <run> [--review|--write] [--share N]  pinned claude -p flags (read-only unless --write) for a provider runner, with the run's remaining budget split N ways (JSON array)
  dir    <run>                            print the run's artifact folder
  render | demo | test`);
        process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`factory: ${e.message}`);
    process.exitCode = 1;
  }
}
