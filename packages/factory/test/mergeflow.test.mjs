// @ts-nocheck
// Local-first PR 7, the merge flow: the #137 gate for git-host merging, core merge() honouring the host's answer, and D1.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { passSpec, setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import * as host from '../../adapters/hosts/git.ts';
import { builtin } from '../../adapters/hosts/index.ts';
import { io, read, record } from '../../core/src/log.ts';
import { facts, merge, postmerge } from '../../core/src/github.ts';
import { sync } from '../../core/src/sync.ts';
import { decide } from '../../core/src/gate.ts';
import { derive } from '../../core/src/derive.ts';
import { approveMerge } from '../../core/src/approve.ts';
import { setAutoMerge, setRule } from '../../core/src/rules.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';

setup();
const NO_GH = path.join(HERE, 'test', 'no-such-gh'), STUB = path.join(HERE, 'test', 'gh-stub.mjs');
io.gh = NO_GH; // who acts: the OS user, unverified, unless a test points gh at the stub
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, ID);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-mergeflow-'));
const run = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const g = (cwd, ...a) => run('-C', cwd, ...a).trim();
const ctx = () => ({ gh: () => assert.fail('the git host never calls gh'), git: (...a) => run(...a) });
const commit = (d, file, text, msg = file) => { fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true }); fs.writeFileSync(path.join(d, file), text); g(d, 'add', '-f', file); g(d, 'commit', '-q', '-m', msg); return g(d, 'rev-parse', 'HEAD'); };
const repo = (name) => { const d = path.join(root, name); fs.mkdirSync(d); g(d, 'init', '-q', '-b', 'main'); commit(d, 'a.txt', 'a\n', 'init'); return d; };
const remote = (name) => { const bare = path.join(root, `${name}.git`), d = path.join(root, name); run('init', '-q', '--bare', '-b', 'main', bare); run('clone', '-q', bare, d); commit(d, 'a.txt', 'a\n', 'init'); g(d, 'push', '-q', 'origin', 'main'); return { bare, d }; };
const work = (d, n, file = `f${n}.txt`) => { g(d, 'checkout', '-q', '-b', `factory/issue-${n}`, 'main'); const sha = commit(d, file, `${n}\n`, `issue ${n}`); g(d, 'checkout', '-q', 'main'); return sha; };
const F = (...a) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ID, FACTORY_DIR: io.dir, FACTORY_GH: NO_GH } });
const project = (repo, p) => fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], ...p } }));

test('#137: with core.ignorecase, an ignored file differing only in case from one the squash adds is refused', () => {
  const d = repo('ic'); commit(d, '.gitignore', '*.o\n'); g(d, 'config', 'core.ignorecase', 'true');
  const sha = work(d, 1, 'foo.o'); fs.writeFileSync(path.join(d, 'Foo.o'), 'MINE\n');
  const at = g(d, 'rev-parse', 'main'), r = host.merge(ctx(), { repo: 'local/ic', path: d, id: 'factory/issue-1', sha, base: 'main' });
  assert.deepEqual([r.merged, r.detail?.includes('has an ignored file the merge would overwrite or delete (Foo.o)'), g(d, 'rev-parse', 'main'), fs.readFileSync(path.join(d, 'Foo.o'), 'utf8')], [false, true, at, 'MINE\n'], r.detail);
  g(d, 'config', 'core.ignorecase', 'false'); // case-sensitive: Foo.o is not in foo.o's way (on a case-insensitive disk they are one file, so only check the answer there)
  if (!fs.existsSync(path.join(d, 'FOO.O'))) assert.equal(host.merge(ctx(), { repo: 'local/ic', path: d, id: 'factory/issue-1', sha, base: 'main' }).merged, true);
});

