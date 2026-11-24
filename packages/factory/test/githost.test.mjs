// @ts-nocheck
// The git host's change requests (docs/plans/local-first.md §1.2, local-first PR 4b): the branch is the change request, the
// merge is a squash that moves the base only by a plain push or a compare-and-swap, never by force; F close --merged.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import * as host from '../../adapters/hosts/git.ts';
import { derive } from '../../core/src/derive.ts';
import { io, read, record } from '../../core/src/log.ts';
import { closeMerged } from '../../core/src/projectset.ts';
import { sync } from '../../core/src/sync.ts';

setup();
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, ID); // commit-tree and the clones' commits need an identity
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-githost-'));
const run = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const g = (cwd, ...a) => run('-C', cwd, ...a).trim();
const ctx = (before = () => {}) => ({ gh: () => assert.fail('the git host never calls gh'), git: (...a) => { before(a); return run(...a); } });
const commit = (d, file, text, msg = file) => { fs.writeFileSync(path.join(d, file), text); g(d, 'add', file); g(d, 'commit', '-q', '-m', msg); return g(d, 'rev-parse', 'HEAD'); };
const repo = (name) => { const d = path.join(root, name); fs.mkdirSync(d); g(d, 'init', '-q', '-b', 'main'); commit(d, 'a.txt', 'a\n', 'init'); return d; };
const remote = (name) => { const bare = path.join(root, `${name}.git`), d = path.join(root, name); run('init', '-q', '--bare', '-b', 'main', bare); run('clone', '-q', bare, d); commit(d, 'a.txt', 'a\n', 'init'); g(d, 'push', '-q', 'origin', 'main'); return { bare, d }; };
const work = (d, n, file = `f${n}.txt`) => { g(d, 'checkout', '-q', '-b', `factory/issue-${n}`, 'main'); const sha = commit(d, file, `${n}\n`, `issue ${n}`); g(d, 'checkout', '-q', 'main'); return sha; };

