// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ls, projects } from './workspace.ts';
import { checkGuide, checkRules, rules } from './rules.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';
import { stateDir } from './log.ts';

// Who does each step: the built-in brief, the user's own skill or brief, or a harness's tool.
// User-local only (io.dir/skills.json): a repo, and so a PR, can never pick its own reviewers.
export const BUILTIN_AXES = ['code', 'security', 'ux', 'ui', 'seo', 'docs'];
export const REQUIRED_AXES = ['code', 'security']; // axesFor always selects them; config can swap who reviews, never drop them
export const STEP_KEYS = ['intake', 'spec', 'build', ...BUILTIN_AXES.map((a) => `review.${a}`), 'verifier', 'postmerge'];
export const harnessIds = () => harnesses.map((h) => h.id);
export const NAME = /^[\w.-]+(:[\w.-]+)?$/; // skill, plugin:skill or agent type; it ends up in a command line
export const skillsFile = () => path.join(stateDir(), 'skills.json');
export function checkRunner(s, at, more = []) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${at}: a runner must be a JSON object`);
  const bad = Object.keys(s).filter((k) => !['use', 'name', 'path', 'harness', ...more].includes(k));
  if (bad.length) throw new Error(`${at}: unknown fields ${bad.join(', ')}`);
  const ok = s.use === 'default' && !s.name && !s.path && !s.harness
    || s.use === 'skill' && NAME.test(s.name || '') && !s.path && !s.harness
    || s.use === 'brief' && /^(\/|~[\\/]|[A-Za-z]:[\\/]).*\.md$/.test(s.path || '') && !s.name && !s.harness // outside any worktree, so a branch can't supply it
    || s.use === 'provider' && harnessIds().includes(s.harness) && (s.name === undefined || NAME.test(s.name)) && !s.path;
  if (!ok) throw new Error(`${at}: expected {"use":"default"}, {"use":"skill","name"}, {"use":"brief","path":"/abs/or/~/….md"} or {"use":"provider","harness":"${harnessIds().join('|')}","name"?}`);
}
export function checkStep(key, v, at) {
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
export function checkSkills(cfg) {
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
export function writeSkills(cfg) {
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
export const front = (file) => {
  let t = '';
  try { t = fs.readFileSync(file, 'utf8').slice(0, 6000); } catch { return ''; }
  const m = /^---\r?\n([^]*?)\r?\n---/.exec(t);
  const d = m && /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/m.exec(m[1]);
  return d ? d[1].replace(/^[|>][-+]?\s*/, '').replace(/\s+/g, ' ').replace(/^(["'])(.*)\1$/, '$2').trim().slice(0, 240) : '';
};
export const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? '~' + p.slice(os.homedir().length) : p);
export const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };
export function pluginItems(dir, source, group) {
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
export let globalCatalog; // one disk scan per process: render() runs on every record()
export function scanGlobal() {
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
  skillDir(path.join(home, '.agents', 'skills'), 'global', '~/.agents/skills', (n, f) => !mine.has(n) && /^[^'"\0-\x1f]+$/.test(f) && { use: 'brief', path: tilde(f) }); // other harnesses' skills run as a brief
  let installed = {};
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
export function scanProject(repo) {
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
