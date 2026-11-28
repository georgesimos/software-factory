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
  assert.deepEqual(skills('acme/cs').pipeline.warnings.filter((x) => /steps\.custom/.test(x)).length, 1, 'the page shows the project\'s');
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
