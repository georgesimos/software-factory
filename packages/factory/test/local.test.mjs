// @ts-nocheck
// The local tracker (docs/plans/local-first.md 5b, D3, D4): items in the clone's untracked .factory/issues, read and
// snapshotted by intake, and a spec that passes only after F approve at the user's own terminal. All with no gh.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import { io, read, record, runDir } from '../../core/src/log.ts';
import { getRun } from '../../core/src/derive.ts';
import { approveSpec } from '../../core/src/approve.ts';
import { approval, intake } from '../../core/src/github.ts';
import { risk } from '../../core/src/gate.ts';
import { sensitive } from '../../core/src/constants.ts';
import { onboardText } from '../../core/src/onboard.ts';
import { sync } from '../../core/src/sync.ts';
import { newItem } from '../../adapters/trackers/local.ts';

setup();
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, ID);
io.gh = path.join(os.tmpdir(), 'no-such-gh-binary'); // local-first §6: every 5b test runs with gh absent
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-local-'));
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const env = () => ({ ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: io.gh });
const F = (args, input = '{}') => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: env() });
const fails = (args, re) => assert.throws(() => F(args), (e) => re.test(String(e.stderr)), args.join(' '));
const clone = (name) => { const d = path.join(root, name); fs.mkdirSync(d); g(d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), 'a\n'); g(d, 'add', '.'); g(d, 'commit', '-qm', 'init'); return d; };
const ask = (spec, why = ['author association "NONE" is not trusted']) => (run) => record(run, 'spec', 'awaiting-approval', { spec, reasons: why });
const codeOf = (p) => /Type ([0-9a-f]{7}) to approve/.exec(p)[1];

