// Pipelines slice 5 (docs/plans/pipelines.md §3-§5, §7.1, §7.3-§7.4): custom steps at spec.after and build.after, a pipeline's
// added review steps (axes.on and its own axes.extra), one id namespace across a project and its pipelines, the guarded
// removals, F steps and F step, the refusals before build and review, the gate's loop-backs by slot and decide's escalations.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HERE } from '../factory.mjs';
import { io, read, record } from '../../core/src/log.ts';
import { loosens, rules, setRule } from '../../core/src/rules.ts';
import { readSkills, setSkill, skillChange, skills, skillsFile } from '../../core/src/skills.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';
import { setup } from './setup.mjs';
import { guarded, uiHandle } from '../../server/src/server.ts';

setup();
const STUB = path.join(HERE, 'test', 'gh-stub.mjs');
io.gh = STUB;
fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/cs': { path: '/x' } }));
const asAgent = (fn) => { process.env.CLAUDECODE = '1'; try { return fn(); } finally { delete process.env.CLAUDECODE; } };
const yes = (scope) => () => scope; // the scope's name, typed at the terminal
const no = () => { throw new Error('asked at the terminal'); }; // a write that must not ask
const F = (args, env = {}, input) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe', input, env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: STUB, ...env } });
const reset = () => { const cfg = readSkills(); for (const s of Object.keys(cfg)) if (s.startsWith('acme/cs') || s === 'default') delete cfg[s]; fs.writeFileSync(skillsFile(), JSON.stringify(cfg)); };
const LINT = { id: 'lint', slot: 'spec.after', use: 'skill', name: 'spec-lint' };
const E2E = { id: 'e2e', slot: 'build.after', use: 'brief', path: '/briefs/e2e.md', when: ['apps/web/**'] };
const SMOKE = { id: 'smoke', slot: 'build.after', use: 'skill', name: 'smoke' };
const A11Y = { axis: 'a11y', when: ['src/components/**'], use: 'skill', name: 'a11y-review' };
const hot = (id = 'hot', match = '[{"labels":["hotfix"]}]') => setRule(`acme/cs@${id}`, 'match', match, { reason: id, ask: yes(`acme/cs@${id}`) });

test('steps.custom: at most 10 steps, each a new lowercase id at spec.after or build.after with a runner that is not the default; when only at build.after', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [LINT, E2E], { ask: no });
  assert.deepEqual(readSkills()['acme/cs']['steps.custom'].map((x) => x.id), ['lint', 'e2e']);
  const bad = (v, re) => assert.throws(() => setSkill('acme/cs', 'steps.custom', v, { ask: no }), re, JSON.stringify(v));
  bad({}, /must be an array of at most 10 custom steps/);
  bad(Array.from({ length: 11 }, (_, i) => ({ ...SMOKE, id: `s${i}` })), /at most 10/);
  bad([{ ...SMOKE, id: 'Smoke' }], /custom step id "Smoke" must be a new lowercase name/);
  for (const id of ['build', 'security', 'gate', 'merge', 'watch', 'review', 'postmerge']) bad([{ ...SMOKE, id }], new RegExp(`custom step id "${id}" must be a new lowercase name, not one of F's steps or axes`));
  bad([SMOKE, SMOKE], /custom step "smoke" is listed twice/);
  bad([{ ...SMOKE, slot: 'review' }], /slot must be spec\.after or build\.after/);
  bad([{ ...SMOKE, slot: 'before.spec' }], /slot must be spec\.after or build\.after/);
  bad([{ id: 'x', slot: 'build.after', use: 'default' }], /has no built-in brief/);
  bad([{ ...LINT, when: ['docs/**'] }], /when is for build\.after only/);
  bad([{ ...SMOKE, when: [] }], /when must be 1-20 globs/);
  bad([{ ...SMOKE, kind: 'check', run: 'pnpm lint' }], /unknown fields kind, run/); // the photographed doc's shell check: not a custom step
  bad([{ ...SMOKE, next: { failed: 'escalate' } }], /unknown fields next/); // no branching
  assert.throws(() => setSkill('acme/cs', 'axes.on', ['review.ux']), /axes\.on is a pipeline's/);
});

