// @ts-nocheck
// The change-request side of a run behind the adapters (docs/plans/local-first.md PR 6): F pr opens it, F ci reads its CI,
// F escalate hands it to a human. Targets and text come from the run, never from what the session types.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import { ciStatus, escalate, openPr } from '../../core/src/changes.ts';
import { getRun } from '../../core/src/derive.ts';
import { decide } from '../../core/src/gate.ts';
import { facts } from '../../core/src/github.ts';
import { io, read, record, runDir } from '../../core/src/log.ts';
import { projects, projectsFile, wtFile } from '../../core/src/workspace.ts';

setup();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-changes-'));
const ghLog = path.join(root, 'gh.log'), ghStub = path.join(root, 'gh.mjs'), count = path.join(root, 'count');
// logs argv and stdin; STUB_BUCKETS: the answers to successive "pr checks" calls (the last one repeats)
fs.writeFileSync(ghStub, `import fs from 'node:fs';
const a = process.argv.slice(2).join(' '), out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const input = a.includes('--input -') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ a, input }) + '\\n');
if (a === 'api user --jq .login') out('stub-user\\n');
else if (a.startsWith('pr create')) out('https://github.com/acme/cr/pull/9\\n');
else if (a.includes('--json bucket')) {
  const all = (process.env.STUB_BUCKETS || 'pass').split(','), n = fs.existsSync(${JSON.stringify(count)}) ? +fs.readFileSync(${JSON.stringify(count)}, 'utf8') : 0;
  fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
  out([{ bucket: all[Math.min(n, all.length - 1)] }]);
}
else if (a.includes('--json mergeCommit')) out({ mergeCommit: { oid: 'c'.repeat(40) } });
else if (a.startsWith('run list')) out([{ databaseId: 7, conclusion: 'failure' }, { databaseId: 8, conclusion: 'success' }]);
else if (a.startsWith('run view 7')) out(Array.from({ length: 200 }, (_, i) => 'log line ' + (i + 1)).join('\\n') + '\\n');
else if (/^pr ready|^api -X POST repos\\/acme\\/cr\\/issues\\/\\d+\\/(labels|comments) --input -$/.test(a)) out('{}');
else process.exit(1);
`);
io.gh = ghStub;
const calls = () => { try { return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reset = () => { fs.rmSync(ghLog, { force: true }); fs.rmSync(count, { force: true }); };
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
const clone = fs.mkdtempSync(path.join(root, 'clone-'));
git('-C', clone, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n'); git('-C', clone, 'add', '.'); git('-C', clone, 'commit', '-qm', 'init');
fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/cr': { path: clone } }));
// A run past build: intake recorded its title, a spec, and a worktree on factory/issue-N (here the clone itself).
const built = (n, spec = '# Goal\n\nFix it.\n') => {
  const run = `acme/cr#${n}`;
  record(run, 'intake', 'started', { title: `Issue ${n}`, association: 'OWNER' });
  fs.mkdirSync(runDir(run), { recursive: true });
  fs.writeFileSync(path.join(runDir(run), 'spec.md'), spec);
  fs.writeFileSync(wtFile(run), JSON.stringify({ repoPath: clone, path: clone, branch: `factory/issue-${n}`, base: 'main' }));
  return run;
};
const F = (...args) => spawnSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: ghStub }, encoding: 'utf8' });

