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
const commit = (d, file, text, msg = file) => { fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true }); fs.writeFileSync(path.join(d, file), text); g(d, 'add', '-f', file); g(d, 'commit', '-q', '-m', msg); return g(d, 'rev-parse', 'HEAD'); };
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
  assert.deepEqual(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-7', base: 'main' }), { state: 'open', headSha: moved, approval: null, branch: 'factory/issue-7', detail: `${moved.slice(0, 7)} is already on main: no changes to merge (if you merged it yourself: F close RUN --merged <sha>)` });
  // a commit whose message claims the factory's squash, but whose tree isn't one: not merged
  const head6 = work(d, 6); g(d, 'push', '-q', 'origin', 'factory/issue-6');
  g(other, 'pull', '-q'); commit(other, 'fake.txt', 'fake\n', `Squash of ${head6}, merged by the software factory.`); g(other, 'push', '-q', 'origin', 'main');
  for (const sha of [undefined, head6]) assert.equal(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-6', base: 'main', sha }).state, 'open', 'the message alone proves nothing');
  // a human fast-forwarded main to the reviewed commit: git can't tell that from an empty branch, so "no changes", and
  // merging pushes nothing; F close records the human's merge
  g(d, 'fetch', '-q', 'origin'); g(d, 'checkout', '-q', '-b', 'factory/issue-8', 'origin/main'); const head8 = commit(d, 'f8.txt', '8\n'); g(d, 'checkout', '-q', 'main');
  g(d, 'push', '-q', 'origin', 'factory/issue-8:main');
  assert.equal(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-8', base: 'main' }).state, 'open', 'without the reviewed sha, being on the base proves nothing');
  assert.deepEqual(host.changeRequest(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-8', base: 'main', sha: head8 }).state, 'open');
  assert.deepEqual(host.merge(ctx(), { repo: 'acme/r1', path: d, id: 'factory/issue-8', sha: head8, base: 'main' }), { merged: false, detail: `${head8.slice(0, 7)} is already on main: no changes to merge (if you merged it yourself: F close RUN --merged <sha>)` });
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
  // the files can't follow after the swap (an untracked file appears between the dry run and read-tree): the swap is undone
  const head9 = work(d, 9), at9 = g(d, 'rev-parse', 'main');
  const late = host.merge(ctx((a) => { if (a.includes('read-tree') && !a.includes('-n')) fs.writeFileSync(path.join(d, 'f9.txt'), 'mine\n'); }), { repo: 'local/l1', path: d, id: 'factory/issue-9', sha: head9, base: 'main' });
  assert.deepEqual([late.merged, /^cannot update main's files in .*l1 \(.*f9\.txt.*\): merge again$/.test(late.detail), g(d, 'rev-parse', 'main'), fs.readFileSync(path.join(d, 'f9.txt'), 'utf8')], [false, true, at9, 'mine\n'], late.detail);
  fs.rmSync(path.join(d, 'f9.txt'));
  // main checked out in a worktree that was deleted: missing, never taken as clean
  g(d, 'checkout', '-q', '--detach'); const wt = path.join(root, 'l1-wt'); g(d, 'worktree', 'add', '-q', wt, 'main'); fs.rmSync(wt, { recursive: true, force: true });
  const gone = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-4', sha: head4, base: 'main' });
  assert.deepEqual([gone.merged, /^main is checked out in .*l1-wt, which is missing: git worktree prune/.test(gone.detail)], [false, true], gone.detail);
});

test('a git older than 2.38 (no merge-tree --write-tree) says so, and is never read as a conflict', () => {
  const d = repo('v1'), head = work(d, 1), at = g(d, 'rev-parse', 'main');
  const old = (out) => { const c = ctx(); const git = c.git; return { ...c, git: (...a) => (a[0] === 'version' ? (out === null ? assert.fail('no git') : out) : git(...a)) }; };
  assert.deepEqual(host.merge(old('git version 2.30.1\n'), { repo: 'local/v1', path: d, id: 'factory/issue-1', sha: head, base: 'main' }), { merged: false, detail: 'git 2.30 is too old: merging needs git 2.38 or later (merge-tree --write-tree)' });
  assert.throws(() => host.mergeTree(old('git version 2.37.9').git, d, 'main', head), /git 2\.37 is too old/);
  assert.equal(host.mergeTreeMissing(old('git version 2.38.0').git), null);
  assert.deepEqual(host.merge(old(null), { repo: 'local/v1', path: d, id: 'factory/issue-1', sha: head, base: 'main' }), { merged: false, detail: 'cannot run git version: is git installed?' });
  assert.equal(g(d, 'rev-parse', 'main'), at, 'nothing moved');
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
  assert.throws(() => closeMerged(R, stray), /is an unknown or ambiguous commit in .*c1: give the full sha/, 'a commit this clone never had');
  assert.throws(() => closeMerged(R, reviewed), /is not on main at origin in /, 'the branch head, which never reached the base');
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

const NO_CHANGES = (sha) => `${sha.slice(0, 7)} is already on main: no changes to merge (if you merged it yourself: F close RUN --merged <sha>)`;

test('finding 1: origin\'s base reset backwards or deleted after the fetch is refused, and nothing is pushed', () => {
  for (const how of ['reset', 'delete']) {
    const { bare, d } = remote(`f1-${how}`), removed = commit(d, 'secret.txt', 'oops\n'); g(d, 'push', '-q', 'origin', 'main');
    const head = work(d, 1);
    let moved = false; // on the first call after the fetch that would see it: the ls-remote check, or (before the fix) the push
    const racing = ctx((a) => { if (!moved && (a.includes('ls-remote') || a.includes('push'))) { moved = true; how === 'reset' ? run('-C', bare, 'update-ref', 'refs/heads/main', `${removed}~1`) : run('-C', bare, 'update-ref', '-d', 'refs/heads/main'); } });
    const r = host.merge(racing, { repo: 'acme/f1', path: d, id: 'factory/issue-1', sha: head, base: 'main' });
    assert.equal(r.merged, false, how);
    assert.equal(r.detail, `main on origin moved while merging (${how === 'reset' ? `now ${g(d, 'rev-parse', `${removed}~1`).slice(0, 7)}` : 'deleted'}, was ${removed.slice(0, 7)}): review again`);
    if (how === 'reset') assert.equal(g(bare, 'rev-parse', 'main'), g(d, 'rev-parse', `${removed}~1`), 'the removed commit is not re-published');
    else assert.throws(() => g(bare, 'rev-parse', '--verify', '-q', 'refs/heads/main'), undefined, 'the deleted base is not re-created');
  }
});

test('finding 2: an ignored file the squash would overwrite or delete is refused before anything moves', () => {
  const d = repo('f2'); commit(d, '.gitignore', '*.log\n'); commit(d, 'dir/t.txt', 't\n');
  const log = work(d, 1, 'x.log'); fs.writeFileSync(path.join(d, 'x.log'), 'MINE\n'); // the squash adds x.log; an ignored one is here
  g(d, 'checkout', '-q', '-b', 'factory/issue-2', 'main'); g(d, 'rm', '-rq', 'dir'); const df = commit(d, 'dir', 'now a file\n'); g(d, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(d, 'dir', 'keep.log'), 'MINE\n'); // the squash turns dir into a file; an ignored file is inside
  const at = g(d, 'rev-parse', 'main');
  for (const [n, sha, file] of [[1, log, 'x.log'], [2, df, 'dir/keep.log']]) {
    const r = host.merge(ctx(), { repo: 'local/f2', path: d, id: `factory/issue-${n}`, sha, base: 'main' });
    assert.deepEqual([r.merged, r.detail?.includes(`has an ignored file the merge would overwrite or delete (${file})`), g(d, 'rev-parse', 'main'), fs.readFileSync(path.join(d, file), 'utf8')], [false, true, at, 'MINE\n'], r.detail);
  }
});

test('finding 3: the base checked out twice, or a checkout switching off or onto it during the merge, is refused and the swap undone', () => {
  const d = repo('f3'); g(d, 'checkout', '-q', '-b', 'other'); commit(d, 'o.txt', 'o\n'); g(d, 'checkout', '-q', 'main');
  const head = work(d, 1), seen = g(d, 'rev-parse', 'main');
  // twice: refused before anything moves
  const w2 = path.join(root, 'f3-two'); g(d, 'worktree', 'add', '-q', '--detach', w2); g(w2, 'checkout', '-q', '--ignore-other-worktrees', 'main');
  const two = host.merge(ctx(), { repo: 'local/f3', path: d, id: 'factory/issue-1', sha: head, base: 'main' });
  assert.deepEqual([two.merged, /^main is checked out in 2 worktrees/.test(two.detail), g(d, 'rev-parse', 'main'), g(d, 'status', '--porcelain'), g(w2, 'status', '--porcelain')], [false, true, seen, '', ''], two.detail);
  g(d, 'worktree', 'remove', '--force', w2);
  // the checkout leaves main (or another one takes it) just before the swap: the swap is undone, nothing is staged anywhere
  for (const [name, start, switchTo] of [['off', 'main', 'other'], ['onto', '--detach', 'main']]) {
    g(d, 'checkout', '-q', start);
    let switched = false;
    const r = host.merge(ctx((a) => { if (!switched && a.includes('update-ref')) { switched = true; run('-C', d, 'checkout', '-q', switchTo); } }), { repo: 'local/f3', path: d, id: 'factory/issue-1', sha: head, base: 'main' });
    assert.deepEqual([r.merged, r.detail, g(d, 'rev-parse', 'main'), g(d, 'status', '--porcelain'), fs.existsSync(path.join(d, 'f1.txt'))], [false, "main's checkouts changed while merging: merge again", seen, '', false], name);
    g(d, 'checkout', '-q', 'main');
  }
});

test('finding 4: F close reads origin\'s branch exactly, reports git\'s errors as git\'s, and needs exactly the reviewed change', () => {
  // (a) origin rewound main and has a tag named main: the commit it removed is not "on main"
  const { bare, d } = remote('f4'); sync('local/f4', d);
  const R = 'local/f4#4', reviewed = work(d, 4, 'm.txt'); g(d, 'push', '-q', 'origin', 'factory/issue-4');
  const other = path.join(root, 'f4-other'); run('clone', '-q', bare, other);
  const before = g(other, 'rev-parse', 'main'), squash = commit(other, 'm.txt', '4\n', 'squash'); g(other, 'push', '-q', 'origin', 'main');
  record(R, 'intake', 'started', { title: 't' }); record(R, 'review', 'started', { axes: ['code'], sha: reviewed }); record(R, 'approve', 'escalated', { reasons: ['x'] });
  g(d, 'fetch', '-q', 'origin'); // the clone saw the squash on main
  run('-C', bare, 'update-ref', 'refs/heads/main', before); run('-C', bare, 'tag', 'main', squash); // then origin rewound it
  assert.throws(() => closeMerged(R, squash), /is not on main at origin in /);
  // (b) git's own failures are named, not read as "not on main"
  assert.throws(() => closeMerged(R, 'deadbeef1'), /deadbeef1 is an unknown or ambiguous commit in /);
  assert.equal(derive(read())[R].outcome, 'escalated');
  // (c) the acceptance table for introduces(sha, reviewed)
  const t = repo('f4-table'), I = (sha, rev) => host.introduces(run, t, sha, rev), at = (ref) => g(t, 'rev-parse', ref);
  commit(t, 'a.txt', '1\n2\n3\n');
  g(t, 'checkout', '-q', '-b', 'f'); commit(t, 'a.txt', '1\nX\n3\n'); const rev = commit(t, 'b.txt', 'b\n'); // two commits
  g(t, 'checkout', '-q', 'main'); const moved = commit(t, 'u.txt', 'u\n'); // the base moved on meanwhile
  const squashOf = (name, onto, extra) => { g(t, 'checkout', '-q', '-b', name, onto); g(t, 'merge', '-q', '--squash', 'f'); if (extra) { fs.writeFileSync(path.join(t, extra), 'x\n'); g(t, 'add', extra); } g(t, 'commit', '-q', '-m', name); const s = at('HEAD'); g(t, 'checkout', '-q', 'main'); return s; };
  const sq = squashOf('sq', moved), extra = squashOf('extra', moved, 'evil.txt');
  g(t, 'checkout', '-q', '-b', 'mc', moved); g(t, 'merge', '-q', '--no-ff', '--no-edit', 'f'); const mergeCommit = at('HEAD');
  g(t, 'checkout', '-q', '-b', 'f2', `${moved}~1`); commit(t, 'c.txt', 'c\n'); g(t, 'merge', '-q', '--no-edit', moved); const rev2 = at('HEAD'); // the base merged into the branch
  g(t, 'checkout', '-q', '-b', 'mc2', moved); g(t, 'merge', '-q', '--no-ff', '--no-edit', 'f2'); const mergeCommit2 = at('HEAD');
  g(t, 'checkout', '-q', '-b', 'f3', moved); const ff1 = commit(t, 'd.txt', 'd\n'); // a one-commit branch, fast-forwarded
  g(t, 'checkout', '-q', '-b', 'part', moved); g(t, 'checkout', '-q', rev, '--', 'b.txt'); g(t, 'commit', '-q', '-m', 'part'); const part = at('HEAD');
  const rest = commit(t, 'a.txt', '1\nX\n3\n', 'rest');
  g(t, 'checkout', '-q', 'sq'); const later = commit(t, 'z.txt', 'z\n'); g(t, 'revert', '--no-edit', sq); const revert = at('HEAD');
  g(t, 'checkout', '-q', 'sq'); const again = commit(t, 'a.txt', '1\nY\n3\n');
  g(t, 'checkout', '-q', 'mc'); g(t, 'commit', '-q', '--allow-empty', '-m', 'empty'); const empty = at('HEAD'); // after the merge commit
  assert.deepEqual({ sq: I(sq, rev), mergeCommit: I(mergeCommit, rev), mergeCommit2: I(mergeCommit2, rev2), ff1: I(ff1, ff1), ffTip: I(rev, rev) },
    { sq: true, mergeCommit: true, mergeCommit2: true, ff1: true, ffTip: true }, 'accepted: a squash onto a moved base, merge commits, fast-forwards (a multi-commit one by its tip)');
  assert.deepEqual({ extra: I(extra, rev), part: I(part, rev), rest: I(rest, rev), later: I(later, rev), revert: I(revert, rev), again: I(again, rev), base: I(moved, rev), empty: I(empty, rev) },
    { extra: false, part: false, rest: false, later: false, revert: false, again: false, base: false, empty: false }, 'refused');
  assert.throws(() => I(sq, 'f'.repeat(40)), /f{40}|not a valid|bad object|unknown/i, 'an unknown reviewed commit is git\'s error');
  assert.throws(() => host.mergeTree(run, t, sq, 'f'.repeat(40)), /not something we can merge/, 'git exits 1 for an unknown commit too: no tree on stdout, so not a conflict');
});

test('finding 5: a branch with nothing beyond the base is never opened, merged or read as merged', () => {
  const d = repo('f5'); g(d, 'branch', 'factory/issue-1'); const base = g(d, 'rev-parse', 'main');
  assert.throws(() => host.openChangeRequest(ctx(), { repo: 'local/f5', path: d, branch: 'factory/issue-1', base: 'main', title: 't', body: 'b' }), /^Error: factory\/issue-1 has no commits beyond main: nothing to review$/);
  assert.deepEqual(host.changeRequest(ctx(), { repo: 'local/f5', path: d, id: 'factory/issue-1', base: 'main', sha: base }), { state: 'open', headSha: base, approval: null, branch: 'factory/issue-1', detail: NO_CHANGES(base) });
  assert.deepEqual(host.merge(ctx(), { repo: 'local/f5', path: d, id: 'factory/issue-1', sha: base, base: 'main' }), { merged: false, detail: NO_CHANGES(base) });
  assert.equal(g(d, 'rev-parse', 'main'), base);
  const { bare, d: c } = remote('f5r'); g(c, 'branch', 'factory/issue-1', 'origin/main');
  assert.throws(() => host.openChangeRequest(ctx(), { repo: 'acme/f5r', path: c, branch: 'factory/issue-1', base: 'main', title: 't', body: 'b' }), /has no commits beyond main/);
  assert.throws(() => g(bare, 'rev-parse', '--verify', '-q', 'refs/heads/factory/issue-1'), undefined, 'nothing was pushed');
});