test('a pipeline holds build.after custom steps and its added review steps: axes.on and its own axes.extra; spec.after stays the project\'s', () => {
  reset();
  hot();
  setSkill('acme/cs@hot', 'steps.custom', [SMOKE], { ask: no });
  setSkill('acme/cs@hot', 'axes.on', ['review.ux', 'review.ui'], { ask: no });
  setSkill('acme/cs@hot', 'axes.extra', [A11Y], { ask: no });
  const s = readSkills()['acme/cs@hot'];
  assert.deepEqual([s['steps.custom'][0].id, s['axes.on'], s['axes.extra'][0].axis], ['smoke', ['review.ux', 'review.ui'], 'a11y']);
  assert.throws(() => setSkill('acme/cs@hot', 'steps.custom', [LINT]), /spec\.after custom steps are the project's only/);
  for (const v of [[], ['review.code'], ['review.security'], ['review.ux', 'review.ux'], ['review.a11y']]) assert.throws(() => setSkill('acme/cs@hot', 'axes.on', v, { ask: no }), /must be 1-4 distinct optional review steps/, JSON.stringify(v));
  assert.deepEqual(rules('acme/cs').warnings.filter((w) => /steps\.custom|axes\./.test(w)), []);
});

test('ids are unique across a project and its pipelines, custom steps and extra axes together: refused on write, whichever side writes', () => {
  reset();
  hot(); hot('ui', '[{"files":["src/components/**"]}]');
  setSkill('acme/cs', 'steps.custom', [LINT, E2E], { ask: no });
  setSkill('acme/cs', 'axes.extra', [{ ...A11Y, axis: 'perf' }], { ask: no });
  setSkill('acme/cs@hot', 'steps.custom', [SMOKE], { ask: no });
  const clash = (scope, key, v, re) => assert.throws(() => setSkill(scope, key, v, { ask: no }), re, `${scope} ${key}`);
  clash('acme/cs@ui', 'steps.custom', [{ ...SMOKE, id: 'e2e' }], /"e2e" is already acme\/cs's: ids are unique across a project and its pipelines/);
  clash('acme/cs@ui', 'axes.extra', [{ ...A11Y, axis: 'lint' }], /"lint" is already acme\/cs's/); // a custom step's id and an extra axis's name share one namespace
  clash('acme/cs@ui', 'steps.custom', [SMOKE], /"smoke" is already acme\/cs@hot's/); // between two pipelines
  clash('acme/cs', 'steps.custom', [LINT, E2E, { ...SMOKE }], /"smoke" is already acme\/cs's: ids are unique/); // the project writing a pipeline's id: the pipeline's copy would be the one dropped
  clash('acme/cs', 'steps.custom', [LINT, E2E, { ...SMOKE, id: 'perf' }], /"perf" is both a custom step and an extra axis/);
  clash('default', 'steps.custom', [{ ...SMOKE }], /"smoke" is already acme\/cs's/); // default's steps run in every project
  setSkill('acme/cs@hot', 'steps.custom', [{ ...SMOKE, name: 'smoke-v2' }], { ask: no }); // its own id: a rewrite of its own list
});

test('end to end: on read a duplicate is dropped with a warning, keeping the project\'s copy, then the first pipeline\'s in pipelines order; decide escalates while it is', async () => {
  reset();
  hot(); hot('ui', '[{"files":["src/components/**"]}]');
  setRule('acme/cs', 'pipelines', '["ui","hot"]', { reason: 'ui first', ask: yes('acme/cs') });
  const cfg = JSON.parse(fs.readFileSync(skillsFile(), 'utf8')); // a hand edit F would refuse on write
  cfg['acme/cs']['steps.custom'] = [E2E];
  cfg['acme/cs@hot']['steps.custom'] = [{ ...SMOKE, name: 'hot-smoke' }, { id: 'e2e', slot: 'build.after', use: 'skill', name: 'hot-e2e' }];
  cfg['acme/cs@ui']['steps.custom'] = [{ ...SMOKE, name: 'ui-smoke' }];
  fs.writeFileSync(skillsFile(), JSON.stringify(cfg));
  const s = readSkills();
  assert.deepEqual(s['acme/cs']['steps.custom'].map((x) => x.id), ['e2e'], 'the project keeps its own');
  assert.deepEqual(s['acme/cs@ui']['steps.custom'].map((x) => x.name), ['ui-smoke'], 'ui is first in pipelines order: it keeps smoke');
  assert.deepEqual(s['acme/cs@hot']['steps.custom'], undefined, 'hot loses both: e2e is the project\'s, smoke is ui\'s');
  const w = rules('acme/cs').warnings.join('\n');
  assert.match(w, /acme\/cs@hot: "smoke" is ignored: acme\/cs@ui already has it \(ids are unique across a project and its pipelines\)/);
  assert.match(w, /acme\/cs@hot: "e2e" is ignored: acme\/cs already has it/);
  const { droppedFor } = await import('../../core/src/rules.ts');
  readSkills();
  assert.equal(droppedFor('acme/cs').length, 2, 'decide reads these and escalates');
  assert.deepEqual(droppedFor('acme/other'), []);
});

test('on read a broken steps.custom or axes.on is dropped whole with a warning: that scope runs the built-in pipeline, and decide escalates', async () => {
  reset();
  hot();
  const cfg = JSON.parse(fs.readFileSync(skillsFile(), 'utf8'));
  cfg['acme/cs'] = { ...cfg['acme/cs'], 'steps.custom': [LINT, { id: 'Bad', slot: 'spec.after', use: 'skill', name: 'x' }] };
  cfg['acme/cs@hot'] = { ...cfg['acme/cs@hot'], 'steps.custom': [LINT], 'axes.on': ['review.code'] };
  fs.writeFileSync(skillsFile(), JSON.stringify(cfg));
  const s = readSkills(), w = rules('acme/cs').warnings.join('\n');
  assert.equal(s['acme/cs']['steps.custom'], undefined, 'not some of the steps in a broken order: none');
  assert.equal(s['acme/cs@hot']['steps.custom'], undefined);
  assert.equal(s['acme/cs@hot']['axes.on'], undefined);
  assert.match(w, /acme\/cs\.steps\.custom is ignored: custom step id "Bad" must be a new lowercase name.*, so that scope runs the built-in pipeline/);
  assert.match(w, /acme\/cs@hot\.steps\.custom is ignored: spec\.after custom steps are the project's only/);
  assert.match(w, /acme\/cs@hot\.axes\.on is ignored: .*, so it adds no reviews/);
  const { droppedFor } = await import('../../core/src/rules.ts');
  readSkills();
  assert.equal(droppedFor('acme/cs').length, 3);
  assert.deepEqual(skills('acme/cs').pipeline.warnings.filter((x) => /steps\.custom/.test(x)).map((x) => x.match(/acme\/cs\S*/)[0]), ['acme/cs@hot.steps.custom', 'acme/cs.steps.custom'], 'the page shows the project\'s and its pipelines\'');
});

test('adding or reordering custom steps is free; removing one, moving it to another slot or narrowing its when is human-only, with a reason, typed and audited', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [LINT, E2E], { ask: no });
  asAgent(() => setSkill('acme/cs', 'steps.custom', [E2E, LINT, SMOKE], { ask: no })); // reorder and add: only adds checks
  asAgent(() => setSkill('acme/cs', 'steps.custom', [{ ...E2E, when: undefined }, LINT, SMOKE], { ask: no })); // no when: every change, the widest
  const cases = [
    [[LINT, SMOKE], 'removing a custom step'],
    [[E2E, LINT, SMOKE], 'narrowing when a custom step runs'],
    [[{ ...SMOKE, id: 'e2e' }, LINT, { ...SMOKE, slot: 'spec.after' }], 'removing a custom step'], // smoke moved to spec.after: it no longer runs where it did
    [undefined, 'removing a custom step'],
  ];
  for (const [v, doing] of cases) {
    assert.throws(() => asAgent(() => setSkill('acme/cs', 'steps.custom', v, { reason: 'x', ask: no })), new RegExp(`^Error: ${doing} must come from you, not from an agent session`), doing);
    assert.throws(() => setSkill('acme/cs', 'steps.custom', v, { ask: no }), new RegExp(`${doing} needs a reason`));
    assert.throws(() => setSkill('acme/cs', 'steps.custom', v, { reason: 'x', ask: () => 'acme/other' }), /acme\/cs's steps\.custom stays as it is: what you typed did not match/);
    assert.throws(() => setSkill('acme/cs', 'steps.custom', v, { reason: 'x', page: true }), new RegExp(`${doing} needs your confirmation outside the page: .*run in your own terminal: F skills ${v === undefined ? 'unset' : 'set'} acme/cs steps\\.custom`));
    assert.equal(skillChange('acme/cs', 'steps.custom', v).doing, doing);
  }
  assert.deepEqual(readSkills()['acme/cs']['steps.custom'].map((x) => x.id), ['e2e', 'lint', 'smoke'], 'nothing was written');
  let asked = '';
  setSkill('acme/cs', 'steps.custom', [LINT, SMOKE], { reason: 'e2e moved to CI', ask: (p) => { asked = p; return 'acme/cs'; } });
  assert.match(asked, /^acme\/cs: removing a custom step\nsteps\.custom: e2e \(build\.after\), lint \(spec\.after\), smoke \(build\.after\) -> lint \(spec\.after\), smoke \(build\.after\) \(e2e moved to CI\)\n/);
  const audit = read().findLast((e) => e.stage === 'rules' && e.run === 'acme/cs');
  assert.deepEqual([audit.status, audit.key, audit.reason, audit.value.map((x) => x.id)], ['set', 'steps.custom', 'e2e moved to CI', ['lint', 'smoke']]);
  assert.equal(skillChange('acme/cs', 'steps.custom', [SMOKE, LINT]).doing, null);
  setSkill('acme/cs', 'steps.custom', undefined, { reason: 'none now', ask: yes('acme/cs') });
  assert.equal(readSkills()['acme/cs']?.['steps.custom'], undefined);
  assert.equal(read().findLast((e) => e.stage === 'rules' && e.run === 'acme/cs').status, 'unset');
});

test('a project replacing default\'s step in place is compared on what runs: a narrower when there is guarded too', () => {
  reset();
  setSkill('default', 'steps.custom', [{ ...SMOKE, when: undefined }], { ask: no });
  assert.throws(() => asAgent(() => setSkill('acme/cs', 'steps.custom', [{ ...SMOKE, when: ['docs/**'] }], { reason: 'x', ask: no })), /narrowing when a custom step runs must come from you/);
  asAgent(() => setSkill('acme/cs', 'steps.custom', [{ ...SMOKE, name: 'smoke-v2' }], { ask: no })); // who runs it: never a loosening
  assert.throws(() => asAgent(() => setSkill('default', 'steps.custom', undefined, { reason: 'x', ask: no })), /removing a custom step must come from you/);
});

test('removing an added review step is human-only: an axes.on entry, or a pipeline\'s own extra axis; adding one is free', () => {
  reset();
  hot();
  asAgent(() => setSkill('acme/cs@hot', 'axes.on', ['review.ux'], { ask: no }));
  asAgent(() => setSkill('acme/cs@hot', 'axes.on', ['review.ux', 'review.seo'], { ask: no }));
  asAgent(() => setSkill('acme/cs@hot', 'axes.extra', [A11Y], { ask: no }));
  assert.throws(() => asAgent(() => setSkill('acme/cs@hot', 'axes.on', ['review.seo'], { reason: 'x', ask: no })), /^Error: removing an added review step must come from you, not from an agent session/);
  assert.throws(() => asAgent(() => setSkill('acme/cs@hot', 'axes.on', undefined, { reason: 'x', ask: no })), /removing an added review step must come from you/);
  assert.throws(() => asAgent(() => setSkill('acme/cs@hot', 'axes.extra', [], { reason: 'x', ask: no })), /removing an added review step must come from you/);
  assert.throws(() => asAgent(() => setSkill('acme/cs@hot', 'axes.extra', [{ ...A11Y, when: ['src/components/a/**'] }], { reason: 'x', ask: no })), /removing an added review step must come from you/);
  asAgent(() => setSkill('acme/cs@hot', 'axes.extra', [{ ...A11Y, name: 'a11y-v2' }], { ask: no }));
  setSkill('acme/cs@hot', 'axes.on', ['review.seo'], { reason: 'ux is on the default now', ask: yes('acme/cs@hot') });
  assert.deepEqual(readSkills()['acme/cs@hot']['axes.on'], ['review.seo']);
  asAgent(() => setSkill('acme/cs', 'axes.extra', [], { ask: no })); // a project's own extra axes: the known gap in §5, unchanged
});

test('routing compares what each pipeline adds: a routing write that would drop a pipeline\'s added review step is refused inside an agent session', () => {
  reset();
  hot();
  const free = () => asAgent(() => setRule('acme/cs', 'pipelines', '["hot"]', { reason: 'list it', ask: no }));
  free(); // hot is the default's twin: routing changes nothing a run gets
  setRule('acme/cs', 'pipelines', '["hot"]', { reason: 'x', ask: yes('acme/cs') }); // listed
  setSkill('acme/cs@hot', 'axes.on', ['review.ux'], { ask: no });
  assert.equal(loosens('acme/cs@hot', 'match', [{ labels: ['never'] }]), 'changing which pipeline a run gets');
  assert.throws(() => asAgent(() => setRule('acme/cs@hot', 'match', '[{"labels":["never"]}]', { reason: 'x', ask: no })), /changing which pipeline a run gets must come from you/);
  reset(); hot(); setRule('acme/cs', 'pipelines', '["hot"]', { reason: 'x', ask: yes('acme/cs') });
  setSkill('acme/cs@hot', 'steps.custom', [SMOKE], { ask: no });
  assert.throws(() => asAgent(() => setRule('acme/cs@hot', 'match', '[{"labels":["never"]}]', { reason: 'x', ask: no })), /changing which pipeline a run gets must come from you/, 'a custom step too');
});

// ---- in a run: F steps, F step, the refusals, the gate's loop-backs by slot, decide ----
const { getRun } = await import('../../core/src/derive.ts');
const { decide, gate } = await import('../../core/src/gate.ts');
const { facts } = await import('../../core/src/github.ts');
const json = (args, input) => JSON.parse(F(args, {}, input));
const reply = (id, verdict = 'passed', findings = []) => JSON.stringify({ id, verdict, findings });
const step = (run, id, word = 'passed', text = reply(id, word, word === 'failed' ? [{ severity: 'high', issue: 'broken' }] : [])) => json(['step', run, id, word, '-'], text);
const pass = (run, axes) => { for (const a of axes) record(run, 'review', 'passed', { axis: a, verdict: 'passed', findings: [] }); };
const start = (run, labels = []) => { record(run, 'intake', 'started', { association: 'OWNER', labels }); };
const custom = (run, status) => read().filter((e) => e.run === run && e.stage === 'custom' && (!status || e.status === status));
const factsFor = (r, files) => { process.env.STUB_PR_FILES = JSON.stringify(files.map((filename) => ({ filename }))); try { return facts(r); } finally { delete process.env.STUB_PR_FILES; } };
const decideOn = (run, files) => { const r = { ...getRun(run), reviewedSha: 'abc' }, f = factsFor(r, files); return decide(r, { ...f, autoMerge: true, association: 'OWNER', checks: 'pass', additions: 10, deletions: 2 }); };

test('spec.after: F steps records what is due; build started refuses while one has no result, or while the slot was never started; F step lets it through', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [LINT, E2E], { ask: no });
  const RUN = 'acme/cs#1';
  start(RUN);
  assert.throws(() => record(RUN, 'build', 'started'), /acme\/cs#1 has spec\.after custom steps \(lint\) that were never started: run F steps acme\/cs#1 spec\.after, run each step it returns and record it with F step acme\/cs#1 <id> passed\|failed -, then record "build started"/);
  assert.throws(() => F(['event', RUN, 'build', 'started']), /spec\.after custom steps \(lint\) that were never started/, 'F event goes through record()');
  const out = json(['steps', RUN, 'spec.after']);
  assert.deepEqual([out.slot, out.due, out.steps.map((x) => [x.id, x.use, x.name]), out.record], ['spec.after', ['lint'], [['lint', 'skill', 'spec-lint']], 'F step acme/cs#1 <id> passed|failed -']);
  assert.deepEqual(custom(RUN, 'started').map((e) => [e.slot, e.ids, e.iteration]), [['spec.after', ['lint'], 1]], 'the build it comes before');
  assert.throws(() => record(RUN, 'build', 'started'), /spec\.after custom step lint has no result: run each and record it with F step acme\/cs#1 <id> passed\|failed -, then record "build started"/);
  assert.equal(step(RUN, 'lint').status, 'passed');
  assert.deepEqual(custom(RUN, 'passed')[0].runner, { use: 'skill', name: 'spec-lint' }, 'F records the runner, as for any step');
  record(RUN, 'build', 'started');
  assert.equal(getRun(RUN).stage, 'build', 'custom events never move the stage');
  assert.throws(() => F(['steps', RUN, 'spec.after']), /spec\.after steps run after the spec is written, before build: acme\/cs#1 already started building on this spec/);
  for (const [stage, status, owner] of [['custom', 'started', 'steps'], ['custom', 'passed', 'step'], ['custom', 'failed', 'step']])
    assert.throws(() => F(['event', RUN, stage, status, '{"id":"lint","slot":"spec.after"}']), new RegExp(`"${stage} ${status}" is recorded by "${owner}", not by hand`));
});

test('F step has F review\'s contract: output outside it records a failure, never a pass; a result is final unless invalid; only a due step is recorded', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [LINT, { ...SMOKE, slot: 'spec.after' }], { ask: no });
  const RUN = 'acme/cs#2';
  start(RUN); json(['steps', RUN, 'spec.after']);
  assert.throws(() => step(RUN, 'e2e'), /custom step "e2e" is not due now/);
  const s1 = step(RUN, 'lint', 'passed', 'looks fine to me');
  assert.deepEqual([s1.status, s1.findings[0].issue.startsWith('reviewer output invalid: ')], ['failed', true], 'prose: a failure');
  assert.equal(step(RUN, 'lint', 'passed', reply('smoke')).status, 'failed', 'an answer for another step: invalid, replaceable');
  assert.equal(step(RUN, 'lint', 'passed', JSON.stringify({ id: 'lint', verdict: 'passed', ok: true })).status, 'failed', 'unknown fields');
  assert.equal(step(RUN, 'lint', 'passed', reply('lint', 'passed', [{ severity: 'high', issue: 'x', dismissed: 'no' }])).status, 'failed', 'never dismissed');
  assert.equal(step(RUN, 'lint', 'passed', reply('lint', 'passed', [{ severity: 'medium', issue: 'a blocking finding' }])).status, 'failed', 'findings outrank the verdict');
  assert.throws(() => step(RUN, 'lint'), /a failed result for custom step "lint" is already recorded; only an invalid one can be replaced/);
  assert.equal(step(RUN, 'smoke', 'failed', reply('smoke', 'passed')).status, 'failed', 'the word failed: a failure, whatever the reply says');
  assert.throws(() => json(['step', RUN, 'smoke', 'ok', '-'], reply('smoke')), /usage: step <run> <id> passed\|failed -/);
  assert.throws(() => step(RUN, 'smoke'), /a failed result for custom step "smoke" is already recorded/);
});

test('build.after: F steps picks first, matches when on the whole change; F axes refuses while a due step has no result; the gate routes a failure back to build', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [E2E, SMOKE], { ask: no });
  const RUN = 'acme/cs#3';
  start(RUN); record(RUN, 'build', 'started');
  assert.throws(() => F(['axes', RUN, 'src/a.ts', 'src/a.test.ts']), /acme\/cs#3 has build\.after custom steps \(smoke\) that were never started: run F steps acme\/cs#3 build\.after/);
  assert.equal(read().filter((e) => e.run === RUN && e.status === 'routed').length, 1, 'F axes picked before it refused: the pick is once per iteration');
  assert.deepEqual(json(['steps', RUN, 'build.after', 'src/a.ts', 'src/a.test.ts']).due, ['smoke'], 'e2e runs only when apps/web changes');
  assert.throws(() => F(['axes', RUN, 'src/a.ts', 'src/a.test.ts']), /build\.after custom step smoke has no result/);
  step(RUN, 'smoke', 'failed');
  assert.deepEqual(JSON.parse(F(['axes', RUN, 'src/a.ts', 'src/a.test.ts'])).axes, ['code', 'security'], 'a failed step doesn\'t hold review up: the gate sends it back');
  pass(RUN, ['code', 'security']);
  const g = json(['gate', RUN]);
  assert.deepEqual([g.status, g.next, g.reasons], ['failed', 'build', ['custom step smoke (build.after) failed: back to build']]);
  // iteration 2: smoke failed last time, so it is due again, whatever the files; a gated phase is frozen
  assert.throws(() => step(RUN, 'smoke'), /iteration 1 is already gated; its custom steps are frozen/);
  record(RUN, 'build', 'started');
  assert.deepEqual(json(['steps', RUN, 'build.after', 'apps/web/Button.tsx']).due, ['e2e', 'smoke'], 'e2e now, and smoke again');
  step(RUN, 'e2e'); step(RUN, 'smoke');
  pass(RUN, JSON.parse(F(['axes', RUN, 'apps/web/Button.tsx'])).axes);
  const g2 = json(['gate', RUN]);
  assert.deepEqual([g2.status, g2.next], ['passed', 'approve']);
  assert.match(g2.reasons[0], /; custom steps passed: e2e, smoke$/);
});

test('a spec.after failure goes back to spec through the gate, counted as a loop: it fails CAP times, then escalates', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [LINT], { ask: no });
  const RUN = 'acme/cs#4';
  start(RUN);
  for (let i = 1; i <= 3; i++) {
    json(['steps', RUN, 'spec.after']);
    step(RUN, 'lint', 'failed');
    record(RUN, 'build', 'started'); // a failed step has a result: the run goes on, and the gate sends it back
    F(['axes', RUN, 'src/a.ts', 'src/a.test.ts']); pass(RUN, ['code', 'security']);
    const g = json(['gate', RUN]);
    if (i < 3) assert.deepEqual([g.next, g.reasons], ['spec', ['custom step lint (spec.after) failed: back to spec']], `loop ${i}`);
    else assert.deepEqual([g.next, g.reasons.at(-1)], ['approve', 'loop cap 3 reached'], 'the cap still bounds it');
  }
  assert.equal(getRun(RUN).iteration, 3);
  const d = decideOn(RUN, ['src/a.ts', 'src/a.test.ts']);
  assert.equal(d.action, 'escalate');
  assert.ok(d.reasons.includes('custom step lint (spec.after) failed'), d.reasons.join('\n'));
});

test('a build loop-back keeps the spec and its spec.after results: nothing to run again before the next build', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [LINT], { ask: no });
  const RUN = 'acme/cs#5';
  start(RUN); json(['steps', RUN, 'spec.after']); step(RUN, 'lint');
  record(RUN, 'build', 'started'); F(['axes', RUN, 'src/a.ts']);
  for (const a of ['code', 'security']) record(RUN, 'review', 'failed', { axis: a, verdict: 'failed', findings: [{ severity: 'high', route: 'build', issue: 'x' }] });
  assert.equal(json(['gate', RUN]).next, 'build');
  record(RUN, 'build', 'started'); // no refusal: the spec.after phase is the one before
  assert.equal(getRun(RUN).iteration, 2);
});

