// @ts-nocheck
// Pipelines slice 3 (docs/plans/pipelines.md §3-§6, §7.5): the steps.off rule and the run caps. Turning a step off and raising
// a cap are loosenings: human-only, audited, and over HTTP only a request the desktop app confirms in its own dialog.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HERE } from '../factory.mjs';
import { CAP, COST_CAP } from '../../core/src/constants.ts';
import { derive } from '../../core/src/derive.ts';
import { axesFor, decide, gate } from '../../core/src/gate.ts';
import { io, read, record } from '../../core/src/log.ts';
import { asStrict, loosens, ruleChange, rules, setRule, unsetRule } from '../../core/src/rules.ts';
import { LOCKED_STEPS, readSkills, setSkill, skills, skillsFile } from '../../core/src/skills.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';
import { guarded, uiHandle } from '../../server/src/server.ts';
import { setup } from './setup.mjs';

setup();
const STUB = path.join(HERE, 'test', 'gh-stub.mjs'), NO_GH = path.join(os.tmpdir(), 'no-such-gh-binary');
io.gh = STUB;
fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/so': { path: '/x' } }));
const asAgent = (fn) => { process.env.CLAUDECODE = '1'; try { return fn(); } finally { delete process.env.CLAUDECODE; } };
const off = (repo) => rules(repo).policy['steps.off']?.value;

test('steps.off: a project rule of 1-10 distinct optional steps; locked steps, default and unknown axes are refused', () => {
  const p = setRule('acme/so', 'steps.off', '["review.seo","review.docs"]', { reason: 'a CLI tool with no pages' }).policy['steps.off'];
  assert.deepEqual([p.value, p.reason, p.setBy], [['review.seo', 'review.docs'], 'a CLI tool with no pages', 'stub-user']);
  const ev = read().filter((e) => e.stage === 'rules').at(-1);
  assert.deepEqual([ev.status, ev.key, ev.value, ev.reason, ev.setBy], ['set', 'steps.off', ['review.seo', 'review.docs'], 'a CLI tool with no pages', 'stub-user']);
  assert.throws(() => setRule('default', 'steps.off', '["review.seo"]', { reason: 'x' }), /steps\.off is a per-project rule: set it on owner\/repo, not default/);
  assert.throws(() => setRule('acme/so', 'steps.off', '["review.code"]', { reason: 'x' }), new RegExp(`review\\.code is locked: F always runs ${LOCKED_STEPS.join(', ').replace(/\./g, '\\.')}`));
  assert.throws(() => setRule('acme/so', 'steps.off', '["merge"]', { reason: 'x' }), /merge is locked/);
  for (const v of ['[]', '["review.seo","review.seo"]', '"review.seo"', `[${Array(11).fill('"review.ux"').join(',')}]`, '["seo"]', '["review.Bad"]'])
    assert.throws(() => setRule('acme/so', 'steps.off', v, { reason: 'x' }), /steps\.off: must be/, v);
  assert.throws(() => setRule('acme/so', 'steps.off', '["review.a11y"]', { reason: 'x' }), /review\.a11y: acme\/so has no extra axis a11y/);
  setSkill('acme/so', 'axes.extra', [{ axis: 'a11y', when: ['**/*.tsx'], use: 'skill', name: 'a11y-review' }]);
  assert.deepEqual(setRule('acme/so', 'steps.off', '["review.a11y"]', { reason: 'x' }).policy['steps.off'].value, ['review.a11y']);
  assert.throws(() => setRule('acme/so', 'steps.off', '["review.seo"]', {}), /needs a reason/);
  assert.deepEqual(off('acme/so'), ['review.a11y'], 'a refused write changes nothing');
  unsetRule('acme/so', 'steps.off'); setSkill('acme/so', 'axes.extra', undefined);
});