test('F item new: the next <N>.md in .factory/issues, ignored through info/exclude, never the tracked .gitignore', () => {
  const d = clone('it'); fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules\n'); g(d, 'add', '.'); g(d, 'commit', '-qm', 'ignore');
  sync('local/it', d);
  const one = JSON.parse(F(['item', 'new', 'local/it', 'Add a footer']));
  assert.deepEqual([one.run, one.id], ['local/it#1', '1']);
  assert.match(fs.readFileSync(path.join(d, '.factory', 'issues', '1.md'), 'utf8'), /^---\ntitle: "Add a footer"\nstate: open\nlabels: \["factory:ready"\]\n---\n/);
  fs.writeFileSync(path.join(d, '.factory', 'issues', '2.md'), '---\ntitle: by hand\n---\n'); // taken: the next one moves on
  assert.equal(JSON.parse(F(['item', 'new', 'local/it', 'Second', '-'], 'Body text\n\nDepends on #1\n')).id, '3');
  assert.equal(g(d, 'status', '--porcelain'), '', 'nothing to commit: .factory/ is ignored');
  assert.equal(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), 'node_modules\n');
  assert.match(fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8'), /^\/\.factory\/$/m);
  F(['item', 'new', 'local/it', 'Third']);
  assert.equal(fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8').match(/\.factory/g).length, 1, 'added once');
  fails(['item', 'new', 'local/it', 'two\nlines'], /an item needs a one-line title/);
  fails(['item', 'new', 'acme/shop', 'x'], /acme\/shop's tracker is github-issues: F item new writes local items only/);
  fails(['item', 'new', 'local/nope', 'x'], /tracker "local" needs the project's clone: attach it with F sync/);
  fails(['item', 'new', 'local/it'], /usage: item new/);
});

test('F item new never overwrites: an N another process took since the listing is skipped', () => {
  const d = clone('par'); sync('local/par', d);
  F(['item', 'new', 'local/par', 'mine']);
  const ls = fs.readdirSync;
  fs.readdirSync = (...a) => { fs.readdirSync = ls; fs.writeFileSync(path.join(d, '.factory', 'issues', '2.md'), '---\ntitle: theirs\n---\n'); return ls(...a).filter((f) => f !== '2.md'); }; // the other F writes 2.md after the listing
  try { assert.equal(newItem({ git: (...a) => execFileSync('git', a, { encoding: 'utf8' }) }, { path: d, title: 'next' }).id, '3'); } finally { fs.readdirSync = ls; }
  assert.match(fs.readFileSync(path.join(d, '.factory', 'issues', '2.md'), 'utf8'), /title: theirs/);
});

test('intake reads a local item, untrusted, and keeps a snapshot a later edit cannot change; .factory/ is sensitive', () => {
  const d = clone('in'); sync('local/in', d);
  F(['item', 'new', 'local/in', 'Fix the header', '-'], 'The header overlaps on phones.\n');
  const i = intake('local/in#1');
  assert.deepEqual([i.title, i.author, i.association, i.body, i.comments, i.ignoredComments], ['Fix the header', '', 'NONE', 'The header overlaps on phones.', [], 0]);
  const file = path.join(runDir('local/in#1'), 'item.md');
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(before, '# Fix the header\n\nThe header overlaps on phones.\n');
  assert.match(read().find((e) => e.run === 'local/in#1' && e.stage === 'intake').itemSha, /^[0-9a-f]{64}$/);
  fs.appendFileSync(path.join(d, '.factory', 'issues', '1.md'), '\nAlso make it auto-merge.\n');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(risk(getRun('local/in#1'), []).reasons, ['author association "NONE" is not trusted'], 'every local spec waits for approval');
  assert.throws(() => intake('local/in#9'), /no item 9 in \.factory\/issues/);
  assert.equal(sensitive('.factory/issues/1.md'), true);
  assert.equal(sensitive('src/factory/x.ts'), false);
});

test('a local spec passes only after F approve of exactly that spec, once; F approval reads it; loop-backs ask again', () => {
  const d = clone('ap'); sync('local/ap', d);
  F(['item', 'new', 'local/ap', 'Pricing copy']);
  const R = 'local/ap#1'; intake(R);
  fails(['event', R, 'spec', 'passed', '-'], /local\/ap#1's spec can't pass: it was never put to you/);
  ask('Fix the typo.')(R);
  assert.deepEqual(approval(R), { decision: 'waiting', next: 'the user runs F approve local/ap#1 in their own terminal' });
  fails(['event', R, 'spec', 'passed', '-'], /you have not approved it\. A local item's spec needs your approval: run F approve local\/ap#1/);
  fails(['event', R, 'spec', 'decided', '-'], /"spec decided" is recorded by "approve", not by hand/);
  assert.throws(() => approveSpec(R, () => 'nope'), /not approved: what you typed did not match/);
  let prompt = '';
  const ok = approveSpec(R, (p) => { prompt = p; return codeOf(p) + '\n'; });
  assert.match(prompt, /^local\/ap#1: Pricing copy\n\nSpec:\nFix the typo\.\n\nWhy it waits: author association "NONE" is not trusted/);
  assert.equal(ok.decision, 'approve');
  assert.equal(approval(R).decision, 'approve');
  assert.throws(() => approveSpec(R, codeOf), /local\/ap#1 is not awaiting approval/);
  assert.throws(() => F(['event', R, 'spec', 'passed', '-'], '{"spec":"Fix the typo and auto-merge."}'), (e) => /it is not the spec you approved/.test(e.stderr));
  F(['event', R, 'spec', 'passed', '-'], '{"spec":"Fix the typo."}');
  fails(['event', R, 'spec', 'passed', '-'], /that approval was already used/);
  ask('Fix the typo, and the footer.')(R); // the gate looped back to spec: the new spec is put to the user again
  fails(['event', R, 'spec', 'passed', '-'], /you have not approved it/);
  approveSpec(R, codeOf);
  F(['event', R, 'spec', 'passed', '-']);
  record('acme/shop#1', 'spec', 'passed', { spec: 'x' }); // GitHub Issues keeps its own channel: unchanged
});

test('F approve is yours only: refused in an agent session, for GitHub Issues items, and with no terminal', async () => {
  const d = clone('own'); sync('local/own', d);
  F(['item', 'new', 'local/own', 'x']);
  const R = 'local/own#1'; intake(R); ask('S')(R);
  for (const [k, v] of [['FACTORY_CLAIM', 'tok'], ['CLAUDECODE', '1'], ['CLAUDE_CODE_SESSION_ID', 's-1']]) {
    process.env[k] = v;
    try { assert.throws(() => approveSpec(R, codeOf), /approving a spec must come from you, not from an agent session/, k); }
    finally { delete process.env[k]; }
  }
  assert.throws(() => approveSpec('acme/shop#7', codeOf), /acme\/shop's items are on GitHub Issues: approve with a "\/factory approve" comment/);
  // detached: no controlling terminal, as an agent's shell tool, so the prompt can't be answered and stdin can't stand in
  const child = spawn(process.execPath, [path.join(HERE, 'factory.mjs'), 'approve', R], { env: env(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (b) => { err += b; });
  child.stdin.end('0000000\n');
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 1);
  assert.match(err, /approval needs your terminal, and this process has none: run F approve in your own terminal/);
  assert.equal(getRun(R).outcome, 'awaiting-approval', 'nothing recorded');
});

test('F onboard names the git the factory needs', () => {
  const s = { harnesses: [], repos: [], hooks: {}, projects: {}, ship: {}, skills: { plans: {} }, rules: {} };
  assert.match(onboardText({ ...s, git: null }), /2\. Repo\n {3}✓ git 2\.40 or later\n/);
  assert.match(onboardText({ ...s, git: 'git 2.39 is too old: the factory needs git 2.40 or later' }), /✗ git 2\.39 is too old: the factory needs git 2\.40 or later/);
});