test('F pr: a draft from the run\'s branch, titled and closing from intake, with the spec; recorded by F, once', () => {
  reset();
  const run = built(1, '# Goal\n\nFix it.\n');
  assert.deepEqual(openPr(run), { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-1', url: 'https://github.com/acme/cr/pull/9' });
  const [c] = calls();
  assert.equal(c.a, 'pr create -R acme/cr --base main --head factory/issue-1 --title Issue 1 --body Closes #1\n\n# Goal\n\nFix it.\n --draft');
  const e = read().filter((x) => x.run === run).at(-1);
  assert.deepEqual([e.stage, e.status, e.pr, e.branch], ['build', 'opened', 'https://github.com/acme/cr/pull/9', 'factory/issue-1']);
  assert.equal(getRun(run).pr, 'https://github.com/acme/cr/pull/9');
  // iteration 2: the same change request, nothing opened or recorded
  const before = read().length;
  assert.deepEqual(openPr(run), { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-1', existing: true });
  assert.deepEqual([calls().length, read().length], [1, before]);
  assert.match(F('event', run, 'build', 'opened', '{}').stderr, /"build opened" is recorded by "pr", not by hand/);
});

test('F pr refuses an imported run, and one with no worktree or no spec', () => {
  reset();
  record('acme/cr#2', 'intake', 'started', { title: 'Theirs', imported: true });
  assert.throws(() => openPr('acme/cr#2'), /acme\/cr#2 is imported: the factory doesn't drive it/);
  const run = built(3);
  fs.rmSync(wtFile(run));
  assert.throws(() => openPr(run), /acme\/cr#3 has no worktree: run F worktree acme\/cr#3 first/);
  const r4 = built(4);
  fs.rmSync(path.join(runDir(r4), 'spec.md'));
  assert.throws(() => openPr(r4), /write DIR\/spec\.md/);
  assert.deepEqual(calls(), []);
});

test('F ci: the provider\'s answer on the worktree head; a failure carries the failed log\'s last 80 lines; --watch is bounded', () => {
  reset();
  const run = built(5);
  record(run, 'build', 'opened', { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-5' });
  process.env.STUB_BUCKETS = 'pass';
  assert.deepEqual(ciStatus(run), { state: 'pass', ci: 'github-actions' });
  reset(); process.env.STUB_BUCKETS = 'fail';
  const f = ciStatus(run), head = git('-C', clone, 'rev-parse', 'HEAD').trim();
  assert.equal(f.state, 'fail');
  assert.equal(f.log.split('\n').length, 80);
  assert.match(f.log, /^log line 121\n[\s\S]*\nlog line 200$/);
  assert.ok(calls().some((c) => c.a === `run list -R acme/cr --commit ${head} --json databaseId,conclusion`) && calls().some((c) => c.a === 'run view 7 -R acme/cr --log-failed'));
  reset(); process.env.STUB_BUCKETS = 'pending,pending,pass';
  assert.equal(ciStatus(run, { watch: true, every: 0, max: 60_000 }).state, 'pass');
  assert.equal(calls().filter((c) => c.a.includes('--json bucket')).length, 3);
  reset(); process.env.STUB_BUCKETS = 'pending';
  const t0 = Date.now();
  assert.equal(ciStatus(run, { watch: true, every: 10, max: 50 }).state, 'pending', 'never passes by waiting out the bound');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(ciStatus(run).state, 'pending', 'without --watch: one read');
  delete process.env.STUB_BUCKETS;
});

test('F escalate: ready, needs-human and one comment on the PR, from the decision and the open findings; no local user name', () => {
  reset();
  const run = built(6);
  record(run, 'build', 'opened', { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-6' });
  record(run, 'review', 'started', { axes: ['code', 'security'] });
  record(run, 'review', 'failed', { axis: 'security', verdict: 'failed', findings: [{ severity: 'high', file: 'src/a.ts', line: 3, issue: 'token logged', route: 'build' }, { severity: 'low', file: 'src/b.ts', issue: 'nit', route: 'build' }] });
  record(run, 'approve', 'decided', { action: 'escalate', reasons: ['security: 1 blocking finding(s)', 'rule ci=skip was set by DOMAIN\\pat-private (local, unverified): a rule that relaxes CI needs a verified login'] });
  const out = escalate(run);
  assert.deepEqual(out, { on: 'pr', posted: true, labelled: true, ready: true });
  const c = calls();
  assert.deepEqual(c.map((x) => x.a), ['pr ready 9 -R acme/cr', 'api -X POST repos/acme/cr/issues/9/labels --input -', 'api -X POST repos/acme/cr/issues/9/comments --input -']);
  assert.deepEqual(JSON.parse(c[1].input), { labels: ['factory:needs-human'] });
  const body = JSON.parse(c[2].input).body;
  assert.match(body, /security: 1 blocking finding\(s\)/);
  assert.match(body, /high src\/a\.ts:3 token logged/);
  assert.ok(!body.includes('nit'), 'only blocking findings');
  assert.ok(!body.includes('pat-private'), 'the OS user name never reaches GitHub');
  assert.match(body, /set by a local user \(local, unverified\)/);
});

test('F escalate: no PR means the issue, no ready; no decision is refused; an imported run is refused', () => {
  reset();
  const run = built(7);
  assert.throws(() => escalate(run), /acme\/cr#7 has no decision to escalate: run F merge acme\/cr#7 first/);
  record(run, 'approve', 'decided', { action: 'escalate', reasons: ['no PR recorded'] });
  assert.deepEqual(escalate(run), { on: 'issue', posted: true, labelled: true, ready: false });
  assert.deepEqual(calls().map((x) => x.a), ['api -X POST repos/acme/cr/issues/7/labels --input -', 'api -X POST repos/acme/cr/issues/7/comments --input -']);
  record('acme/cr#8', 'intake', 'started', { title: 'Theirs', imported: true });
  record('acme/cr#8', 'approve', 'decided', { action: 'escalate', reasons: ['x'] });
  assert.throws(() => escalate('acme/cr#8'), /is imported/);
});

test('a git project: F pr records the branch change request, it still escalates, and F escalate posts nothing', () => {
  reset();
  const g = fs.mkdtempSync(path.join(root, 'git-'));
  git('-C', g, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(g, 'a.txt'), 'a\n'); git('-C', g, 'add', '.'); git('-C', g, 'commit', '-qm', 'init');
  git('-C', g, 'checkout', '-qb', 'factory/issue-1'); fs.writeFileSync(path.join(g, 'a.txt'), 'b\n'); git('-C', g, 'commit', '-qam', 'change');
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'local/gp': { path: g } }));
  const run = 'local/gp#1';
  record(run, 'intake', 'started', { title: 'Local change' });
  fs.mkdirSync(runDir(run), { recursive: true });
  fs.writeFileSync(path.join(runDir(run), 'spec.md'), '# Goal\n\nb\n');
  fs.writeFileSync(wtFile(run), JSON.stringify({ repoPath: g, path: g, branch: 'factory/issue-1', base: 'main' }));
  const head = git('-C', g, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(openPr(run), { pr: `factory/issue-1@${head.slice(0, 7)}`, branch: 'factory/issue-1' });
  const d = decide(getRun(run), facts(getRun(run)));
  assert.equal(d.action, 'escalate', 'a local item is never trusted');
  assert.ok(!d.reasons.includes('no PR recorded'), d.reasons.join('; '));
  record(run, 'approve', 'decided', { action: 'escalate', reasons: ['an untrusted author'] });
  assert.deepEqual(escalate(run), { on: 'pr', posted: false, labelled: false, ready: false, detail: 'host git has no comments or labels: the escalation is in the dashboard and the run\'s events' });
  assert.deepEqual(calls(), [], 'no gh at all');
});

test('F escalate after a merge whose base CI can\'t be read: the comment says why, from F postmerge', () => {
  reset();
  const run = built(9);
  record(run, 'build', 'opened', { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-9' });
  record(run, 'approve', 'decided', { action: 'merge', reasons: ['all checks passed'] });
  record(run, 'approve', 'merged');
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/cr': { ...projects()['acme/cr'], ci: 'jenkins' } }));
  try {
    assert.equal(escalate(run).posted, true);
    const body = JSON.parse(calls().find((c) => c.a.endsWith('/comments --input -')).input).body;
    assert.match(body, /unknown CI provider "jenkins"/);
    assert.ok(!body.includes('all checks passed'), 'not the merge decision');
  } finally { fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/cr': { path: clone } })); }
});

test('F pr on a GitHub project with local items: the body names the factory item, never "Closes #N" (that would close an unrelated GitHub issue)', () => {
  reset();
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/cr': { path: clone, tracker: 'local' } }));
  try {
    const run = built(10);
    openPr(run);
    assert.match(calls()[0].a, / --body Factory item #10\n\n# Goal/);
    assert.ok(!calls()[0].a.includes('Closes #'));
  } finally { fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/cr': { path: clone } })); }
});