test('a missing result never strands a run: the gate fails to approve, and decide escalates with "custom step <id> has no result"', () => {
  reset();
  const RUN = 'acme/cs#6';
  start(RUN); record(RUN, 'build', 'started'); F(['axes', RUN, 'src/a.ts', 'src/a.test.ts']); pass(RUN, ['code', 'security']);
  setSkill('acme/cs', 'steps.custom', [SMOKE], { ask: no }); // added after this iteration's F steps would have run
  const g = json(['gate', RUN]);
  assert.deepEqual([g.status, g.next, g.reasons], ['failed', 'approve', ['custom step smoke has no result']]);
  assert.deepEqual(gate(getRun(RUN), undefined, { 'build.after': ['smoke'] }).reasons, ['custom step smoke has no result'], 'before the axes check: it never throws');
  const d = decideOn(RUN, ['src/a.ts', 'src/a.test.ts']);
  assert.equal(d.action, 'escalate');
  assert.ok(d.reasons.includes('custom step smoke has no result'), d.reasons.join('\n'));
});

test('due stays due: a step F steps made due still needs its result after it is removed from config, so removing a failing step clears nothing', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [SMOKE], { ask: no });
  const RUN = 'acme/cs#7';
  start(RUN); record(RUN, 'build', 'started');
  json(['steps', RUN, 'build.after', 'src/a.ts']);
  setSkill('acme/cs', 'steps.custom', undefined, { reason: 'drop it', ask: yes('acme/cs') });
  assert.throws(() => F(['axes', RUN, 'src/a.ts']), /build\.after custom step smoke has no result/);
  step(RUN, 'smoke', 'failed');
  F(['axes', RUN, 'src/a.ts', 'src/a.test.ts']); pass(RUN, ['code', 'security']);
  assert.deepEqual(json(['gate', RUN]).reasons, ['custom step smoke (build.after) failed: back to build']);
});

