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
import { facts, postmerge } from '../../core/src/github.ts';
import * as github from '../../adapters/hosts/github.ts';
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
if (/^pr (view|checks|ready|merge) \\D/.test(a)) { process.stderr.write('a PR URL: gh takes its repo over -R'); process.exit(4); }
if (a === 'api user --jq .login') out('stub-user\\n');
else if (a.startsWith('pr create')) out((process.env.STUB_NEW_PR || 'https://github.com/acme/cr/pull/9') + '\\n');
else if (a.includes('--json state,mergedAt')) out({ state: process.env.STUB_PR_STATE || 'OPEN', headRefName: process.env.STUB_HEAD || 'factory/issue-' + a.split(' ')[2], isCrossRepository: !!process.env.STUB_FORK, mergedAt: null });
else if (a.includes('--json bucket')) {
  const all = (process.env.STUB_BUCKETS || 'pass').split(','), n = fs.existsSync(${JSON.stringify(count)}) ? +fs.readFileSync(${JSON.stringify(count)}, 'utf8') : 0;
  fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
  out([{ bucket: all[Math.min(n, all.length - 1)] }]);
}
else if (a.includes('--json mergeCommit')) out({ mergeCommit: { oid: 'c'.repeat(40) } });
else if (a.startsWith('run list')) out([{ databaseId: 7, conclusion: 'failure' }, { databaseId: 8, conclusion: 'success' }]);
else if (a.startsWith('run view 7')) out(Array.from({ length: 200 }, (_, i) => 'log line ' + (i + 1) + (process.env.STUB_WIDE ? ' ' + 'é'.repeat(500) : '')).join('\\n') + '\\n');
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
  // iteration 2: the same change request, still open from the run's branch: nothing opened or recorded
  const before = read().length;
  process.env.STUB_HEAD = 'factory/issue-1';
  try { assert.deepEqual(openPr(run), { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-1', existing: true }); } finally { delete process.env.STUB_HEAD; }
  assert.deepEqual([calls().map((x) => x.a.split(' --json')[0]), read().length], [[c.a, 'pr view 9 -R acme/cr'], before]);
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
  assert.ok(calls().some((x) => x.a === 'pr checks 9 -R acme/cr --json bucket'), 'the PR number with -R, never its URL');
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

test('F event refuses a typed pr or branch; gh gets the PR number and -R; a recorded PR on another repo is refused before gh', () => {
  reset();
  const run = built(11);
  assert.match(F('event', run, 'build', 'passed', '{"pr":"https://github.com/evil/x/pull/1"}').stderr, /not from a payload: pr/);
  assert.match(F('event', run, 'build', 'passed', '{"branch":"main"}').stderr, /not from a payload: branch/);
  assert.equal(getRun(run).pr, undefined);
  record(run, 'build', 'opened', { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-11' });
  record(run, 'approve', 'decided', { action: 'merge', reasons: ['ok'] });
  record(run, 'approve', 'merged');
  postmerge(run);
  assert.ok(calls().some((x) => x.a === 'pr view 9 -R acme/cr --json mergeCommit'), calls().map((x) => x.a).join('; '));
  const seen = [], ctx = { gh: (...a) => { seen.push(a.join(' ')); return '{"state":"OPEN","headRefName":"b"}'; } };
  github.merge(ctx, { repo: 'acme/cr', id: 'https://github.com/acme/cr/pull/9', sha: 'abc' });
  github.changeRequest(ctx, { repo: 'acme/cr', id: 'https://github.com/acme/cr/pull/9' });
  assert.deepEqual(seen.map((x) => x.split(' --')[0]), ['pr ready 9 -R acme/cr', 'pr merge 9 -R acme/cr', 'pr view 9 -R acme/cr']);
  const r2 = built(12), evil = /https:\/\/github\.com\/evil\/x\/pull\/1 is not a pull request on acme\/cr/;
  record(r2, 'build', 'opened', { pr: 'https://github.com/evil/x/pull/1', branch: 'factory/issue-12' }); // an old log, from before the refusal
  record(r2, 'approve', 'decided', { action: 'escalate', reasons: ['x'] });
  reset(); seen.length = 0;
  for (const f of [() => escalate(r2), () => postmerge(r2), () => openPr(r2), () => github.merge(ctx, { repo: 'acme/cr', id: 'https://github.com/evil/x/pull/1', sha: 'abc' }),
    () => github.merge(ctx, { repo: 'acme/cr', id: 'https://github.com/acme/cr/pull/1/files', sha: 'abc' })]) assert.throws(f, /is not a pull request on acme\/cr/);
  assert.deepEqual([ciStatus(r2).state, ciStatus(r2).broken], ['unknown', `CI provider github-actions failed: ${'https://github.com/evil/x/pull/1'} is not a pull request on acme/cr: refusing to act on it`], 'fails closed');
  assert.throws(() => postmerge(r2), evil);
  assert.deepEqual([calls(), seen], [[], []], 'no gh call at all');
});

test('a new run after a revert has no PR; F pr reuses a recorded one only while it is open from the run\'s own branch', () => {
  reset();
  const run = built(13);
  record(run, 'build', 'opened', { pr: 'https://github.com/acme/cr/pull/9', branch: 'factory/issue-13' });
  record(run, 'approve', 'decided', { action: 'merge', reasons: ['ok'] });
  record(run, 'approve', 'merged');
  record(run, 'approve', 'reverted', { pr: 'https://github.com/acme/cr/pull/50', reason: 'main red' });
  record(run, 'intake', 'started', { title: 'Issue 13, again' });
  assert.deepEqual([getRun(run).pr, getRun(run).branch], [undefined, undefined]);
  process.env.STUB_NEW_PR = 'https://github.com/acme/cr/pull/14';
  try { assert.equal(openPr(run).pr, 'https://github.com/acme/cr/pull/14'); } finally { delete process.env.STUB_NEW_PR; }
  assert.ok(calls()[0].a.startsWith('pr create'));
  reset();
  const r = built(15);
  record(r, 'build', 'opened', { pr: 'https://github.com/acme/cr/pull/15', branch: 'factory/issue-15' });
  const refuse = (env, why) => {
    Object.assign(process.env, env);
    try { assert.throws(() => openPr(r), why); } finally { for (const k of Object.keys(env)) delete process.env[k]; }
  };
  refuse({ STUB_PR_STATE: 'MERGED' }, /acme\/cr#15's recorded change request https:\/\/github\.com\/acme\/cr\/pull\/15 is merged, not open from factory\/issue-15: start a new run \(F intake acme\/cr#15\)/);
  refuse({ STUB_PR_STATE: 'CLOSED' }, /is closed, not open from factory\/issue-15/);
  refuse({ STUB_HEAD: 'someone/else' }, /is open from someone\/else, not open from factory\/issue-15/);
  refuse({ STUB_FORK: '1' }, /is open from a fork's factory\/issue-15, not open from factory\/issue-15/);
  assert.equal(openPr(r).existing, true);
  assert.ok(!calls().some((x) => x.a.startsWith('pr create')), 'never a second PR');
});

test('F escalate with no decision still hands the PR to a human, saying F merge failed; a merge decision says why it escalates', () => {
  reset();
  const run = built(16);
  record(run, 'build', 'opened', { pr: 'https://github.com/acme/cr/pull/16', branch: 'factory/issue-16' });
  assert.deepEqual(escalate(run, { error: 'gh: refused at /Users/pat-private/x, ask @octocat' }), { on: 'pr', posted: true, labelled: true, ready: true });
  const body = () => JSON.parse(calls().find((c) => c.a.endsWith('/comments --input -')).input).body;
  assert.match(body(), /- no decision was recorded: F merge failed\n- F merge's error: gh: refused at \[local path\], ask @‍octocat/);
  assert.ok(!body().includes('pat-private'));
  reset();
  const cli = F('escalate', run, '--error', 'boom');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(body(), /F merge's error: boom/);
  record(run, 'approve', 'decided', { action: 'merge', reasons: ['trusted author (OWNER)', 'CI green'] });
  reset();
  escalate(run);
  assert.match(body(), /- F merge decided to merge, but the merge did not happen/);
  assert.ok(!/trusted author|CI green/.test(body()), body());
});

test('bounds: the CI log tail is cut by bytes too; the escalation comment is cut; @mentions in untrusted text never ping', () => {
  reset();
  const run = built(17, '# Goal\n\nAsk @acme/team and @octocat; mail t@example.com.\n');
  openPr(run);
  assert.match(calls()[0].a, /Ask @‍acme\/team and @‍octocat; mail t@example\.com\./);
  process.env.STUB_BUCKETS = 'fail'; process.env.STUB_WIDE = '1';
  try {
    const { log } = ciStatus(run);
    assert.ok(Buffer.byteLength(log) <= 16_384, String(Buffer.byteLength(log)));
    assert.match(log, /^log line \d+ é+\n[\s\S]*\nlog line 200 é+$/, 'whole lines, ending with the last');
  } finally { delete process.env.STUB_BUCKETS; delete process.env.STUB_WIDE; }
  record(run, 'review', 'started', { axes: ['code'] });
  record(run, 'review', 'failed', { axis: 'code', verdict: 'failed', findings: [{ severity: 'high', file: 'a.ts', issue: '@octocat ' + 'x'.repeat(70_000), route: 'build' }] });
  record(run, 'approve', 'decided', { action: 'escalate', reasons: ['code: 1 blocking finding(s)'] });
  reset();
  escalate(run);
  const body = JSON.parse(calls().find((c) => c.a.endsWith('/comments --input -')).input).body;
  assert.ok(body.length <= 60_100, String(body.length));
  assert.match(body, /high a\.ts @‍octocat x+/);
  assert.match(body, /… \(cut here: the rest is in the run's events\)$/);
});
