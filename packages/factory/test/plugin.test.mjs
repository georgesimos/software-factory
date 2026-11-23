// The repo as a Claude Code plugin marketplace (#81): manifests, the skill they point at, and F from a plugin-cache copy.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fCmd } from '../../core/src/onboard.ts';

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
});

test('F runs from a copy of the tracked files, the way Claude Code copies a plugin into its cache (no node_modules, no pnpm)', (t) => {
  let files;
  try { files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return t.skip('not a git checkout'); }
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plugin-'));
  for (const f of files) if (/^(packages\/(cli|core|server|adapters|ship|factory)|\.claude-plugin)\//.test(f) && fs.existsSync(path.join(ROOT, f))) fs.cpSync(path.join(ROOT, f), path.join(copy, f), { recursive: true });
  const env = { ...process.env, FACTORY_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plugin-state-')) };
  const r = spawnSync(process.execPath, [path.join(copy, 'packages', 'factory', 'factory.mjs'), 'help'], { encoding: 'utf8', env }); // usage exits 1
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