test('decide reads what is due again on the reviewed change: a push after F steps that a step\'s when now matches never merges without it', () => {
  reset();
  setSkill('acme/cs', 'steps.custom', [E2E], { ask: no });
  const RUN = 'acme/cs#8';
  start(RUN); record(RUN, 'build', 'started'); record(RUN, 'build', 'opened', { pr: 'https://github.com/acme/cs/pull/8' });
  assert.deepEqual(json(['steps', RUN, 'build.after', 'src/a.ts', 'src/a.test.ts']).due, []);
  F(['axes', RUN, 'src/a.ts', 'src/a.test.ts']); pass(RUN, ['code', 'security']);
  assert.equal(json(['gate', RUN]).status, 'passed');
  assert.equal(decideOn(RUN, ['src/a.ts', 'src/a.test.ts']).action, 'merge', 'the same change merges');
  const d = decideOn(RUN, ['src/a.ts', 'src/a.test.ts', 'apps/web/x.test.ts']);
  assert.equal(d.action, 'escalate');
  assert.ok(d.reasons.includes('custom step e2e is due on the reviewed change but has no passing result'), d.reasons.join('\n'));
});

test('a pipeline the run met adds its build.after steps and its review steps, and they stay due after the run re-matches a pipeline without them', () => {
  reset();
  hot('ui', '[{"files":["src/components/**"]}]');
  setRule('acme/cs', 'pipelines', '["ui"]', { reason: 'ui first', ask: yes('acme/cs') });
  setSkill('acme/cs@ui', 'steps.custom', [SMOKE], { ask: no });
  setSkill('acme/cs@ui', 'axes.on', ['review.seo'], { ask: no });
  setSkill('acme/cs@ui', 'axes.extra', [A11Y], { ask: no });
  const RUN = 'acme/cs#9';
  start(RUN); record(RUN, 'build', 'started');
  assert.deepEqual(json(['steps', RUN, 'build.after', 'src/components/B.tsx', 'src/components/B.test.tsx']).due, ['smoke'], 'picked ui: its step');
  assert.equal(getRun(RUN).route.pipeline, 'ui');
  step(RUN, 'smoke');
  const a1 = JSON.parse(F(['axes', RUN, 'src/components/B.tsx', 'src/components/B.test.tsx'])).axes;
  assert.deepEqual(a1, ['code', 'security', 'ux', 'ui', 'a11y', 'seo'], 'its own extra axis, and seo always');
  F(['review', RUN, 'a11y'], {}, JSON.stringify({ axis: 'a11y', verdict: 'passed', findings: [] }));
  pass(RUN, a1.filter((a) => a !== 'a11y'));
  assert.equal(custom(RUN, 'passed')[0].runner?.name, 'smoke', 'a pipeline\'s step: its runner, by id');
  assert.deepEqual(read().findLast((e) => e.run === RUN && e.stage === 'review' && e.axis === 'a11y').runner, { use: 'skill', name: 'a11y-review' }, 'a pipeline\'s own axis: its runner');
  // iteration 2 touches the API too: the default now, which adds nothing; what ui added stays due
  json(['gate', RUN]); record(RUN, 'build', 'started');
  assert.deepEqual(json(['steps', RUN, 'build.after', 'src/components/B.tsx', 'src/api.ts']).due, ['smoke'], 'its step too');
  assert.equal(getRun(RUN).route.pipeline, 'default');
  step(RUN, 'smoke');
  assert.deepEqual(JSON.parse(F(['axes', RUN, 'src/components/B.tsx', 'src/api.ts'])).axes, ['code', 'security', 'ux', 'ui', 'a11y', 'seo'], 'the added review steps stay due');
});