test('no force flag anywhere in hosts/git.ts, and every update-ref compares against an old value', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'adapters', 'hosts', 'git.ts'), 'utf8');
  for (const re of [/--force/, /force-with-lease/, /--mirror/, /['"`]-f['"`]/, /['"`]\+[\w/$]/, /--no-verify/]) assert.doesNotMatch(src, re);
  const calls = src.split('\n').filter((l) => l.includes("'update-ref'"));
  assert.ok(calls.length >= 2);
  for (const l of calls) assert.match(l, /'update-ref', [^,()]+, [^,()]+, [^,()]+\)/, l.trim()); // ref, new, old: never two
});

test('with a remote: the branch is pushed, the squash goes up by a plain push, and a moved base is refused, untouched', () => {
  const { bare, d } = remote('r1'), head = work(d, 1);
  assert.deepEqual(host.openChangeRequest(ctx(), { repo: 'acme/r1', path: d, branch: 'factory/issue-1', base: 'main', title: 't', body: 'b' }), { id: `factory/issue-1@${head.slice(0, 7)}` });
  assert.equal(g(bare, 'rev-parse', 'refs/heads/factory/issue-1'), head);
  assert.deepEqual(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-1@x', base: 'main' }), { state: 'open', headSha: head, approval: null, branch: 'factory/issue-1' });
  assert.deepEqual(host.merge(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-1', sha: 'b'.repeat(40), base: 'main' }), { merged: false, detail: 'factory/issue-1 is not at the reviewed commit bbbbbbb' });
  const before = g(bare, 'rev-parse', 'main'), m = host.merge(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-1', sha: head, base: 'main' });
  assert.equal(m.merged, true);
  assert.deepEqual([g(bare, 'rev-parse', 'main'), g(bare, 'rev-parse', 'main^'), g(bare, 'show', 'main:f1.txt')], [m.sha, before, '1'], 'one squash commit on the base seen');
  assert.deepEqual(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-1@x', base: 'main' }), { state: 'merged', headSha: head, approval: null, branch: 'factory/issue-1', mergeSha: m.sha });
  // merged twice (a retry after the squash): nothing would change, so nothing is pushed
  assert.deepEqual(host.merge(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-1', sha: head }), { merged: false, detail: 'factory/issue-1 changes nothing on main: it is merged already, or empty' }, 'base from baseBranch() when not given');
  assert.equal(g(bare, 'rev-parse', 'main'), m.sha);
  // someone pushes to main between the factory's fetch and its push: the remote refuses the non-fast-forward
  const other = path.join(root, 'r1-other'); run('clone', '-q', bare, other);
  work(d, 2);
  host.openChangeRequest(ctx(), { repo: 'acme/r1', path: d, branch: 'factory/issue-2', base: 'main', title: 't', body: 'b' });
  g(d, 'checkout', '-q', 'factory/issue-2'); const head2 = commit(d, 'g2.txt', 'more\n'); g(d, 'checkout', '-q', 'main');
  assert.deepEqual(host.openChangeRequest(ctx(), { repo: 'acme/r1', path: d, branch: 'factory/issue-2', base: 'main', title: 't', body: 'b' }), { id: `factory/issue-2@${head2.slice(0, 7)}` });
  assert.equal(g(bare, 'rev-parse', 'refs/heads/factory/issue-2'), head2, 'opened again after more commits: a plain fast-forward push');
  let moved = '';
  const racing = ctx((a) => { if (a.includes('push') && a.some((x) => String(x).endsWith(':refs/heads/main')) && !moved) { g(other, 'pull', '-q'); moved = commit(other, 'z.txt', 'z\n'); g(other, 'push', '-q', 'origin', 'main'); } });
  const r = host.merge(racing, { repo: 'acme/r1', path: d, id: 'factory/issue-2', sha: head2, base: 'main' });
  assert.equal(r.merged, false);
  assert.match(r.detail, /^push to main refused \(.*\): merge factory\/issue-2 at your host, then F close RUN --merged <sha>$/);
  assert.equal(g(bare, 'rev-parse', 'main'), moved, 'the remote base is what the other push made, untouched by the factory');
  // a branch just cut from the base is on the base too: open, not merged
  g(d, 'fetch', '-q', 'origin'); g(d, 'branch', '-q', 'factory/issue-7', 'origin/main');
  assert.deepEqual(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-7', base: 'main' }), { state: 'open', headSha: moved, approval: null, branch: 'factory/issue-7' });
  // a commit whose message claims the factory's squash, but whose tree isn't one: not merged
  const head6 = work(d, 6); g(d, 'push', '-q', 'origin', 'factory/issue-6');
  g(other, 'pull', '-q'); commit(other, 'fake.txt', 'fake\n', `Squash of ${head6}, merged by the software factory.`); g(other, 'push', '-q', 'origin', 'main');
  for (const sha of [undefined, head6]) assert.equal(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-6', base: 'main', sha }).state, 'open', 'the message alone proves nothing');
  // a human fast-forwarded main to the reviewed commit: merged, and merging again pushes nothing
  g(d, 'fetch', '-q', 'origin'); g(d, 'checkout', '-q', '-b', 'factory/issue-8', 'origin/main'); const head8 = commit(d, 'f8.txt', '8\n'); g(d, 'checkout', '-q', 'main');
  g(d, 'push', '-q', 'origin', 'factory/issue-8:main');
  assert.equal(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-8', base: 'main' }).state, 'open', 'without the reviewed sha, being on the base proves nothing');
  assert.equal(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-8', base: 'main', sha: head8 }).state, 'merged');
  assert.deepEqual(host.merge(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-8', sha: head8, base: 'main' }), { merged: true, detail: `${head8.slice(0, 7)} is already on main` });
  assert.equal(g(bare, 'rev-parse', 'main'), head8, 'no empty squash on top');
});

test('no remote: a clean checked-out base fast-forwards with its files; a dirty one, a moved ref or a conflict is refused', () => {
  const d = repo('l1'), head = work(d, 1), seen = g(d, 'rev-parse', 'main');
  const m = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-1', sha: head, base: 'main' });
  assert.equal(m.merged, true);
  assert.deepEqual([g(d, 'rev-parse', 'main'), g(d, 'rev-parse', 'main^'), fs.readFileSync(path.join(d, 'f1.txt'), 'utf8').trim(), g(d, 'status', '--porcelain')], [m.sha, seen, '1', ''], 'the checked-out main and its files moved together');
  // dirty: refused, nothing moves
  const head2 = work(d, 2); fs.writeFileSync(path.join(d, 'a.txt'), 'edited\n');
  const at = g(d, 'rev-parse', 'main'), dirty = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-2', sha: head2, base: 'main' });
  assert.deepEqual([dirty.merged, /main is checked out with uncommitted changes in .*l1: commit or stash them/.test(dirty.detail), g(d, 'rev-parse', 'main')], [false, true, at]);
  g(d, 'checkout', '-q', '--', 'a.txt');
  // main not checked out anywhere: compare-and-swap; another commit lands on main meanwhile and the swap is refused
  g(d, 'checkout', '-q', '--detach');
  let moved = '';
  const racing = ctx((a) => { if (a.includes('update-ref') && !moved) { moved = run('-C', d, 'commit-tree', `${at}^{tree}`, '-p', at, '-m', 'meanwhile').trim(); run('-C', d, 'update-ref', 'refs/heads/main', moved, at); } });
  const cas = host.merge(racing, { repo: 'local/l1', path: d, id: 'factory/issue-2', sha: head2, base: 'main' });
  assert.deepEqual([cas.merged, /^main moved while merging/.test(cas.detail), g(d, 'rev-parse', 'main')], [false, true, moved]);
  const ok = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-2', sha: head2, base: 'main' });
  assert.deepEqual([ok.merged, g(d, 'rev-parse', 'main^')], [true, moved], 'merged again on the base as it is now');
  // a conflict: refused before anything moves
  g(d, 'checkout', '-q', 'main');
  const head3 = work(d, 3, 'a.txt'); commit(d, 'a.txt', 'main side\n');
  const c = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-3', sha: head3, base: 'main' });
  assert.deepEqual(c, { merged: false, detail: 'factory/issue-3 conflicts with main: merge main into it, then review it again' });
  const head4 = work(d, 4);
  const broken = host.merge(ctx((a) => { if (a.includes('merge-tree')) throw Object.assign(new Error('fatal: bad object'), { status: 128 }); }), { repo: 'local/l1', path: d, id: 'factory/issue-4', sha: head4, base: 'main' });
  assert.deepEqual(broken, { merged: false, detail: 'cannot merge factory/issue-4: fatal: bad object' }, 'only exit 1 is a conflict');
  // the checked-out main moves just before the swap, forwards or reset backwards: refused, never restored or advanced
  for (const move of [() => commit(d, 'w.txt', 'w\n'), () => { run('-C', d, 'reset', '-q', '--hard', 'HEAD~1'); return g(d, 'rev-parse', 'HEAD'); }]) {
    let to = ''; // moved on the call that moves main
    const race = host.merge(ctx((a) => { if ((a.includes('update-ref') || a.includes('--ff-only')) && !to) to = move(); }), { repo: 'local/l1', path: d, id: 'factory/issue-4', sha: head4, base: 'main' });
    assert.deepEqual([race.merged, /^main moved while merging/.test(race.detail), g(d, 'rev-parse', 'main'), g(d, 'status', '--porcelain')], [false, true, to, '']);
  }
  // an untracked file in the way: refused before the ref moves
  const head5 = work(d, 5), at5 = g(d, 'rev-parse', 'main'); fs.writeFileSync(path.join(d, 'f5.txt'), 'mine\n');
  const blocked = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-5', sha: head5, base: 'main' });
  assert.deepEqual([blocked.merged, /^cannot update main's files in .*l1: .*f5\.txt/.test(blocked.detail), g(d, 'rev-parse', 'main')], [false, true, at5], blocked.detail);
  fs.rmSync(path.join(d, 'f5.txt'));
  const ok5 = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-5', sha: head5, base: 'main' });
  assert.deepEqual([ok5.merged, g(d, 'rev-parse', 'main^'), fs.readFileSync(path.join(d, 'f5.txt'), 'utf8').trim(), g(d, 'status', '--porcelain')], [true, at5, '5', '']);
  assert.equal(host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-5', sha: head5, base: 'main' }).merged, false, 'merged twice: changes nothing');
  // main checked out in a worktree that was deleted: missing, never taken as clean
  g(d, 'checkout', '-q', '--detach'); const wt = path.join(root, 'l1-wt'); g(d, 'worktree', 'add', '-q', wt, 'main'); fs.rmSync(wt, { recursive: true, force: true });
  const gone = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-4', sha: head4, base: 'main' });
  assert.deepEqual([gone.merged, /^main is checked out in .*l1-wt, which is missing: git worktree prune/.test(gone.detail)], [false, true], gone.detail);
});

test('F close RUN --merged <sha>: yours only, git projects only, the sha on the base and containing the reviewed commit, the run escalated', () => {
  const { bare, d } = remote('c1');
  sync('local/c1', d);
  const R = 'local/c1#4', reviewed = work(d, 4, 'm.txt'); // the factory's branch: m.txt = "4"
  g(d, 'push', '-q', 'origin', 'factory/issue-4');
  record(R, 'intake', 'started', { title: 't' });
  const other = path.join(root, 'c1-other'); run('clone', '-q', bare, other);
  const onBase = (file, text, msg) => { g(other, 'pull', '-q'); const sha = commit(other, file, text, msg); g(other, 'push', '-q', 'origin', 'main'); return sha; };
  const init = g(bare, 'rev-parse', 'main'), unrelated = onBase('y.txt', 'y\n', 'unrelated'); // on the base, without the change
  // the user squash-merged at the remote's own UI: the same change as the reviewed commit, one new commit on main
  const squash = onBase('m.txt', '4\n', 'issue 4 (squash)'), later = onBase('z.txt', 'z\n', 'later'); // later: has the change, didn't bring it
  process.env.CLAUDECODE = '1';
  try { assert.throws(() => closeMerged(R, squash), /recording a merge must come from you, not from an agent session/); } finally { delete process.env.CLAUDECODE; }
  assert.throws(() => closeMerged('acme/app#1', squash), /acme\/app is on GitHub: F sync records a human merge there itself/);
  assert.throws(() => closeMerged(R, 'nope'), /"nope" is not a commit sha/);
  const stray = commit(other, 'x.txt', 'x\n'); g(other, 'reset', '-q', '--hard', 'HEAD~1');
  assert.throws(() => closeMerged(R, stray), /is not on main at origin in /, 'a commit that never reached the base');
  assert.throws(() => closeMerged(R, squash), /local\/c1#4 is not escalated/);
  record(R, 'approve', 'escalated', { reasons: ['push to main refused'] });
  assert.throws(() => closeMerged(R, squash), /local\/c1#4 has no reviewed commit/);
  record(R, 'review', 'started', { axes: ['code'], sha: reviewed });
  // on the base, but not the commit that merged it: commits before the squash, a later one, and one that changed it again
  const changed = onBase('m.txt', 'edited at the remote\n', 'issue 4, changed');
  for (const sha of [init, unrelated, later, changed]) assert.throws(() => closeMerged(R, sha), new RegExp(`${sha} is not the commit that merged the reviewed commit ${reviewed.slice(0, 7)}`), sha);
  assert.equal(derive(read())[R].outcome, 'escalated', 'every refusal leaves the run escalated');
  assert.deepEqual(closeMerged(R, squash.slice(0, 10)), { run: R, merged: true, sha: squash });
  const r = derive(read())[R];
  assert.deepEqual([r.outcome, r.humanMerge.sha], ['merged', squash]);
  const F = (...a) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: io.dir } });
  assert.throws(() => F('close', R), /usage: close <owner\/repo#N> --merged <sha>/);
  // a plain merge commit (the reviewed commit is its ancestor) also contains it; through the CLI
  const R2 = 'local/c1#5', reviewed2 = work(d, 5); g(d, 'push', '-q', 'origin', 'factory/issue-5');
  record(R2, 'intake', 'started', { title: 't' }); record(R2, 'review', 'started', { axes: ['code'], sha: reviewed2 }); record(R2, 'approve', 'escalated', { reasons: ['x'] });
  g(other, 'pull', '-q'); g(other, 'fetch', '-q', 'origin', 'factory/issue-5'); g(other, 'merge', '-q', '--no-ff', '--no-edit', 'FETCH_HEAD'); g(other, 'push', '-q', 'origin', 'main');
  const mergeCommit = g(other, 'rev-parse', 'main');
  g(other, 'revert', '--no-edit', '-m', '1', mergeCommit); g(other, 'push', '-q', 'origin', 'main'); // and reverted it
  assert.throws(() => closeMerged(R2, g(other, 'rev-parse', 'main')), /is not the commit that merged the reviewed commit/, 'a revert holds the reviewed commit, but did not bring it');
  assert.deepEqual(JSON.parse(F('close', R2, '--merged', mergeCommit)), { run: R2, merged: true, sha: mergeCommit });
  assert.equal(derive(read())[R2].humanMerge.sha, mergeCommit);
  // a reviewed commit this clone doesn't have: git's error, never "not contained"
  const R3 = 'local/c1#6'; record(R3, 'intake', 'started', { title: 't' }); record(R3, 'review', 'started', { axes: ['code'], sha: 'f'.repeat(40) }); record(R3, 'approve', 'escalated', { reasons: ['x'] });
  assert.throws(() => closeMerged(R3, squash), /cannot check [0-9a-f]+ against the reviewed commit fffffff: \S/);
});