test('steps.off: every set is human-only, a smaller list included; unsetting it only tightens and is allowed anywhere', () => {
  setRule('acme/so', 'steps.off', '["review.seo","review.docs"]', { reason: 'no pages' });
  assert.throws(() => asAgent(() => setRule('acme/so', 'steps.off', '["review.seo"]', { reason: 'fewer' })), /turning a pipeline step off must come from you, not from an agent session \(CLAUDECODE is set\)/);
  assert.deepEqual(off('acme/so'), ['review.seo', 'review.docs']);
  asAgent(() => unsetRule('acme/so', 'steps.off'));
  assert.equal(off('acme/so'), undefined);
  assert.equal(asStrict('steps.off', ['review.seo'], ['review.seo', 'review.docs']), true, 'fewer steps off is stricter');
  assert.equal(asStrict('steps.off', ['review.seo', 'review.ux'], ['review.seo', 'review.docs']), false);
  assert.equal(asStrict('steps.off', ['review.seo', 'review.docs'], ['review.seo', 'review.docs']), true);
});

test('caps: run.loops and run.budgetUsd only go down freely; raising or unsetting one is human-only', () => {
  assert.throws(() => setRule('acme/so', 'run.loops', String(CAP + 1), { reason: 'x' }), new RegExp(`run\\.loops: must be an integer 1-${CAP}`));
  assert.throws(() => setRule('acme/so', 'run.budgetUsd', String(COST_CAP + 1), { reason: 'x' }), /run\.budgetUsd: must be dollars, above 0 and at most/);
  assert.throws(() => setRule('default', 'run.loops', '1', { reason: 'x' }), /run\.loops is a per-project rule/);
  asAgent(() => setRule('acme/so', 'run.loops', '2', { reason: 'small fixes' })); // lowering: free
  asAgent(() => setRule('acme/so', 'run.loops', '1', { reason: 'one try' }));
  asAgent(() => setRule('acme/so', 'run.loops', '1', { reason: 'the same' }));
  assert.throws(() => asAgent(() => setRule('acme/so', 'run.loops', '2', { reason: 'more' })), /raising a cap must come from you/);
  assert.throws(() => asAgent(() => unsetRule('acme/so', 'run.loops')), /raising a cap must come from you/, 'unset falls back to the built-in, a higher cap');
  setRule('acme/so', 'run.loops', '2', { reason: 'more' });
  unsetRule('acme/so', 'run.loops');
  asAgent(() => setRule('acme/so', 'run.budgetUsd', '2.5', { reason: 'cheap' }));
  assert.equal(rules('acme/so').policy['run.budgetUsd'].value, 2.5);
  assert.throws(() => asAgent(() => setRule('acme/so', 'run.budgetUsd', '3', { reason: 'more' })), /raising a cap/);
  unsetRule('acme/so', 'run.budgetUsd');
  // the one classifier the CLI, the route and the dialog share
  const cfg = readSkills();
  assert.deepEqual([loosens('acme/so', 'steps.off', ['review.seo'], cfg), loosens('acme/so', 'steps.off', undefined, cfg), loosens('acme/so', 'run.loops', 1, cfg), loosens('acme/so', 'run.loops', undefined, cfg), loosens('acme/so', 'ci', 'skip', cfg)],
    ['turning a pipeline step off', null, null, null, null], 'unset with nothing stored raises nothing');
});

test('from the page, core itself refuses a guarded write and names the CLI command; the rest still writes', () => {
  assert.throws(() => setRule('acme/so', 'steps.off', '["review.seo"]', { reason: 'no pages', page: true }),
    /turning a pipeline step off needs your confirmation outside the page: confirm it in the desktop app, or run in your own terminal: F rules set acme\/so steps\.off '\["review\.seo"\]' --reason "…"$/);
  assert.equal(off('acme/so'), undefined);
  setRule('acme/so', 'run.loops', '1', { reason: 'one try', page: true }); // lowering: from the page too
  assert.throws(() => setRule('acme/so', 'run.loops', '3', { reason: 'more', page: true, until: '2999-01-01' }), /F rules set acme\/so run\.loops 3 --reason "…" --until 2999-01-01$/);
  assert.throws(() => unsetRule('acme/so', 'run.loops', { page: true }), /raising a cap needs your confirmation .*: F rules unset acme\/so run\.loops$/);
  unsetRule('acme/so', 'run.loops');
  setRule('acme/so', 'steps.off', '["review.seo"]', { reason: 'no pages' });
  unsetRule('acme/so', 'steps.off', { page: true }); // tightening: allowed from the page
  // what the dialog shows comes from F: the stored value and the new one, normalized and checked
  setRule('acme/so', 'steps.off', '["review.seo"]', { reason: 'no pages' });
  const c = ruleChange('acme/so', 'steps.off', '["review.seo","review.docs"]', { reason: 'and docs' });
  assert.deepEqual([c.scope, c.key, c.stored, c.value, c.doing], ['acme/so', 'steps.off', ['review.seo'], ['review.seo', 'review.docs'], 'turning a pipeline step off']);
  assert.throws(() => ruleChange('acme/so', 'steps.off', '["review.code"]', { reason: 'x' }), /review\.code is locked/);
  assert.throws(() => ruleChange('acme/so', 'steps.off', '["review.ux"]', {}), /needs a reason/, 'an invalid request never reaches the dialog');
  unsetRule('acme/so', 'steps.off');
});