test('over HTTP POST /api/skills writes a runner or an added step freely; a guarded one is only requested from the desktop, or refused with the command', () => {
  reset();
  const tok = 's'.repeat(32), ctx = { token: tok, port: 4545 }, H = { host: '127.0.0.1:4545', origin: 'http://127.0.0.1:4545', 'content-type': 'application/json', 'x-factory-token': tok };
  const post = (body) => JSON.parse(uiHandle({ method: 'POST', url: '/api/skills', headers: H, body: JSON.stringify(body) }, ctx).body);
  assert.equal(post({ scope: 'acme/cs', step: 'steps.custom', runner: [LINT, E2E] }).error, undefined, 'adding is free');
  assert.deepEqual(readSkills()['acme/cs']['steps.custom'].map((x) => x.id), ['lint', 'e2e']);
  assert.equal(post({ scope: 'acme/cs', step: 'review.code', runner: { use: 'skill', name: 'my-review' } }).error, undefined, 'who runs a step: the same route, unguarded');
  assert.match(post({ scope: 'acme/cs', step: 'steps.custom', runner: [LINT], reason: 'slow' }).error, /^removing a custom step needs your confirmation outside the page: .*F skills set acme\/cs steps\.custom '\[\{"id":"lint"/);
  assert.match(post({ scope: 'acme/cs', step: 'steps.custom', runner: null, reason: 'slow' }).error, /F skills unset acme\/cs steps\.custom --reason/);
  const asked = []; guarded.request = (x) => { asked.push(x); return true; };
  try {
    assert.equal(post({ scope: 'acme/cs', step: 'steps.custom', runner: [LINT], reason: 'slow' }).requested, 'removing a custom step');
    assert.match(post({ scope: 'acme/cs', step: 'steps.custom', runner: [{ ...SMOKE, id: 'Bad' }], reason: 'x' }).error, /custom step id "Bad"/, 'checked before any dialog');
    guarded.request = () => false;
    assert.match(post({ scope: 'acme/cs', step: 'steps.custom', runner: [LINT], reason: 'slow' }).error, /a confirmation is already open/);
  } finally { delete guarded.request; }
  assert.deepEqual(asked, [{ scope: 'acme/cs', key: 'steps.custom', raw: JSON.stringify([LINT]), unset: false, reason: 'slow', skill: true }]);
  assert.deepEqual(readSkills()['acme/cs']['steps.custom'].map((x) => x.id), ['lint', 'e2e'], 'nothing removed over HTTP');
});