test('#137: origin pushing somewhere it doesn\'t fetch from (pushurl, pushInsteadOf) is refused: the check read another repo', () => {
  for (const how of ['pushurl', 'pushInsteadOf', 'several']) { // several: remote.origin.url twice, so fetch and push both list both
    const { bare, d } = remote(`pu-${how}`), other = path.join(root, `pu-${how}-other.git`); run('clone', '-q', '--bare', bare, other);
    const sha = work(d, 1); g(d, 'push', '-q', 'origin', 'factory/issue-1');
    if (how === 'pushurl') g(d, 'config', 'remote.origin.pushurl', other); else if (how === 'several') g(d, 'remote', 'set-url', '--add', 'origin', other); else g(d, 'config', `url.${other}.pushInsteadOf`, bare);
    const before = [g(bare, 'rev-parse', 'main'), g(other, 'rev-parse', 'main')], r = host.merge(ctx(), { repo: 'acme/pu', path: d, id: 'factory/issue-1', sha, base: 'main' });
    assert.deepEqual([r.merged, r.detail], [false, 'origin pushes to a different URL than it fetches from (remote.origin.pushurl or url.*.pushInsteadOf), so the factory can\'t check the main it would push to: merge factory/issue-1 yourself, then F close RUN --merged <sha>'], how);
    assert.deepEqual([g(bare, 'rev-parse', 'main'), g(other, 'rev-parse', 'main')], before, `${how}: neither repo moved`);
  }
});

test('#137: worktree() fetches the base as refs/heads/<base>, so a tag named like it on origin never leaves origin/<base> stale', () => {
  const { bare, d } = remote('tg'); sync('local/tg', d);
  const up = path.join(root, 'tg-up'); run('clone', '-q', bare, up);
  g(up, 'tag', 'main', 'HEAD'); g(up, 'push', '-q', 'origin', 'refs/tags/main'); const moved = commit(up, 'b.txt', 'b\n'); g(up, 'push', '-q', 'origin', 'refs/heads/main:refs/heads/main');
  record('local/tg#1', 'intake', 'started', { title: 't' }); passSpec('local/tg#1');
  const wt = JSON.parse(F('worktree', 'local/tg#1')).path;
  assert.deepEqual([g(d, 'rev-parse', 'refs/remotes/origin/main'), g(wt, 'rev-parse', 'HEAD')], [moved, moved]);
});

test('#137: .git/info/attributes marking every file -diff never hides a git project\'s lines from the diff cap', () => {
  const d = repo('ia'); sync('local/ia', d);
  g(d, 'checkout', '-q', '-b', 'factory/issue-5'); commit(d, 'img.bin', 'x\0y\n'.repeat(50)); const s = commit(d, 'src/x.ts', 'a\n'.repeat(300)); g(d, 'checkout', '-q', 'main');
  fs.mkdirSync(path.join(d, '.git', 'info'), { recursive: true }); fs.writeFileSync(path.join(d, '.git', 'info', 'attributes'), '* -diff\n'); // a run's worktree shares this file
  const f = facts({ id: 'local/ia#5', events: [], reviewedSha: s });
  assert.deepEqual([f.additions, f.files], [300, ['img.bin', 'src/x.ts']], 'a real binary (a NUL in it) still counts 0, as on GitHub');
});

