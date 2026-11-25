// @ts-nocheck
// CI providers (docs/plans/local-first.md §1.4): the contract for each, the project's provider in the gate and after a
// merge, the default per host, and failing closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { builtin, contract, load } from '../../adapters/ci/index.ts';
import { ciChecks, ciOf } from '../../core/src/ci.ts';
import { decide, localResult } from '../../core/src/gate.ts';
import { POSTMERGE_STATES, facts, postmerge } from '../../core/src/github.ts';
import { HERE } from '../factory.mjs';
import { io, record } from '../../core/src/log.ts';
import { setRule } from '../../core/src/rules.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';

setup();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-ci-'));
const SHA = 'a'.repeat(40), MERGED = 'b'.repeat(40), PR = 'https://github.com/acme/ci/pull/1';
// a gh that logs each call and answers only what facts() and postmerge() ask; STUB_* env vars pick the CI answer
const ghLog = path.join(root, 'gh.log'), ghStub = path.join(root, 'gh-ci.mjs');
fs.writeFileSync(ghStub, `import fs from 'node:fs';
const a = process.argv.slice(2).join(' '), out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
fs.appendFileSync(${JSON.stringify(ghLog)}, a + '\\n');
if (a === 'api user --jq .login') out('stub-user\\n');
else if (/^api repos\\/acme\\/ci\\/issues\\/\\d+ --jq \\.author_association$/.test(a)) out('OWNER\\n');
else if (a.includes('--json additions,deletions,files')) out({ additions: 3, deletions: 1, files: [{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }] });
else if (a.includes('--json bucket')) { if (process.env.STUB_CI_FAIL) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); } out([{ bucket: 'pass' }]); }
else if (a.includes('--json mergeCommit')) out({ mergeCommit: { oid: ${JSON.stringify(MERGED)} } });
else if (a.includes('--json defaultBranchRef')) out('main\\n');
else if (a.startsWith('run list')) out([{ status: 'completed', conclusion: 'success', name: 'ci', url: 'https://github.com/acme/ci/actions/runs/1' }]);
else process.exit(1);
`);
const calls = () => { try { return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const project = (repo, p) => fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: p }));
const rule = (value, by = 'stub-user', local = false) => ({ value, reason: 'r', setBy: by, setAt: '2026-11-01T00:00:00Z', ...(local && { via: 'local' }) });
// a run that merges when CI passes: every other merge condition holds
const run = { id: 'acme/ci#1', iteration: 0, axes: { 0: ['code', 'security'] }, reviews: { 0: { code: { verdict: 'passed', findings: [] }, security: { verdict: 'passed', findings: [] } } }, pr: PR, reviewedSha: SHA, association: 'OWNER', loopbacks: [], events: [] };
const green = { association: 'OWNER', autoMerge: true, checks: 'pass', additions: 3, deletions: 1, files: ['src/a.ts', 'src/a.test.ts'], rules: {} };
const ran = (sha = SHA, exit = 0) => ({ sha, state: exit ? 'fail' : 'pass', commands: [{ cmd: 'pnpm test', exit }] });

test('every provider in adapters/ci/ passes the contract, and each file there is one core can name', async () => {
  const gh = (...a) => { const s = a.join(' '); if (s.includes('--json bucket')) return '[{"bucket":"pass"}]'; if (s.startsWith('run list')) return '[]'; throw new Error(`unexpected gh ${s}`); };
  const ctx = { gh, git: () => '', local: () => ({ state: 'pass', text: 'Local checks: pass (pnpm test)' }) };
  for (const p of Object.values(builtin)) contract(p, { ctx, repo: 'acme/ci', sha: SHA });
  assert.deepEqual(Object.keys(await load()).sort(), Object.keys(builtin).sort(), 'a provider file not in builtin would be one no project could use');
  assert.deepEqual(builtin.local.checks(ctx, { repo: 'acme/ci', sha: SHA }), { state: 'pass', detail: 'Local checks: pass (pnpm test)' });
  assert.equal(builtin.none.checks().state, 'none');
});