test('POST /api/onboard/rule: a guarded write is only requested; plain F ui refuses with the command; nothing is written', () => {
  const tok = 's'.repeat(32), ctx = { token: tok, port: 4545 }, H = { host: '127.0.0.1:4545', origin: 'http://127.0.0.1:4545', 'content-type': 'application/json', 'x-factory-token': tok };
  const post = (body) => uiHandle({ method: 'POST', url: '/api/onboard/rule', headers: H, body: JSON.stringify(body) }, ctx);
  const before = fs.readFileSync(skillsFile(), 'utf8'), events = read().length;
  let r = post({ scope: 'acme/so', key: 'steps.off', value: ['review.seo'], reason: 'no pages' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).error, /needs your confirmation outside the page: confirm it in the desktop app, or run in your own terminal: F rules set acme\/so steps\.off '\["review\.seo"\]' --reason "…"/);
  const asked = [];
  guarded.request = (x) => asked.push(x);
  try {
    r = post({ scope: 'acme/so', key: 'steps.off', value: ['review.seo'], reason: 'no pages' });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).requested, 'turning a pipeline step off');
    assert.deepEqual(asked, [{ scope: 'acme/so', key: 'steps.off', raw: '["review.seo"]', unset: false, reason: 'no pages' }]);
    assert.equal(post({ scope: 'acme/so', key: 'steps.off', value: ['review.code'], reason: 'x' }).status, 400, 'invalid: refused before any dialog');
    assert.equal(asked.length, 1);
    assert.deepEqual([fs.readFileSync(skillsFile(), 'utf8'), read().length], [before, events], 'a request writes nothing');
    assert.equal(post({ scope: 'acme/so', key: 'run.loops', value: 2, reason: 'lower' }).status, 200); // lowering: written straight away
    assert.equal(rules('acme/so').policy['run.loops'].value, 2);
    assert.equal(asked.length, 1);
  } finally { delete guarded.request; }
  unsetRule('acme/so', 'run.loops');
});

test('on read, pipelinePass drops what a hand edit got wrong, with warnings, and clamps caps; it never throws', () => {
  const cfg = JSON.parse(fs.readFileSync(skillsFile(), 'utf8'));
  const rule = (value) => ({ value, reason: 'hand edit', setBy: 'acme', setAt: '2026-11-24T10:00:00Z' });
  fs.writeFileSync(skillsFile(), JSON.stringify({ ...cfg,
    default: { rules: { 'steps.off': rule(['review.seo']), 'run.loops': rule(1) } },
    'acme/hand': { rules: { 'steps.off': rule(['review.seo', 'review.code', 'intake', 'review.nope', 'review.seo']), 'run.loops': rule(9), 'run.budgetUsd': rule(-1) } },
    'acme/bad': { rules: { 'steps.off': { value: 'review.seo' } } } }));
  const r = rules('acme/hand');
  assert.deepEqual(r.policy['steps.off'].value, ['review.seo']);
  assert.equal(r.policy['run.loops'].value, CAP, 'clamped to the built-in');
  assert.equal(r.policy['run.budgetUsd'], undefined);
  for (const w of [/default\.rules\.steps\.off is ignored: it is a per-project rule/, /acme\/hand\.rules\.steps\.off: ignoring review\.code, intake, review\.nope/, /acme\/hand\.rules\.run\.budgetUsd is ignored/, /acme\/hand\.rules\.run\.loops: 9 is above the built-in cap 3/])
    assert.ok(r.warnings.some((x) => w.test(x)), `${w} in ${JSON.stringify(r.warnings)}`);
  assert.equal(rules('acme/bad').policy['steps.off'], undefined);
  assert.equal(rules('acme/other').policy['run.loops'], undefined, 'default holds no cap rule');
  fs.writeFileSync(skillsFile(), JSON.stringify(cfg));
});