test('#137: a -diff file over 1 MB still counts every line, and a blob git can\'t read makes facts() throw (F merge refuses) instead of counting 0', () => {
  const d = repo('big'); sync('local/big', d);
  g(d, 'checkout', '-q', '-b', 'factory/issue-6'); const s = commit(d, 'gen/big.txt', 'a\n'.repeat(700_000)); g(d, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(d, '.git', 'info', 'attributes'), '* -diff\n');
  assert.equal(facts({ id: 'local/big#6', events: [], reviewedSha: s }).additions, 700_000, 'over execFileSync\'s 1 MB default buffer');
  const bin = path.join(root, 'no-cat-file.mjs'); // git, except that reading a blob fails
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst a = process.argv.slice(2);\nif (a.includes('cat-file') && a.includes('blob')) { process.stderr.write('fatal: cannot read blob\\n'); process.exit(128); }\nconst r = spawnSync('git', a, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`); fs.chmodSync(bin, 0o755);
  const prev = io.git; io.git = bin;
  try { assert.throws(() => facts({ id: 'local/big#6', events: [], reviewedSha: s }), /cannot read blob/); } finally { io.git = prev; }
});

test('#137: a -diff file whose name is pathspec magic (":(top)big.ts") still counts every line', () => {
  const d = repo('magic'); sync('local/magic', d);
  g(d, 'checkout', '-q', '-b', 'factory/issue-8');
  const blob = execFileSync('git', ['-C', d, 'hash-object', '-w', '--stdin'], { input: 'x\n'.repeat(5000), encoding: 'utf8' }).trim(); // plumbing: no file system takes this name on Windows
  for (const name of [':(top)big.ts', ':!x.ts', '*.ts']) g(d, 'update-index', '--add', '--cacheinfo', `100644,${blob},${name}`);
  g(d, 'commit', '-q', '-m', 'magic'); const s = g(d, 'rev-parse', 'HEAD'); g(d, 'checkout', '-q', '-f', 'main');
  fs.writeFileSync(path.join(d, '.git', 'info', 'attributes'), '* -diff\n');
  assert.equal(facts({ id: 'local/magic#8', events: [], reviewedSha: s }).additions, 15_000, 'each name read literally, never as a pathspec');
});

// ---- decide(): await-approval (local-first §0 D4, §3) ----
const SHA = 'a'.repeat(40);
const ok = { id: 'acme/d#1', iteration: 0, axes: { 0: ['code'] }, reviews: { 0: { code: { verdict: 'passed', findings: [] } } }, pr: '1', reviewedSha: SHA, association: 'OWNER', loopbacks: [], events: [] };
const green = { association: 'OWNER', autoMerge: true, checks: 'pass', additions: 3, deletions: 1, files: ['src/a.ts', 'src/a.test.ts'], rules: {} };
const yes = (sha = SHA, via = 'github') => ({ stage: 'approve', status: 'passed', by: 'pat', sha, via });
const LOCAL = 'tracker "local" cannot tell who wrote an item, so local/d#1\'s author is unknown and not trusted';
const onGit = { ...green, association: undefined, autoMerge: false, host: 'git', trustBroken: LOCAL, unverifiable: true };
const ASK_GIT = 'auto-merge is turned off for this project: it merges once you approve the reviewed commit (F approve RUN --merge)';
const ASK_GH = 'auto-merge is turned off for this project: merge the PR in GitHub yourself (F sync records it)';
test('decide: on GitHub, auto-merge off escalates, even with an approval of the reviewed commit; a git project waits for one (D4)', () => {
  const ask = { ...green, autoMerge: false };
  assert.deepEqual(decide(ok, ask), { action: 'escalate', reasons: [ASK_GH] });
  assert.deepEqual(decide({ ...ok, events: [yes()] }, ask), { action: 'escalate', reasons: [ASK_GH] }, 'a recorded approval never merges a GitHub project: the human merges in GitHub');
  const { autoMerge, ...noKey } = green; // facts with no autoMerge at all: fail closed
  assert.deepEqual(decide(ok, noKey), { action: 'escalate', reasons: [ASK_GH] });
  assert.deepEqual(decide(ok, { ...noKey, ...onGit, autoMerge: undefined }), { action: 'await-approval', reasons: [LOCAL, ASK_GIT] });
  assert.deepEqual(decide(ok, onGit), { action: 'await-approval', reasons: [LOCAL, ASK_GIT] });
  assert.equal(decide({ ...ok, events: [yes(SHA, 'local')] }, onGit).action, 'merge', 'on the git host the OS user approves');
  assert.match(decide({ ...ok, events: [yes(SHA, 'local')] }, onGit).reasons.join(), /merge approved by pat \(local, unverified\) for aaaaaaa/);
  assert.equal(decide({ ...ok, events: [yes('b'.repeat(40), 'local')] }, onGit).action, 'await-approval', 'an approval of another commit never counts');
  assert.equal(decide({ ...ok, events: [{ ...yes(SHA, 'local'), sha: undefined }] }, onGit).action, 'await-approval');
  assert.equal(decide({ ...ok, reviewedSha: undefined, events: [{ ...yes(SHA, 'local'), sha: undefined }] }, onGit).action, 'escalate');
  assert.equal(decide({ ...ok, origin: 'local/d#9', originAssociation: 'NONE', events: [yes(SHA, 'local')] }, onGit).action, 'merge', 'a git project\'s split child: its parent\'s author is unverifiable too');
  // with an approval of the reviewed commit, every other reason still escalates
  const approved = { ...ok, events: [yes(SHA, 'local')] };
  for (const [name, r, f] of [
    ['CI', approved, { ...onGit, checks: 'fail' }], ['CI broken', approved, { ...onGit, ciBroken: 'CI provider x failed' }], ['diff cap', approved, { ...onGit, additions: 900 }],
    ['sensitive', approved, { ...onGit, files: ['src/auth/a.ts', 'src/a.test.ts'] }], ['no tests', approved, { ...onGit, files: ['src/a.ts'] }],
    ['axes', { ...approved, reviews: { 0: { code: { verdict: 'failed', findings: [{ severity: 'high', issue: 'x', route: 'build' }] } } } }, onGit],
    ['no PR', { ...approved, pr: undefined }, onGit], ['loop cap', { ...approved, iteration: 9 }, onGit], ['head', approved, { ...onGit, headBroken: 'change request head is b, not the reviewed commit a' }],
    ['a broken tracker', approved, { ...onGit, unverifiable: undefined }], ['GitHub trust', { ...ok, events: [yes()] }, { ...green, autoMerge: false, association: 'NONE' }],
    ['GitHub origin', { ...ok, origin: 'acme/d#9', originAssociation: 'NONE', events: [yes()] }, { ...green, autoMerge: false }],
    ['preview', approved, { ...onGit, rules: { 'deploy.preview': { value: 'required', reason: 'r', setBy: 'pat', setAt: '2026-11-01' } } }],
  ]) assert.equal(decide(r, f).action, 'escalate', name);
});

// ---- D1: a project with no merge setting asks; turning auto-merge on is guarded ----
test('D1: facts() says auto-merge is off unless the project turned it on; a git project always asks (D4)', () => {
  const d = repo('d1'); sync('local/d1', d);
  const R = { id: 'local/d1#1', events: [] };
  assert.equal(facts(R).autoMerge, false);
  project('local/d1', { autoMerge: true });
  assert.equal(facts(R).autoMerge, false, 'the git host asks whatever the setting');
  assert.equal(facts(R).unverifiable, true, 'the local tracker: no author to verify (D4), so approvable');
  project('local/d1', { tracker: 'github-issues' }); // a broken config: never approvable
  assert.deepEqual([!!facts(R).trustBroken, facts(R).unverifiable], [true, undefined]);
  const prev = io.gh; io.gh = STUB;
  try {
    const G = { id: 'acme/app#33', events: [] };
    assert.equal(facts(G).autoMerge, false, 'no autoMerge key: ask');
    project('acme/app', { autoMerge: true }); assert.equal(facts(G).autoMerge, true);
    project('acme/app', { autoMerge: false }); assert.equal(facts(G).autoMerge, false);
  } finally { io.gh = prev; }
});
test('D1: turning auto-merge on is refused in an agent session, from an unverified login on GitHub, and on a git project; off is always allowed', () => {
  const d = repo('d2'); sync('local/d2', d); project('acme/app', { path: d, autoMerge: false });
  assert.throws(() => setAutoMerge('local/d2', true), /local\/d2 is a git project: it always asks before merging \(F approve RUN --merge\)/);
  assert.throws(() => setAutoMerge('acme/app', true), /turning auto-merge on for a GitHub project needs a verified login \(gh auth login\)/);
  const prev = io.gh; io.gh = STUB;
  try {
    process.env.CLAUDECODE = '1';
    try { assert.throws(() => setAutoMerge('acme/app', true), /turning auto-merge on must come from you, not from an agent session/); assert.equal(setAutoMerge('acme/app', false).autoMerge, false); }
    finally { delete process.env.CLAUDECODE; }
    assert.equal(setAutoMerge('acme/app', true).autoMerge, true);
  } finally { io.gh = prev; }
});

// ---- the merge itself: F approve RUN --merge, core merge() honouring the host ----
const ready = (R, d, n, branch = `factory/issue-${n}`, base = 'main') => { // a run whose every gate holds on a git project with CI provider local
  g(d, 'checkout', '-q', '-b', branch, base); const sha = commit(d, `n${n}.txt`, `${n}\n`, `issue ${n}`); g(d, 'checkout', '-q', base);
  record(R, 'intake', 'started', { title: `issue ${n}` });
  record(R, 'build', 'opened', { pr: `${branch}@${sha.slice(0, 7)}`, branch });
  record(R, 'review', 'started', { axes: ['code'], sha });
  record(R, 'review', 'passed', { axis: 'code', findings: [] });
  record(R, 'build', 'passed', { localChecks: { sha, state: 'pass', commands: [{ cmd: 'true', exit: 0 }] } });
  return sha;
};
const typeCode = (p) => /Type ([0-9a-f]{7}) to approve/.exec(p)[1];
test('F approve RUN --merge: a git project waits, then merges exactly the reviewed commit into its own base, once you type the code', () => {
  const d = repo('m1'); g(d, 'branch', 'trunk'); sync('local/m1', d); project('local/m1', { base: 'trunk', ci: 'local' });
  setRule('local/m1', 'checks.commands', '["true"]', { reason: 'local CI' });
  const R = 'local/m1#1', sha = ready(R, d, 1, 'factory/issue-1', 'trunk'), [trunk, main] = [g(d, 'rev-parse', 'trunk'), g(d, 'rev-parse', 'main')];
  const w = merge(R);
  assert.deepEqual([w.merged, w.action], [false, 'await-approval']);
  assert.equal(derive(read())[R].outcome, 'in-progress', 'waiting is neither escalated nor a spec wait');
  assert.throws(() => approveMerge(R, () => 'nope'), /not approved: what you typed did not match/);
  process.env.CLAUDECODE = '1';
  try { assert.throws(() => approveMerge(R, typeCode), /approving a merge must come from you, not from an agent session/); } finally { delete process.env.CLAUDECODE; }
  assert.equal(g(d, 'rev-parse', 'trunk'), trunk, 'nothing moved yet');
  let shown = ''; const m = approveMerge(R, (p) => { shown = p; return typeCode(p); });
  assert.match(shown, new RegExp(`${sha}`)); assert.match(shown, /n1\.txt/);
  assert.equal(m.merged, true);
  assert.deepEqual([g(d, 'rev-parse', 'trunk^'), g(d, 'show', 'trunk:n1.txt'), g(d, 'rev-parse', 'main')], [trunk, '1', main], 'squashed onto the project\'s base, trunk; main untouched');
  const run = derive(read())[R], merged = read().findLast((e) => e.run === R && e.status === 'merged');
  assert.deepEqual([run.outcome, merged.sha], ['merged', g(d, 'rev-parse', 'trunk')]);
  assert.deepEqual(postmerge(R), { sha: merged.sha, state: 'skipped', reason: 'CI provider local: trunk after the merge is not checked, so it never triggers a revert; run the checks.commands on trunk yourself' });
  assert.throws(() => approveMerge(R, typeCode), /local\/m1#1 is not waiting for a merge approval/);
  project('local/m1', { ci: 'none' });
  assert.deepEqual(postmerge(R), { sha: merged.sha, state: 'skipped', reason: 'CI provider none: trunk after the merge is not watched, so it never triggers a revert' }, 'no CI: nothing to poll');
});
test('core merge(): a host that answers merged:false escalates with its detail, never records merged; a head moved since review escalates first', () => {
  const d = repo('m2'); sync('local/m2', d); project('local/m2', { ci: 'local' }); setRule('local/m2', 'checks.commands', '["true"]', { reason: 'local CI' });
  const R = 'local/m2#2', sha = ready(R, d, 2);
  assert.equal(merge(R).action, 'await-approval');
  commit(d, 'n2.txt', 'conflict\n', 'main takes the same file'); const at = g(d, 'rev-parse', 'main');
  const m = approveMerge(R, typeCode);
  assert.deepEqual([m.merged, m.action, m.reasons], [false, 'escalate', [`the host refused the merge: factory/issue-2 conflicts with main: merge main into it, then review it again`]]);
  assert.deepEqual([g(d, 'rev-parse', 'main'), derive(read())[R].outcome, derive(read())[R].decision.action], [at, 'in-progress', 'escalate']);
  assert.equal(read().some((e) => e.run === R && e.status === 'merged'), false);
  const R3 = 'local/m2#3', s3 = ready(R3, d, 3);
  assert.equal(merge(R3).action, 'await-approval');
  g(d, 'checkout', '-q', 'factory/issue-3'); const later = commit(d, 'n3b.txt', 'x\n'); g(d, 'checkout', '-q', 'main');
  const h = approveMerge(R3, typeCode);
  assert.deepEqual([h.merged, h.action, h.reasons[0]], [false, 'escalate', `change request head is ${later.slice(0, 7)}, not the reviewed commit ${s3.slice(0, 7)}`]);
  assert.equal(g(d, 'rev-parse', 'main'), at);
});
test('core merge(): only merged === true counts as merged; anything else a host answers escalates', () => {
  const d = repo('m5'); sync('local/m5', d); project('local/m5', { ci: 'local' }); setRule('local/m5', 'checks.commands', '["true"]', { reason: 'local CI' });
  const real = builtin.git;
  try {
    for (const [n, answer, why] of [[1, { merged: 'false', detail: 'busy' }, 'busy'], [2, undefined, 'it gave no reason']]) {
      const R = `local/m5#${n}`; ready(R, d, n); assert.equal(merge(R).action, 'await-approval');
      builtin.git = { ...real, merge: () => answer };
      const m = approveMerge(R, typeCode);
      assert.deepEqual([m.merged, m.action, m.reasons], [false, 'escalate', [`the host refused the merge: ${why}`]]);
      assert.equal(read().some((e) => e.run === R && e.status === 'merged'), false);
      builtin.git = real;
    }
  } finally { builtin.git = real; }
});
test('F approve RUN --merge refuses a wait decided before the latest review: the prompt would show one commit with another\'s files', () => {
  const d = repo('m6'); sync('local/m6', d); project('local/m6', { ci: 'local' }); setRule('local/m6', 'checks.commands', '["true"]', { reason: 'local CI' });
  const R = 'local/m6#1'; ready(R, d, 1); assert.equal(merge(R).action, 'await-approval');
  g(d, 'checkout', '-q', 'factory/issue-1'); const b = commit(d, 'more.txt', 'b\n'.repeat(500)); g(d, 'checkout', '-q', 'main');
  record(R, 'review', 'started', { axes: ['code'], sha: b }); // a loop-back: commit b under review, the wait still recorded for a
  assert.equal(derive(read())[R].decision.action, 'await-approval', 'derive keeps the last decision');
  assert.throws(() => approveMerge(R, typeCode), /local\/m6#1 is not waiting for a merge approval/);
  assert.equal(read().some((e) => e.run === R && e.stage === 'approve' && e.status === 'passed'), false);
});
test('F merge on a git project with git older than 2.40 refuses, naming the version it needs', () => {
  const d = repo('gv'); sync('local/gv', d); const R = 'local/gv#1'; ready(R, d, 1);
  const bin = path.join(root, 'old-git.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node\nimport { spawnSync } from 'node:child_process';\nconst a = process.argv.slice(2);\nif (a[0] === 'version' || a[0] === '--version') { process.stdout.write('git version 2.39.5\\n'); process.exit(0); }\nconst r = spawnSync('git', a, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`); fs.chmodSync(bin, 0o755);
  const err = (() => { try { execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'merge', R], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: NO_GH, FACTORY_GIT: bin } }); } catch (e) { return String(e.stderr); } return ''; })();
  assert.match(err, /git 2\.39 is too old: the factory needs git 2\.40 or later/);
  assert.equal(read().some((e) => e.run === R && e.stage === 'approve'), false, 'nothing decided or merged');
});
test('D1: F sync says once per sync that a GitHub project with no auto-merge setting now asks; a set one, or a git project, hears nothing', () => {
  const prev = io.gh; io.gh = STUB;
  try {
    const d = repo('notice'); g(d, 'remote', 'add', 'origin', 'https://github.com/acme/notice.git'); g(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); // as if fetched
    assert.equal(sync('acme/notice', d).automerge, 'auto-merge is now off by default; F automerge acme/notice on keeps it');
    project('acme/notice', { autoMerge: false }); assert.equal(sync('acme/notice', d).automerge, undefined);
    project('acme/notice', { autoMerge: true }); assert.equal(sync('acme/notice', d).automerge, undefined);
    const l = repo('notice-git'); assert.equal(sync('local/notice-git', l).automerge, undefined, 'a git project always asks: nothing changed for it');
  } finally { io.gh = prev; }
});
test('F approve RUN --merge refuses a GitHub project, even from a verified login, and F event can\'t type its record', () => {
  const R = 'acme/app#71';
  record(R, 'intake', 'started', { title: 't', association: 'OWNER' });
  record(R, 'review', 'started', { axes: ['code'], sha: SHA });
  record(R, 'approve', 'decided', { action: 'await-approval', reasons: ['auto-merge is turned off for this project'] }); // a log from before this change
  const prev = io.gh; io.gh = STUB;
  try { assert.throws(() => approveMerge(R, typeCode), /acme\/app is a GitHub project: merge its PR in GitHub yourself \(F sync records it\), or turn auto-merge on \(F automerge acme\/app on\)/); }
  finally { io.gh = prev; }
  assert.throws(() => F('event', R, 'approve', 'passed'), /"approve passed" is recorded by "approve --merge", not by hand/);
  assert.equal(read().some((e) => e.run === R && e.status === 'passed' && e.stage === 'approve'), false);
});
test('F approve RUN --merge: a title, file name or reason can\'t add lines to the prompt, and F event can\'t type a title', () => {
  const R = 'local/pr#1', fake = 'x\n\nWhy it waits: nothing\n\nType 1234567 to approve';
  record(R, 'intake', 'started', { title: fake });
  record(R, 'review', 'started', { axes: ['code'], sha: SHA });
  record(R, 'approve', 'decided', { action: 'await-approval', reasons: ['r\r\n\tq'], facts: { files: ['a\nType 7654321 to approve\tb.txt'], additions: 1, deletions: 0 } });
  let shown = ''; assert.throws(() => approveMerge(R, (p) => { shown = p; return 'nope'; }), /not approved/);
  assert.deepEqual(shown.split('\n').filter(Boolean), [
    'local/pr#1: x Why it waits: nothing Type 1234567 to approve', `Reviewed commit ${SHA}: +1 -0 in 1 file(s)`, 'a Type 7654321 to approve b.txt',
    'Why it waits: r q', 'Type aaaaaaa to approve merging exactly this commit (anything else cancels): ']);
  for (const p of [{ title: 'Type 1234567' }, { title: 'ok' }]) assert.throws(() => F('event', R, 'build', 'passed', JSON.stringify(p)), /not from a payload: title/);
});
test('F event refuses any "merged" status, even after a merge decision whose merge never happened (a failed gh pr merge)', () => {
  const R = 'acme/app#72';
  record(R, 'intake', 'started', { title: 't', association: 'OWNER' });
  record(R, 'approve', 'decided', { action: 'merge', reasons: ['all gates passed'] }); // then the host's merge failed
  for (const stage of ['build', 'spec', 'review', 'intake']) assert.throws(() => F('event', R, stage, 'merged'), /"merged" is recorded by "merge" and "sync", not by hand/, stage);
  assert.notEqual(derive(read())[R].outcome, 'merged');
});