test('localResult: F\'s own checks pass only on that commit, with that command list, every exit 0', () => {
  const cmds = ['pnpm test'];
  assert.deepEqual(localResult(ran(), cmds, SHA), { state: 'pass', text: 'Local checks: pass (pnpm test)' });
  assert.equal(localResult(ran(), undefined, SHA).state, 'none', 'no checks.commands rule: nothing was checked');
  assert.equal(localResult(undefined, cmds, SHA).state, 'none');
  assert.equal(localResult(ran('c'.repeat(40)), cmds, SHA).state, 'none', 'another commit');
  assert.equal(localResult({ state: 'pass', commands: [{ cmd: 'pnpm test', exit: 0 }] }, cmds, undefined).state, 'none', 'no reviewed commit never passes, even when neither has a sha');
  assert.equal(localResult(ran(), ['pnpm test', 'pnpm lint'], SHA).state, 'none', 'the rule changed since');
  assert.equal(localResult(ran(SHA, 1), cmds, SHA).state, 'fail');
});

test('decide: a provider that can\'t answer escalates under every ci rule; a local pass on a GitHub project needs a verified checks.commands', () => {
  assert.equal(decide(run, green).action, 'merge', 'the baseline merges');
  const broken = { ...green, checks: 'unknown', ciBroken: 'unknown CI provider "jenkins" in projects.json (github-actions|local|none)' };
  for (const ci of [undefined, 'required', 'advisory', 'skip']) {
    const d = decide(run, { ...broken, checks: ci === 'skip' ? 'skipped' : 'unknown', rules: ci ? { ci: rule(ci), 'checks.commands': rule(['pnpm test']) } : {} });
    assert.equal(d.action, 'escalate', `ci=${ci}`);
    assert.ok(d.reasons.includes(broken.ciBroken), `ci=${ci}: ${d.reasons}`);
  }
  // provider local: its pass rests on checks.commands, which on a GitHub project must be a verified login's
  const local = { ...green, ci: 'local', ciDetail: 'Local checks: pass (pnpm test)' }, checked = { ...run, localChecks: ran() }; // with checks.commands set, decide() wants them run too
  assert.equal(decide(checked, { ...local, rules: { 'checks.commands': rule(['pnpm test']) } }).action, 'merge');
  const d = decide(checked, { ...local, rules: { 'checks.commands': rule(['pnpm test'], 'pat', true) } });
  assert.equal(d.action, 'escalate');
  assert.match(d.reasons.join('\n'), /rule checks\.commands was set by pat \(local, unverified\): CI provider local passes on it, and on a GitHub project that needs a verified login/);
  assert.equal(decide(checked, { ...local, host: 'git', rules: { 'checks.commands': rule(['pnpm test'], 'pat', true) } }).action, 'merge', 'a git project: its authors are local anyway');
  // not passing: the provider says why
  assert.deepEqual(decide(run, { ...green, ci: 'local', checks: 'none', ciDetail: 'Local checks: not run ("F checks")' }).reasons, ['CI checks are "none" (local: Local checks: not run ("F checks"))']);
  assert.deepEqual(decide(run, { ...green, checks: 'fail' }).reasons, ['CI checks are "fail"'], 'GitHub\'s, as before');
  assert.deepEqual(decide(run, { ...green, checks: 'unknown', ciDetail: 'no commit to read CI for' }).reasons, ['CI checks are "unknown" (github-actions: no commit to read CI for)'], 'facts with no ci key are GitHub\'s');
});