test('the pipeline shows what is off, who set it and why, and the effective caps; a local user is never named', () => {
  setRule('acme/so', 'steps.off', '["review.seo","review.docs"]', { reason: 'no pages', until: '2999-01-01' });
  setRule('acme/so', 'run.budgetUsd', '2', { reason: 'cheap' });
  const p = skills('acme/so').pipeline;
  assert.deepEqual(p.off, [{ step: 'review.seo', scope: 'acme/so', reason: 'no pages', by: 'stub-user', until: '2999-01-01' }, { step: 'review.docs', scope: 'acme/so', reason: 'no pages', by: 'stub-user', until: '2999-01-01' }]);
  assert.deepEqual(p.caps, { loops: CAP, budgetUsd: 2 });
  io.gh = NO_GH;
  try { unsetRule('acme/so', 'steps.off'); } catch { /* set by stub-user: a local user can't */ }
  io.gh = STUB; unsetRule('acme/so', 'steps.off'); io.gh = NO_GH;
  setRule('acme/so', 'steps.off', '["review.ux"]', { reason: 'mine' });
  assert.deepEqual(skills('acme/so').pipeline.off.map((o) => o.by), ['a local user (unverified)']);
  assert.ok(!JSON.stringify(skills('acme/so').pipeline).includes(os.userInfo().username + '"'));
  unsetRule('acme/so', 'steps.off'); io.gh = STUB; unsetRule('acme/so', 'run.budgetUsd');
});

test('axesFor drops what is off, never a locked axis, even when asked to', () => {
  const files = ['web/Button.tsx', 'pages/index.html', 'README.md'];
  assert.deepEqual(axesFor(files), ['code', 'security', 'ux', 'ui', 'seo', 'docs']);
  assert.deepEqual(axesFor(files, [], ['review.ui', 'review.docs']), ['code', 'security', 'ux', 'seo']);
  assert.deepEqual(axesFor(files, [], ['review.code', 'review.security', 'review.seo']), ['code', 'security', 'ux', 'ui', 'docs'], 'the locked list is checked again on read');
  assert.deepEqual(axesFor(files, [{ axis: 'a11y', when: ['**/*.tsx'] }], ['review.a11y']), ['code', 'security', 'ux', 'ui', 'seo', 'docs']);
});

test('F axes: the first review fixes the run\'s off list; later ones only shrink it; decide names every drop, from the record', () => {
  const RUN = 'acme/so#3', cli = (args) => JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: STUB } }));
  setRule('acme/so', 'steps.off', '["review.ui","review.seo"]', { reason: 'no pages' });
  record(RUN, 'intake', 'started', { association: 'OWNER' }); record(RUN, 'build', 'started');
  assert.deepEqual(cli(['axes', RUN, 'web/Button.tsx']).axes, ['code', 'security', 'ux']);
  const first = read().filter((e) => e.run === RUN && e.stage === 'review' && e.status === 'started').at(-1);
  assert.deepEqual([first.off, first.dropped, first.offRule], [['review.ui', 'review.seo'], ['review.ui'], { reason: 'no pages', by: 'stub-user' }]);
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'event', RUN, 'review', 'started', '{"axes":["code"],"off":["review.ui"]}'], { stdio: 'pipe', env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: STUB } }), /recorded by "axes"/);
  for (const a of ['code', 'security', 'ux']) record(RUN, 'review', 'passed', { axis: a, verdict: 'passed', findings: [] });
  setRule('acme/so', 'steps.off', '["review.ui","review.ux"]', { reason: 'and ux' }); // mid-run: ux is not in the snapshot
  record(RUN, 'build', 'started');
  const second = cli(['axes', RUN, 'web/Button.tsx']).axes;
  assert.deepEqual(second, ['code', 'security', 'ux']);
  unsetRule('acme/so', 'steps.off'); // unset mid-run: back on for this run
  record(RUN, 'build', 'started');
  assert.deepEqual(cli(['axes', RUN, 'web/Button.tsx']).axes, ['code', 'security', 'ux', 'ui']);
  // decide reads what was dropped from the run's own record, in every iteration, not the live rule (unset by now)
  const r = derive(read())[RUN];
  r.iteration = 1; r.pr = 'https://github.com/acme/so/pull/3'; r.reviewedSha = 'abc'; // iteration 1: ui was dropped
  const facts = { autoMerge: true, association: 'OWNER', checks: 'pass', files: ['web/Button.tsx', 'web/Button.test.tsx'], additions: 5, deletions: 0, rules: {} };
  const d = decide(r, facts);
  assert.equal(d.action, 'merge', d.reasons.join('; '));
  assert.ok(d.reasons.includes('review.ui off by rule steps.off, set by stub-user: no pages'), d.reasons.join('; '));
});

