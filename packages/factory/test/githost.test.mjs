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

test('no force flag anywhere in hosts/git.ts, and every update-ref compares against the sha it saw', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'adapters', 'hosts', 'git.ts'), 'utf8');
  for (const re of [/--force/, /force-with-lease/, /--mirror/, /['"`]-f['"`]/, /['"`]\+[\w/$]/, /--no-verify/]) assert.doesNotMatch(src, re);
  const calls = src.split('\n').filter((l) => l.includes("'update-ref'"));
  assert.ok(calls.length >= 2);
  for (const l of calls) assert.match(l, /'update-ref', [^)]*, seen\)/, l.trim());
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
  // someone pushes to main between the factory's fetch and its push: the remote refuses the non-fast-forward
  const other = path.join(root, 'r1-other'); run('clone', '-q', bare, other);
  const head2 = work(d, 2);
  let moved = '';
  const racing = ctx((a) => { if (a.includes('push') && a.some((x) => String(x).endsWith(':refs/heads/main')) && !moved) { g(other, 'pull', '-q'); moved = commit(other, 'z.txt', 'z\n'); g(other, 'push', '-q', 'origin', 'main'); } });
  const r = host.merge(racing, { repo: 'acme/r1', path: d, id: 'factory/issue-2', sha: head2, base: 'main' });
  assert.equal(r.merged, false);
  assert.match(r.detail, /^push to main refused \(.*\): merge factory\/issue-2 at your host, then F close RUN --merged <sha>$/);
  assert.equal(g(bare, 'rev-parse', 'main'), moved, 'the remote base is what the other push made, untouched by the factory');
});

test('no remote: a clean checked-out base fast-forwards with its files; a dirty one, a moved ref or a conflict is refused', () => {
  const d = repo('l1'), head = work(d, 1), seen = g(d, 'rev-parse', 'main');
  const m = host.merge(ctx(), { repo: 'local/l1', path: d, id: 'factory/issue-1', sha: head, base: 'main' });
  assert.equal(m.merged, true);
  assert.deepEqual([g(d, 'rev-parse', 'main'), g(d, 'rev-parse', 'main^'), fs.readFileSync(path.join(d, 'f1.txt'), 'utf8'), g(d, 'status', '--porcelain')], [m.sha, seen, '1\n', ''], 'the checked-out main and its files moved together');
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
  assert.deepEqual(c, { merged: false, detail: 'factory/issue-3 conflicts with main: rebase it on main, then review it again' });
});

test('F close RUN --merged <sha>: yours only, git projects only, the sha must be on the base, the run escalated', () => {
  const { bare, d } = remote('c1');
  sync('local/c1', d);
  const R = 'local/c1#4';
  record(R, 'intake', 'started', { title: 't' });
  // the user squash-merged at the remote's own UI
  const other = path.join(root, 'c1-other'); run('clone', '-q', bare, other);
  const merged = commit(other, 'm.txt', 'm\n', 'squash of issue 4'); g(other, 'push', '-q', 'origin', 'main');
  process.env.CLAUDECODE = '1';
  try { assert.throws(() => closeMerged(R, merged), /recording a merge must come from you, not from an agent session/); } finally { delete process.env.CLAUDECODE; }
  assert.throws(() => closeMerged('acme/app#1', merged), /acme\/app is on GitHub: F sync records a human merge there itself/);
  assert.throws(() => closeMerged(R, 'nope'), /"nope" is not a commit sha/);
  assert.throws(() => closeMerged(R, commit(other, 'x.txt', 'x\n')), /is not on main at origin in /, 'a commit that never reached the base');
  assert.throws(() => closeMerged(R, merged), /local\/c1#4 is not escalated/);
  record(R, 'approve', 'escalated', { reasons: ['push to main refused'] });
  assert.deepEqual(closeMerged(R, merged.slice(0, 10)), { run: R, merged: true, sha: merged });
  const r = derive(read())[R];
  assert.deepEqual([r.outcome, r.humanMerge.sha], ['merged', merged]);
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'close', R], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: io.dir } }), /usage: close <owner\/repo#N> --merged <sha>/);
});