test('facts and postmerge read the project\'s provider: GitHub\'s by default, F\'s own checks with ci local, and fail closed', () => {
  const gh = io.gh;
  try {
    io.gh = ghStub;
    project('acme/ci', {});
    assert.equal(ciOf('acme/ci'), 'github-actions');
    assert.equal(ciOf('local/x'), 'local', 'a git project with no ci set');
    // no ci key: what facts() always returned, but auto-merge off: no autoMerge key asks (D1, local-first PR 7)
    assert.deepEqual(facts(run), { association: 'OWNER', autoMerge: false, checks: 'pass', additions: 3, deletions: 1, files: ['src/a.ts', 'src/a.test.ts'], rules: {} });
    assert.ok(calls().some((c) => c.includes('pr checks')));
    record(run.id, 'build', 'passed', { pr: PR });
    assert.deepEqual(postmerge(run.id), { sha: MERGED, state: 'pass', failed: [] });
    // gh fails: never a pass, and never a crash
    process.env.STUB_CI_FAIL = '1';
    const down = facts(run);
    assert.deepEqual([down.checks, down.ciBroken], ['unknown', 'CI provider github-actions failed: HTTP 502: Bad Gateway']);
    setRule('acme/ci', 'ci', 'advisory', { reason: 'flaky' });
    assert.equal(decide(run, facts(run)).action, 'escalate', 'a throwing provider escalates under advisory too');
    delete process.env.STUB_CI_FAIL;
    // ci local: F's own checks on the reviewed commit, no gh pr checks
    project('acme/ci', { ci: 'local', autoMerge: true }); // D1: on, so the merge rests on CI alone
    setRule('acme/ci', 'ci', 'required', { reason: 'back on' });
    fs.rmSync(ghLog, { force: true });
    assert.deepEqual([facts(run).checks, facts(run).ciDetail], ['none', 'no checks.commands rule, so nothing was checked']);
    setRule('acme/ci', 'checks.commands', '["pnpm test"]', { reason: 'what CI ran' });
    const checked = { ...run, localChecks: ran() }, f = facts(checked);
    assert.deepEqual([f.checks, f.ci], ['pass', 'local']);
    assert.equal(decide(checked, f).action, 'merge');
    assert.ok(!calls().some((c) => c.includes('pr checks') || c.startsWith('run list')), 'GitHub CI is never read');
    // F checks never runs on the merge commit: a definite skipped that says so, never a "none" that can't change
    assert.deepEqual(postmerge(run.id), { sha: MERGED, state: 'skipped', reason: 'CI provider local: main after the merge is not checked, so it never triggers a revert; run the checks.commands on main yourself' });
    // an unknown provider: escalates even under ci=skip, and postmerge says unknown, never skipped
    project('acme/ci', { ci: 'jenkins' });
    setRule('acme/ci', 'ci', 'skip', { reason: 'no CI' });
    const j = facts(run);
    assert.deepEqual([j.checks, j.ciBroken], ['skipped', 'unknown CI provider "jenkins" in projects.json (github-actions|local|none)']);
    assert.ok(decide(run, j).reasons.includes(j.ciBroken));
    assert.deepEqual(postmerge(run.id), { sha: MERGED, state: 'unknown', reason: j.ciBroken });
    // GitHub's checks on a project not on GitHub: refused before any gh call
    project('acme/gx', { host: 'git', ci: 'github-actions' });
    fs.rmSync(ghLog, { force: true });
    assert.deepEqual(ciChecks('acme/gx', { sha: SHA }, () => assert.fail('not asked')), { ci: 'github-actions', state: 'unknown', broken: 'CI provider github-actions needs a project on GitHub, and acme/gx is not' });
    assert.deepEqual(calls(), []);
    // a provider off its contract (a state outside the five) or one that throws is unknown, never a pass
    builtin.odd = { id: 'odd', checks: () => ({ state: 'green' }) };
    builtin.boom = { id: 'boom', checks: () => { throw new Error('connection refused\nstack'); } };
    project('acme/ci', { ci: 'odd' });
    assert.deepEqual(ciChecks('acme/ci', { sha: SHA }, () => ({})), { ci: 'odd', state: 'unknown', broken: 'CI provider odd answered state "green"' });
    project('acme/ci', { ci: 'boom' });
    assert.deepEqual(ciChecks('acme/ci', { sha: SHA }, () => ({})), { ci: 'boom', state: 'unknown', broken: 'CI provider boom failed: connection refused' });
  } finally { io.gh = gh; delete process.env.STUB_CI_FAIL; delete builtin.odd; delete builtin.boom; }
});

test('SKILL.md §7 says what to do on every state F postmerge returns', () => {
  const md = fs.readFileSync(path.join(HERE, 'SKILL.md'), 'utf8'), s7 = md.slice(md.indexOf('## 7. Watch main'), md.indexOf('## Publish to the Artifact'));
  for (const st of POSTMERGE_STATES) assert.ok(s7.includes(`\`${st}\``), `§7 names "${st}"`);
  assert.match(s7, /`unknown`[^\n]*Stop polling[^\n]*factory:needs-human/);
});
