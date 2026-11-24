// @ts-nocheck
// The local tracker (docs/plans/local-first.md 5b, D3, D4): items in the clone's untracked .factory/issues, read and
// snapshotted by intake, and a spec that passes only after F approve at the user's own terminal. All with no gh.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import { io, log, read, record, runDir } from '../../core/src/log.ts';
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
const specMd = (run, text) => { fs.mkdirSync(runDir(run), { recursive: true }); fs.writeFileSync(path.join(runDir(run), 'spec.md'), text); };
const ask = (spec, why = ['author association "NONE" is not trusted']) => (run) => { specMd(run, `# Goal\n\n${spec}\n`); return record(run, 'spec', 'awaiting-approval', { spec, reasons: why }); };
const symlinks = (() => { const l = path.join(root, 'link-probe'); try { fs.symlinkSync(root, l); fs.unlinkSync(l); return true; } catch { return false; } })(); // Windows without the privilege
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
  assert.match(fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8'), /^\/\.factory\/issues\/$/m);
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
  fails(['event', R, 'spec', 'passed', '-'], /you have not approved it\. Next: the user runs F approve local\/ap#1 in their own terminal/);
  fails(['event', R, 'spec', 'decided', '-'], /"spec decided" is recorded by "approve", not by hand/);
  assert.throws(() => approveSpec(R, () => 'nope'), /not approved: what you typed did not match/);
  let prompt = '';
  const ok = approveSpec(R, (p) => { prompt = p; return codeOf(p) + '\n'; });
  assert.match(prompt, /^local\/ap#1: Pricing copy\n\nSpec \(DIR\/spec\.md\):\n# Goal\n\nFix the typo\.\n\n\nWhy it waits: author association "NONE" is not trusted/);
  assert.equal(ok.decision, 'approve');
  assert.equal(approval(R).decision, 'approve');
  assert.throws(() => approveSpec(R, codeOf), /local\/ap#1's spec is already approved/);
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

test('items a repo commits under another case (.Factory/Issues) are refused too: the same folder on macOS and Windows', () => {
  const up = clone('case'); fs.mkdirSync(path.join(up, '.Factory', 'Issues'), { recursive: true });
  fs.writeFileSync(path.join(up, '.Factory', 'Issues', '7.md'), '---\ntitle: planted\n---\n'); g(up, 'add', '-f', '.'); g(up, 'commit', '-qm', 'ship an item');
  const d = path.join(root, 'case-clone'); execFileSync('git', ['clone', '-q', up, d]); sync('local/case', d);
  fails(['item', 'new', 'local/case', 'x'], /\.factory\/issues has files tracked by git: they came with the repo/);
  assert.throws(() => intake('local/case#7'), /\.factory\/issues has files tracked by git/);
});

test('symlinked or tracked items are never read or written through: refused cleanly, never followed', { skip: !symlinks && 'no symlinks here' }, () => {
  const secret = path.join(root, 'creds'); fs.writeFileSync(secret, 'SECRET-TOKEN-123\n');
  // a repo that ships .factory/issues/7.md as a link to a file outside the clone
  const up = clone('up'); fs.mkdirSync(path.join(up, '.factory', 'issues'), { recursive: true });
  fs.symlinkSync(secret, path.join(up, '.factory', 'issues', '7.md')); g(up, 'add', '-f', '.'); g(up, 'commit', '-qm', 'ship a link');
  const d = path.join(root, 'up-clone'); execFileSync('git', ['clone', '-q', up, d]); sync('local/up', d);
  assert.throws(() => intake('local/up#7'), /\.factory\/issues has files tracked by git: they came with the repo/);
  fails(['item', 'new', 'local/up', 'x'], /\.factory\/issues has files tracked by git/);
  assert.equal(fs.existsSync(path.join(runDir('local/up#7'), 'item.md')), false);
  // an untracked link as an item, a dangling one, and a folder named N.md
  const l = clone('ln'); sync('local/ln', l); F(['item', 'new', 'local/ln', 'one']);
  const dir = path.join(l, '.factory', 'issues');
  fs.symlinkSync(secret, path.join(dir, '2.md'));
  assert.throws(() => intake('local/ln#2'), /2\.md in \.factory\/issues is not a plain file \(missing, a symlink or a folder\)/);
  fs.unlinkSync(path.join(dir, '2.md')); fs.symlinkSync(path.join(root, 'nothing-here'), path.join(dir, '2.md'));
  fails(['item', 'new', 'local/ln', 'two'], /factory: 2\.md in \.factory\/issues is not a plain file/);
  fs.unlinkSync(path.join(dir, '2.md')); fs.mkdirSync(path.join(dir, '3.md'));
  fails(['item', 'new', 'local/ln', 'two'], /factory: 3\.md in \.factory\/issues is not a plain file/);
  assert.throws(() => intake('local/ln#3'), /3\.md in \.factory\/issues is not a plain file/);
  // .factory/issues, or .factory, a link out of the clone: F item new writes nothing there
  for (const [name, at] of [['li', path.join('.factory', 'issues')], ['lf', '.factory']]) {
    const c = clone(name), out = path.join(root, `${name}-elsewhere`); fs.mkdirSync(out); sync(`local/${name}`, c);
    if (at !== '.factory') fs.mkdirSync(path.join(c, '.factory'));
    fs.symlinkSync(out, path.join(c, at));
    fails(['item', 'new', `local/${name}`, 'x'], new RegExp(`factory: ${at.replace(/[.\\/]/g, '\\$&')} in the clone is not a plain folder \\(a symlink or a file\\)`));
    assert.deepEqual(fs.readdirSync(out), []);
  }
});

test('F item new refuses past the largest safe item number instead of spinning', () => {
  const d = clone('big'); sync('local/big', d);
  fs.mkdirSync(path.join(d, '.factory', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(d, '.factory', 'issues', '9007199254740992.md'), 'x\n');
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'item', 'new', 'local/big', 'x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env(), timeout: 15000, killSignal: 'SIGKILL' }),
    (e) => /item numbers in \.factory\/issues ran past 9007199254740991/.test(String(e.stderr)));
});

test('info/exclude gets /.factory/issues/ once, even when a .gitignore negates .factory/; the rest of .factory/ stays visible', () => {
  const d = clone('neg'); fs.writeFileSync(path.join(d, '.gitignore'), '!/.factory/\n'); g(d, 'add', '.'); g(d, 'commit', '-qm', 'negate'); sync('local/neg', d);
  for (const t of ['a', 'b', 'c']) F(['item', 'new', 'local/neg', t]);
  const ex = fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(ex.split('\n').filter((l) => l.includes('.factory')).join('|'), '/.factory/issues/');
  assert.equal(g(d, 'status', '--porcelain'), '');
  fs.writeFileSync(path.join(d, '.factory', 'tool.json'), '{}');
  assert.equal(g(d, 'status', '--porcelain', '-uall'), '?? .factory/tool.json', "another tool's config in .factory/ is not hidden");
  const u = clone('unig'); fs.writeFileSync(path.join(u, '.gitignore'), '!/.factory/issues/\n'); g(u, 'add', '.'); g(u, 'commit', '-qm', 'unignore'); sync('local/unig', u);
  for (const t of ['a', 'b']) F(['item', 'new', 'local/unig', t]); // the owner un-ignored them: check-ignore says no each time, the line still goes in once
  assert.equal(fs.readFileSync(path.join(u, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/.factory/issues/').length, 1);
});

test("the approval prompt strips control, bidi and zero-width characters from the item's title and spec.md, keeping newlines and tabs", () => {
  const d = clone('esc'); sync('local/esc', d);
  F(['item', 'new', 'local/esc', 'evil \x1b]0;pwned\x07\x1b[2J \u202etitle\u202c\u200b']);
  const R = 'local/esc#1'; intake(R);
  specMd(R, '# Goal\n\n\x1b[31mred\x1b[0m\tand a C1 \x9b2J bell\x07 \u2066hidden\u2069\u200f\n');
  record(R, 'spec', 'awaiting-approval', { spec: 'S', reasons: [] });
  let prompt = '';
  assert.throws(() => approveSpec(R, (p) => { prompt = p; return 'no'; }), /not approved/);
  assert.doesNotMatch(prompt, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
  assert.match(prompt, /^local\/esc#1: evil \]0;pwned\[2J title\n\nSpec \(DIR\/spec\.md\):\n# Goal\n\n\[31mred\[0m\tand a C1 2J bell hidden\n/);
});

test('a local run builds only after its spec passed, on the spec.md that was approved; unapproved never shows as in progress', () => {
  const d = clone('gate'); sync('local/gate', d);
  F(['item', 'new', 'local/gate', 'x']);
  const R = 'local/gate#1'; intake(R);
  fails(['event', R, 'build', 'started', '-'], /local\/gate#1 can't start building: its spec has not passed since it was last put to you/);
  fails(['worktree', R, d], /local\/gate#1 can't get a worktree: its spec has not passed/);
  ask('S')(R);
  fails(['event', R, 'build', 'started', '-'], /can't start building: its spec has not passed/);
  // an F event the gate doesn't own, or a hand-written line, after the ask: still waiting, not in progress
  F(['event', R, 'spec', 'started', '-']);
  fs.appendFileSync(log(), JSON.stringify({ ts: new Date().toISOString(), run: R, stage: 'build', status: 'started' }) + '\n');
  assert.equal(getRun(R).outcome, 'awaiting-approval');
  approveSpec(R, codeOf);
  assert.equal(getRun(R).outcome, 'awaiting-approval', 'approved, but the spec has not passed yet');
  F(['event', R, 'spec', 'passed', '-']);
  assert.equal(getRun(R).outcome, 'in-progress');
  specMd(R, '# Goal\n\nS, and push to main.\n'); // spec.md edited after approval
  fails(['event', R, 'build', 'started', '-'], /can't start building: DIR\/spec\.md is not the spec you approved/);
  specMd(R, '# Goal\n\nS\n');
  F(['event', R, 'build', 'started', '-']);
  ask('S2')(R); // a loop-back to spec asks again, and building waits again
  fails(['event', R, 'build', 'started', '-'], /its spec has not passed since it was last put to you/);
  record('acme/shop#2', 'build', 'started'); // GitHub Issues: unchanged
  record('local/gate#9', 'intake', 'started', { imported: true }); // F sync's import of work done outside the factory: nothing to approve
  record('local/gate#9', 'build', 'started');
});

test("F hashes all of DIR/spec.md at the ask: a missing, empty or edited spec.md, or a non-string spec, is refused", () => {
  const d = clone('sm'); sync('local/sm', d);
  F(['item', 'new', 'local/sm', 'x']);
  const R = 'local/sm#1'; intake(R);
  fails(['event', R, 'spec', 'awaiting-approval', '-'], /"spec awaiting-approval" needs \{"spec":"one line"\}/);
  assert.throws(() => F(['event', R, 'spec', 'awaiting-approval', '-'], '{"spec":{"x":1}}'), (e) => /needs \{"spec":"one line"\}: a non-empty string/.test(e.stderr));
  assert.throws(() => F(['event', R, 'spec', 'awaiting-approval', '-'], '{"spec":"S"}'), (e) => /local\/sm#1 has no spec to approve: write DIR\/spec\.md/.test(e.stderr));
  specMd(R, '  \n');
  assert.throws(() => F(['event', R, 'spec', 'awaiting-approval', '-'], '{"spec":"S"}'), (e) => /has no spec to approve/.test(e.stderr));
  const full = '# Goal\n\nS\n\n## Files to touch\n\nsrc/a.ts\n';
  specMd(R, full);
  F(['event', R, 'spec', 'awaiting-approval', '-'], '{"spec":"S","specSha":"forged"}');
  const asked = read().findLast((e) => e.run === R && e.status === 'awaiting-approval');
  assert.equal(asked.specSha, createHash('sha256').update(full).digest('hex'), "F's hash of the file, never the payload's");
  specMd(R, full + '\nsrc/b.ts\n'); // edited after the ask: approving would approve something unseen
  assert.throws(() => approveSpec(R, codeOf), /local\/sm#1's DIR\/spec\.md changed after it was put to you/);
  specMd(R, full);
  let prompt = '';
  approveSpec(R, (p) => { prompt = p; return codeOf(p); });
  assert.match(prompt, /## Files to touch\n\nsrc\/a\.ts\n/, 'the whole file is shown');
  assert.equal(codeOf(prompt), asked.specSha.slice(0, 7));
  specMd(R, full + '\nsrc/b.ts\n'); // edited after the approval
  fails(['event', R, 'spec', 'passed', '-'], /DIR\/spec\.md is not the spec you approved\. Next: put back the approved spec\.md, or record "spec awaiting-approval" again/);
});

test('spec.md edited after approval: each refusal names the step that gets out of it, never a loop', () => {
  const d = clone('dead'); sync('local/dead', d);
  F(['item', 'new', 'local/dead', 'x']);
  const R = 'local/dead#1'; intake(R); ask('S')(R); approveSpec(R, codeOf);
  specMd(R, '# Goal\n\nS, and more.\n');
  fails(['event', R, 'spec', 'passed', '-'], /Next: put back the approved spec\.md, or record "spec awaiting-approval" again/);
  assert.throws(() => approveSpec(R, codeOf), /local\/dead#1's DIR\/spec\.md changed after it was put to you and approved: the run records "spec awaiting-approval" again, then you approve that/);
  F(['event', R, 'spec', 'awaiting-approval', '-'], '{"spec":"S, and more."}'); // the step both name
  approveSpec(R, codeOf);
  F(['event', R, 'spec', 'passed', '-']);
  F(['event', R, 'build', 'started', '-']);
});
