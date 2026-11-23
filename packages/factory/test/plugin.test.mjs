// The repo as a Claude Code plugin marketplace (#81): manifests, the skill they point at, and F from a plugin-cache copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fCmd, pluginEntry } from '../../core/src/onboard.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const json = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

test('marketplace and plugin manifests agree, and the skills path holds the software-factory skill', () => {
  const m = json('.claude-plugin/marketplace.json'), p = json('.claude-plugin/plugin.json');
  assert.equal(m.name, 'software-factory');
  assert.ok(m.owner?.name);
  assert.deepEqual(m.plugins.map((x) => [x.name, x.source]), [['software-factory', './']]); // the repo root: factory.mjs imports ../cli and ../core
  assert.equal(p.name, 'software-factory');
  assert.equal(p.version, undefined, 'no pinned version: the commit SHA versions the plugin cache, so every merge reaches installs');
  assert.equal(p.license, json('package.json').license);
  assert.match(p.skills, /^\.\//);
  const skill = fs.readFileSync(path.join(ROOT, p.skills, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: software-factory\ndescription: \S/);
  assert.doesNotMatch(skill, /node ~\/\.claude\/skills/, 'a plugin install has no ~/.claude/skills copy: F must come from ${CLAUDE_SKILL_DIR}');
});

test('fCmd: the short ~ form only when ~/.claude/skills/software-factory links to this copy; Windows always gets a quoted real path', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fcmd-'))), home = path.join(d, 'home');
  const entry = path.join(d, 'plugin cache', 'packages', 'factory', 'factory.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, '');
  assert.equal(fCmd('darwin', home, entry), `node '${entry}'`); // a plugin install: not linked, and the path has a space
  assert.equal(fCmd('win32', home, entry), `node "${entry}"`);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.dirname(entry), path.join(home, '.claude', 'skills', 'software-factory'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fCmd('linux', home, entry), 'node ~/.claude/skills/software-factory/factory.mjs');
  assert.equal(fCmd('win32', home, entry), `node "${path.join(home, '.claude', 'skills', 'software-factory', 'factory.mjs')}"`);
  assert.equal(fCmd('darwin', home, path.join(d, 'desktop', 'factory.mjs')), 'node ~/.claude/skills/software-factory/factory.mjs', 'no F of its own (the desktop build): the installed skill');
  assert.equal(fCmd('darwin', path.join(d, 'nobody'), path.join(d, 'desktop', 'factory.mjs')), null, 'and no skill installed: no command at all');
});

test('F runs from a copy of the tracked files, the way Claude Code copies a plugin into its cache (no node_modules, no pnpm)', (t) => {
  let files;
  try { files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return t.skip('not a git checkout'); }
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plugin-'));
  for (const f of files) if (/^(packages\/(cli|core|server|adapters|ship|factory)|\.claude-plugin)\//.test(f) && fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(copy, f), { recursive: true });
  const env = { ...process.env, FACTORY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plugin-state-')) };
  const r = spawnSync(process.execPath, [path.join(copy, 'packages', 'factory', 'factory.mjs'), 'help'], { encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /install-skill/);
  // A broken app.html (a bad merge): the event is still recorded, once, with a warning; F render itself fails loudly.
  fs.writeFileSync(path.join(copy, 'packages', 'factory', 'app.html'), '<!doctype html><p>conflicted</p>');
  const F = (args, input) => spawnSync(process.execPath, [path.join(copy, 'packages', 'factory', 'factory.mjs'), ...args], { encoding: 'utf8', env, input });
  const ev = F(['event', 'acme/app#7', 'spec', 'started', '-'], '{"title":"x"}');
  assert.equal(ev.status, 0, ev.stderr);
  assert.match(ev.stderr, /dashboard not updated: .*no data tag/);
  assert.equal(fs.readFileSync(path.join(env.FACTORY_DIR, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.includes('acme/app#7')).length, 1);
  assert.notEqual(F(['render']).status, 0);
});

test('fCmd finds a plugin-only install through installed_plugins.json, and the linked skill still wins over it (#91)', (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plugin-only-'))), home = path.join(d, 'home');
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const gone = path.join(d, 'desktop', 'factory.mjs'); // the desktop build ships no factory.mjs
  const plugins = path.join(home, '.claude', 'plugins');
  const put = (installPath) => { const f = path.join(installPath, 'packages', 'factory', 'factory.mjs'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
  const reg = (plugins_, dir = plugins) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'installed_plugins.json'), typeof plugins_ === 'string' ? plugins_ : JSON.stringify({ version: 2, plugins: plugins_ })); };
  const env = {};
  assert.equal(fCmd('darwin', home, gone, env), null); // neither installed
  const old = path.join(plugins, 'cache', 'software-factory', 'software-factory', 'old sha'), cur = path.join(plugins, 'cache', 'software-factory', 'software-factory', 'new sha');
  const curF = put(cur); put(old);
  const proj = path.join(plugins, 'cache', 'software-factory', 'software-factory', 'project sha'); put(proj);
  reg({ 'software-factory@software-factory': [
    { scope: 'project', projectPath: '/p', installPath: proj, lastUpdated: '2026-11-30T00:00:00Z' }, // another folder's project: never
    { scope: 'user', installPath: old, lastUpdated: '2026-11-23T01:00:00+05:00' }, // a later string, an earlier time (20:00Z on the 22nd)
    { scope: 'user', installPath: cur, lastUpdated: '2026-11-23T00:00:00Z' }] });
  assert.equal(fCmd('darwin', home, gone, env), `node '${curF}'`); // quoted: the path has a space
  assert.equal(fCmd('win32', home, gone, env), `node "${curF}"`);
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true }); // both installed: the linked skill wins
  const clone = path.join(d, 'clone'); put(clone);
  fs.symlinkSync(path.join(clone, 'packages', 'factory'), path.join(home, '.claude', 'skills', 'software-factory'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fCmd('linux', home, gone, env), 'node ~/.claude/skills/software-factory/factory.mjs');
  const cfg = path.join(d, 'cfg'); fs.mkdirSync(path.join(cfg, 'skills'), { recursive: true }); // CLAUDE_CONFIG_DIR: the linked skill is looked for there too
  fs.symlinkSync(path.join(clone, 'packages', 'factory'), path.join(cfg, 'skills', 'software-factory'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fCmd('linux', home, gone, { CLAUDE_CONFIG_DIR: cfg }), `node ${path.join(cfg, 'skills', 'software-factory', 'factory.mjs')}`);
  assert.equal(fCmd('linux', path.join(d, 'nohome'), gone, { CLAUDE_CONFIG_DIR: cfg }), `node ${path.join(cfg, 'skills', 'software-factory', 'factory.mjs')}`);
});

test('pluginEntry treats installed_plugins.json as untrusted: only a software-factory installPath inside <config>/plugins counts', (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plugin-reg-'))), home = path.join(d, 'home'), plugins = path.join(home, '.claude', 'plugins');
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const put = (installPath) => { const f = path.join(installPath, 'packages', 'factory', 'factory.mjs'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ''); return f; };
  const reg = (x, dir = plugins) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'installed_plugins.json'), typeof x === 'string' ? x : JSON.stringify({ version: 2, plugins: x })); };
  const outside = path.join(d, 'evil'); put(outside);
  const inside = path.join(plugins, 'cache', 'm', 'software-factory', 'v'); const insideF = put(inside);
  const sneaky = path.join(plugins, 'cache', 'link'); fs.symlinkSync(outside, sneaky, process.platform === 'win32' ? 'junction' : 'dir');
  for (const bad of ['{not json', '[]', { 'software-factory@m': 'x' }, { 'software-factory@m': [null, 7, { scope: 'user', installPath: 5 }, { scope: 'user', installPath: 'cache/m/software-factory/v' }, { scope: 'local', installPath: inside }] },
    { 'software-factory@m': [{ scope: 'user', installPath: outside }] }, { 'software-factory@m': [{ scope: 'user', installPath: sneaky }] }, { 'other@m': [{ scope: 'user', installPath: inside }] },
    { 'software-factory@m': [{ scope: 'user', installPath: path.join(plugins, 'cache', 'missing') }] }]) {
    reg(bad);
    assert.equal(pluginEntry(home, {}), null, JSON.stringify(bad));
  }
  reg({ 'software-factory@m': [{ scope: 'user', installPath: outside }, { scope: 'user', installPath: inside }] });
  assert.equal(pluginEntry(home, {}), insideF);
  const cfg = path.join(d, 'cfg'), cfgF = put(path.join(cfg, 'plugins', 'c', 'sf'));
  reg({ 'software-factory@m': [{ scope: 'user', installPath: path.join(cfg, 'plugins', 'c', 'sf') }] }, path.join(cfg, 'plugins'));
  assert.equal(pluginEntry(home, { CLAUDE_CONFIG_DIR: cfg }), cfgF); // Claude Code's config dir, when set
});
