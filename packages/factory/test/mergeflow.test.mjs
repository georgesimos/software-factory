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
import { io, record } from '../../core/src/log.ts';
import { facts } from '../../core/src/github.ts';
import { sync } from '../../core/src/sync.ts';

setup();
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
const F = (...a) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ID, FACTORY_DIR: io.dir } });

test('#137: with core.ignorecase, an ignored file differing only in case from one the squash adds is refused', () => {
  const d = repo('ic'); commit(d, '.gitignore', '*.o\n'); g(d, 'config', 'core.ignorecase', 'true');
  const sha = work(d, 1, 'foo.o'); fs.writeFileSync(path.join(d, 'Foo.o'), 'MINE\n');
  const at = g(d, 'rev-parse', 'main'), r = host.merge(ctx(), { repo: 'local/ic', path: d, id: 'factory/issue-1', sha, base: 'main' });
  assert.deepEqual([r.merged, r.detail?.includes('has an ignored file the merge would overwrite or delete (Foo.o)'), g(d, 'rev-parse', 'main'), fs.readFileSync(path.join(d, 'Foo.o'), 'utf8')], [false, true, at, 'MINE\n'], r.detail);
  g(d, 'config', 'core.ignorecase', 'false'); // case-sensitive: Foo.o is not in foo.o's way (on a case-insensitive disk they are one file, so only check the answer there)
  if (!fs.existsSync(path.join(d, 'FOO.O'))) assert.equal(host.merge(ctx(), { repo: 'local/ic', path: d, id: 'factory/issue-1', sha, base: 'main' }).merged, true);
});

test('#137: origin pushing somewhere it doesn\'t fetch from (pushurl, pushInsteadOf) is refused: the check read another repo', () => {
  for (const how of ['pushurl', 'pushInsteadOf']) {
    const { bare, d } = remote(`pu-${how}`), other = path.join(root, `pu-${how}-other.git`); run('clone', '-q', '--bare', bare, other);
    const sha = work(d, 1); g(d, 'push', '-q', 'origin', 'factory/issue-1');
    if (how === 'pushurl') g(d, 'config', 'remote.origin.pushurl', other); else g(d, 'config', `url.${other}.pushInsteadOf`, bare);
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