test('decide: a local user\'s steps.off counts toward no automatic merge on GitHub; a record from before this rule shapes nothing', () => {
  const ev = (stage, status, x = {}) => ({ ts: '2026-11-25T10:00:00Z', run: 'acme/so#4', stage, status, ...x });
  const facts = { autoMerge: true, association: 'OWNER', checks: 'pass', files: ['a.ts', 'a.test.ts'], additions: 5, deletions: 0, rules: {} };
  const base = [ev('intake', 'started', { association: 'OWNER' }), ev('build', 'started'), ev('build', 'opened', { pr: 'https://github.com/acme/so/pull/4' })];
  const passes = (axes) => axes.map((a) => ev('review', 'passed', { axis: a, verdict: 'passed', findings: [] }));
  const local = derive([...base, ev('review', 'started', { axes: ['code', 'security'], sha: 'abc', off: ['review.docs'], dropped: ['review.docs'], offRule: { reason: 'mine', by: 'a local user (unverified)', local: true } }), ...passes(['code', 'security'])])['acme/so#4'];
  const d = decide(local, facts);
  assert.equal(d.action, 'escalate');
  assert.ok(d.reasons.includes('rule steps.off was set by a local user (unverified): a rule that removes a review needs a verified login (gh auth login) before the factory merges on its own'), d.reasons.join('; '));
  assert.ok(d.reasons.includes('review.docs off by rule steps.off, set by a local user (unverified): mine'));
  assert.equal(decide(local, { ...facts, host: 'git' }).reasons.some((x) => /needs a verified login/.test(x)), false, 'a git project: shown, not escalated on');
  const old = derive([...base, ev('review', 'started', { axes: ['code', 'security'], sha: 'abc' }), ...passes(['code', 'security'])])['acme/so#4'];
  assert.equal(decide(old, facts).action, 'merge');
});

test('caps: gate and decide use the lower of run.loops / run.budgetUsd and the built-in', () => {
  const ev = (stage, status, x = {}) => ({ ts: '2026-11-25T10:00:00Z', run: 'acme/so#5', stage, status, ...x });
  const failed = derive([ev('intake', 'started', { association: 'OWNER' }), ev('build', 'started'), ev('review', 'started', { axes: ['code'] }),
    ev('review', 'failed', { axis: 'code', verdict: 'failed', findings: [{ severity: 'high', route: 'build', title: 'x' }] })])['acme/so#5'];
  assert.equal(gate(failed).next, 'build');
  const g = gate(failed, { loops: 1, budgetUsd: COST_CAP });
  assert.deepEqual([g.next, g.reasons.at(-1)], ['approve', 'loop cap 1 reached (rule run.loops)']);
  const spent = { ...failed, costUsd: 2.5 };
  assert.equal(gate(spent).next, 'build');
  assert.match(gate(spent, { loops: CAP, budgetUsd: 2 }).reasons.at(-1), /^budget reached \(\$2\.5/);
  const r = { ...failed, iteration: 2, pr: 'x', reviewedSha: 'abc' };
  const rl = (v) => ({ value: v, reason: 'x', setBy: 'acme', setAt: '2026-11-24T10:00:00Z' });
  assert.ok(decide(r, { rules: { 'run.loops': rl(1) } }).reasons.includes('iteration 2 exceeds cap 1 (rule run.loops)'));
  assert.ok(decide({ ...r, costUsd: 2.5 }, { rules: { 'run.budgetUsd': rl(2) } }).reasons.some((x) => /^run budget exceeded \(\$2\.5/.test(x)));
  assert.ok(!decide({ ...r, costUsd: 2.5 }, { rules: {} }).reasons.some((x) => /run budget exceeded/.test(x)));
});
