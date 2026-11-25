// Pipelines slice 4 (docs/plans/pipelines.md §7): named pipelines as owner/repo@id scopes, match conditions, the routing guard,
// labels from intake, the pick and its routed record, the meet (a run only tightens), and decide naming the pipeline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HERE } from '../factory.mjs';
import { derive } from '../../core/src/derive.ts';
import { decide, gate } from '../../core/src/gate.ts';
import { io, read, record } from '../../core/src/log.ts';
import { loosens, ruleChange, rules, setRule, unsetRule } from '../../core/src/rules.ts';
import { idClash, pick, pipelinesOf, routeOf, runLabels, uniqueIds } from '../../core/src/route.ts';
import { readSkills, setSkill, skills, skillsFile } from '../../core/src/skills.ts';
import { getRun } from '../../core/src/derive.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';
import { getItem as ghItem } from '../../adapters/trackers/github-issues.ts';
import { getItem as localItem } from '../../adapters/trackers/local.ts';
import { guarded, uiHandle } from '../../server/src/server.ts';
import { setup } from './setup.mjs';

setup();
const STUB = path.join(HERE, 'test', 'gh-stub.mjs');
io.gh = STUB;
fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/mt': { path: '/x' }, 'acme/gm': { path: '/x', host: 'git' } }));
const asAgent = (fn) => { process.env.CLAUDECODE = '1'; try { return fn(); } finally { delete process.env.CLAUDECODE; } };
const yes = (scope) => () => scope; // the scope's name, typed at the terminal
const F = (args, env = {}) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: STUB, ...env } });
const HOTFIX = '[{"labels":["hotfix"]}]';
const reset = () => { const cfg = readSkills(); for (const s of Object.keys(cfg)) if (s.startsWith('acme/mt')) delete cfg[s]; fs.writeFileSync(skillsFile(), JSON.stringify(cfg)); };

test('a pipeline is an owner/repo@id scope: name and the rules match, steps.off, run.loops, run.budgetUsd; anything else is refused', () => {
  reset();
  setSkill('acme/mt@hotfix', 'name', 'Hotfix');
  setRule('acme/mt@hotfix', 'match', HOTFIX, { reason: 'urgent fixes', ask: yes('acme/mt@hotfix') });
  setRule('acme/mt@hotfix', 'run.loops', '1', { reason: 'one try' });
  assert.equal(readSkills()['acme/mt@hotfix'].name, 'Hotfix');
  assert.deepEqual(rules('acme/mt@hotfix').policy.match.value, [{ labels: ['hotfix'] }]);
  for (const [fn, re] of [
    [() => setSkill('acme/mt@hotfix', 'review.ui', { use: 'default' }), /a pipeline holds name and rules/],
    [() => setSkill('acme/mt@hotfix', 'axes.extra', [{ axis: 'a11y', when: ['*.tsx'], use: 'skill', name: 'a11y' }]), /a pipeline holds name and rules/],
    [() => setSkill('acme/mt@hotfix', 'steps.custom', [{ id: 'lint', slot: 'spec.after', use: 'skill', name: 'lint' }]), /spec\.after custom steps are the project's only/],
    [() => setRule('acme/mt@hotfix', 'guide.build', 'x', { reason: 'x' }), /a pipeline holds name and rules/],
    [() => setRule('acme/mt@hotfix', 'ci', 'skip', { reason: 'x' }), /ci is the project's rule: a pipeline holds match, steps\.off, run\.loops and run\.budgetUsd/],
    [() => setRule('acme/mt', 'match', HOTFIX, { reason: 'x' }), /match is a pipeline's rule: set it on acme\/mt@<id>/],
    [() => setRule('acme/mt@hotfix', 'pipelines', '["hotfix"]', { reason: 'x' }), /pipelines is the project's rule: set it on acme\/mt/],
    [() => setRule('default', 'pipelines', '["hotfix"]', { reason: 'x' }), /pipelines is a per-project rule/],
    [() => setSkill('acme/mt', 'name', 'Mine'), /only a pipeline \(owner\/repo@id\) has a name/],
    [() => setSkill('acme/mt@default', 'name', 'x'), /scope "acme\/mt@default"/],
    [() => setSkill('acme/mt@Hot', 'name', 'x'), /scope "acme\/mt@Hot"/],
  ]) assert.throws(fn, re);
  assert.equal(rules('acme/mt@hotfix').policy['steps.off'], undefined);
});

test('match: 1-5 non-empty condition sets of labels, files and maxDiffLines; never a factory:* label; maxDiffLines refused on a git project', () => {
  reset();
  const bad = (v, re, scope = 'acme/mt@x') => assert.throws(() => setRule(scope, 'match', v, { reason: 'x', ask: yes(scope) }), re, v);
  bad('[]', /1-5 condition sets/);
  bad(JSON.stringify(Array(6).fill({ labels: ['a'] })), /1-5 condition sets/);
  bad('[{}]', /an empty one would match everything/);
  bad('[{"labels":["factory:ready"]}]', /factory:\* labels are F's own/);
  bad('[{"labels":[]}]', /labels must be 1-10/);
  bad('[{"files":[]}]', /files must be 1-20 globs/);
  bad('[{"maxDiffLines":0}]', /maxDiffLines must be an integer 1-/);
  bad('[{"branch":"x"}]', /unknown terms branch/);
  bad('[{"maxDiffLines":40}]', /maxDiffLines is refused on a git project/, 'acme/gm@small');
  setRule('acme/gm@small', 'match', '[{"files":["docs/**"]}]', { reason: 'docs', ask: yes('acme/gm@small') });
  setRule('acme/mt@docs', 'match', '[{"files":["docs/**","*.md"],"maxDiffLines":40},{"labels":["docs"]}]', { reason: 'docs', ask: yes('acme/mt@docs') });
});

test('pipelines: listed ids in match order; each must exist with a match; the default is never listed', () => {
  reset();
  assert.throws(() => setRule('acme/mt', 'pipelines', '["ghost"]', { reason: 'x', ask: yes('acme/mt') }), /acme\/mt@ghost has no match: set one first/);
  assert.throws(() => setRule('acme/mt', 'pipelines', '["default"]', { reason: 'x', ask: yes('acme/mt') }), /pipelines/);
  assert.throws(() => setRule('acme/mt', 'pipelines', '["a","a"]', { reason: 'x', ask: yes('acme/mt') }), /pipelines/);
  setRule('acme/mt@hotfix', 'match', HOTFIX, { reason: 'urgent', ask: yes('acme/mt@hotfix') });
  setRule('acme/mt@docs', 'match', '[{"files":["docs/**"]}]', { reason: 'docs', ask: yes('acme/mt@docs') });
  setRule('acme/mt', 'pipelines', '["hotfix","docs"]', { reason: 'order', ask: yes('acme/mt') });
  setRule('acme/mt@spike', 'match', '[{"labels":["spike"]}]', { reason: 'later', ask: yes('acme/mt@spike') }); // a draft: nobody listed it
  assert.deepEqual(pipelinesOf('acme/mt').map((p) => [p.id, p.listed]), [['hotfix', true], ['docs', true], ['spike', false]]);
  const k = skills('acme/mt');
  assert.deepEqual(k.pipelines.map((p) => [p.id, p.name, p.listed, p.match]), [['hotfix', 'hotfix', true, [{ labels: ['hotfix'] }]], ['docs', 'docs', true, [{ files: ['docs/**'] }]], ['spike', 'spike', false, [{ labels: ['spike'] }]]]);
  assert.ok(k.pipeline.warnings.some((w) => /acme\/mt@spike is not listed in acme\/mt's pipelines, so it never matches/.test(w)), k.pipeline.warnings.join('\n'));
});

test('on read, a hand edit F would refuse is dropped with a warning; an @id scope never inherits the project\'s steps.off', () => {
  reset();
  setRule('acme/mt', 'steps.off', '["review.seo"]', { reason: 'no pages', ask: yes('acme/mt') });
  const cfg = JSON.parse(fs.readFileSync(skillsFile(), 'utf8'));
  cfg['acme/mt@hand'] = { name: 'Hand', 'review.ui': { use: 'default' }, guide: { build: 'x' }, rules: { ci: { value: 'skip', reason: 'x', setBy: 'acme', setAt: '2026-11-25T10:00:00Z' }, match: { value: [{}], reason: 'x', setBy: 'acme', setAt: '2026-11-25T10:00:00Z' } } };
  cfg['acme/mt'].rules.match = { value: [{ labels: ['x'] }], reason: 'x', setBy: 'acme', setAt: '2026-11-25T10:00:00Z' };
  cfg['acme/mt'].name = 'nope';
  cfg.default = { ...cfg.default, rules: { ...cfg.default?.rules, pipelines: { value: ['hand'], reason: 'x', setBy: 'acme', setAt: '2026-11-25T10:00:00Z' } } };
  fs.writeFileSync(skillsFile(), JSON.stringify(cfg));
  const s = readSkills(), w = rules('acme/mt@hand').warnings.join('\n') + '\n' + rules('acme/mt').warnings.join('\n');
  assert.deepEqual(Object.keys(s['acme/mt@hand']).sort(), ['name', 'rules']);
  assert.deepEqual(Object.keys(s['acme/mt@hand'].rules), []);
  assert.equal(s['acme/mt'].rules.match, undefined); assert.equal(s['acme/mt'].name, undefined); assert.equal(s.default?.rules?.pipelines, undefined);
  for (const re of [/acme\/mt@hand\.review\.ui is ignored: a pipeline holds name and rules/, /acme\/mt@hand\.rules\.ci is ignored/, /acme\/mt@hand\.rules\.match is ignored: set 1/, /acme\/mt\.rules\.match is ignored/, /acme\/mt\.name is ignored/])
    assert.match(w, re);
  assert.equal(rules('acme/mt@hand').policy['steps.off'], undefined, 'the project\'s list is the default pipeline\'s only');
  reset();
});

test('routing is guarded while two pipelines differ in what a run gets; free while they are all the same', () => {
  reset();
  asAgent(() => setRule('acme/mt@docs', 'match', '[{"files":["docs/**"]}]', { reason: 'docs' })); // identical to the default: free
  asAgent(() => setRule('acme/mt', 'pipelines', '["docs"]', { reason: 'docs first' }));
  assert.equal(loosens('acme/mt', 'pipelines', undefined), null);
  setRule('acme/mt@docs', 'steps.off', '["review.ux","review.ui"]', { reason: 'docs only', ask: yes('acme/mt@docs') }); // now they differ
  for (const [scope, key, v] of [['acme/mt', 'pipelines', undefined], ['acme/mt@docs', 'match', '[{"files":["docs/**","*.md"]}]'], ['acme/mt@draft', 'match', '[{"labels":["x"]}]']]) {
    assert.equal(loosens(scope, key, v === undefined ? undefined : JSON.parse(v)), 'changing which pipeline a run gets', `${scope} ${key}`);
    assert.throws(() => asAgent(() => (v === undefined ? unsetRule(scope, key, { reason: 'x' }) : setRule(scope, key, v, { reason: 'x' }))), /changing which pipeline a run gets must come from you/);
  }
  setRule('acme/mt@hot', 'match', HOTFIX, { reason: 'urgent', ask: yes('acme/mt@hot') });
  let shown = '';
  assert.throws(() => setRule('acme/mt', 'pipelines', '["hot","docs"]', { reason: 'hotfix first', ask: (p) => { shown = p; return 'nope'; } }), /stays as it is/);
  assert.match(shown, /^acme\/mt: changing which pipeline a run gets\npipelines: docs -> hot, docs \(hotfix first\)\n/);
  assert.match(shown, /\n  1\. hot: label hotfix; nothing off; loops 3, \$5\n  2\. docs: files docs\/\*\*; off review\.ui, review\.ux; loops 3, \$5\n  then the default: every other issue; nothing off; loops 3, \$5\n/);
  setRule('acme/mt', 'pipelines', '["hot","docs"]', { reason: 'hotfix first', ask: yes('acme/mt') });
  assert.deepEqual(rules('acme/mt').policy.pipelines.value, ['hot', 'docs']);
  // over HTTP: only requested; plain F ui refuses with the command
  const tok = 's'.repeat(32), ctx = { token: tok, port: 4545 }, H = { host: '127.0.0.1:4545', origin: 'http://127.0.0.1:4545', 'content-type': 'application/json', 'x-factory-token': tok };
  const post = (body) => uiHandle({ method: 'POST', url: '/api/onboard/rule', headers: H, body: JSON.stringify(body) }, ctx);
  let r = post({ scope: 'acme/mt@hot', key: 'match', value: [{ labels: ['urgent'] }], reason: 'renamed' });
  assert.match(JSON.parse(r.body).error, /changing which pipeline a run gets needs your confirmation outside the page: .*F rules set acme\/mt@hot match '\[\{"labels":\["urgent"\]\}\]'/);
  const asked = []; guarded.request = (x) => { asked.push(x); return true; };
  try { r = post({ scope: 'acme/mt@hot', key: 'match', value: [{ labels: ['urgent'] }], reason: 'renamed' }); assert.equal(JSON.parse(r.body).requested, 'changing which pipeline a run gets'); }
  finally { delete guarded.request; }
  assert.equal(asked.length, 1);
  assert.deepEqual(ruleChange('acme/mt', 'pipelines', '["docs"]', { reason: 'x' }).routes.map((p) => p.id), ['docs', 'default']);
});

test('labels: the tracker gives them, intake records them, F event can\'t; read once, again only after needs-info', () => {
  const ctx = { gh: (...a) => JSON.stringify({ title: 't', html_url: 'u', user: { login: 'acme' }, author_association: 'OWNER', state: 'open', labels: [{ name: 'hotfix' }, { name: 'factory:ready' }], body: 'b', ...(a ? {} : {}) }) };
  assert.deepEqual(ghItem(ctx, { repo: 'acme/mt', id: '5' }).labels, ['hotfix', 'factory:ready']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-items-')), issues = path.join(dir, '.factory', 'issues');
  fs.mkdirSync(issues, { recursive: true });
  fs.writeFileSync(path.join(issues, '3.md'), '---\ntitle: "x"\nstate: open\nlabels: ["spike"]\n---\n\nbody\n');
  assert.deepEqual(localItem({ git: () => '' }, { repo: 'local/x', path: dir, id: '3' }).labels, ['spike']);
  assert.throws(() => F(['event', 'acme/mt#1', 'build', 'started', '{"labels":["hotfix"]}']), /labels/);
  const ev = (stage, status, x = {}) => ({ ts: 't', run: 'acme/mt#1', stage, status, ...x });
  assert.deepEqual(runLabels([ev('intake', 'started', { labels: ['a'] }), ev('build', 'started'), ev('intake', 'started', { labels: ['b'] })]), ['a'], 'a re-intake mid-run keeps the first');
  assert.deepEqual(runLabels([ev('intake', 'started', { labels: ['a'] }), ev('intake', 'needs-info'), ev('intake', 'started', { labels: ['b'] })]), ['b'], 'a resume after needs-info reads them again');
});

// The pick, from F axes: once per iteration, recorded as review routed, which only F axes writes.
const setupThree = () => {
  reset();
  setRule('acme/mt@hotfix', 'match', HOTFIX, { reason: 'urgent', ask: yes('acme/mt@hotfix') });
  setRule('acme/mt@hotfix', 'steps.off', '["review.ux","review.ui","review.seo","review.docs"]', { reason: 'ship it', ask: yes('acme/mt@hotfix') });
  setRule('acme/mt@hotfix', 'run.loops', '1', { reason: 'one try' });
  setRule('acme/mt@ui', 'match', '[{"files":["web/**"]}]', { reason: 'ui work', ask: yes('acme/mt@ui') });
  setRule('acme/mt@ui', 'steps.off', '["review.seo"]', { reason: 'no pages', ask: yes('acme/mt@ui') });
  setRule('acme/mt', 'pipelines', '["hotfix","ui"]', { reason: 'order', ask: yes('acme/mt') });
};
const axes = (run, ...files) => JSON.parse(F(['axes', run, ...files])).axes;

test('F axes picks once per iteration and records review routed; F event refuses routed on every stage; a forged one is inert', () => {
  setupThree();
  const RUN = 'acme/mt#10';
  record(RUN, 'intake', 'started', { association: 'OWNER', labels: ['hotfix'] }); record(RUN, 'build', 'started');
  record(RUN, 'build', 'opened', { pr: 'https://github.com/acme/mt/pull/10' });
  assert.deepEqual(axes(RUN, 'web/Button.tsx', 'web/Button.test.tsx'), ['code', 'security']);
  axes(RUN, 'web/Button.tsx'); // again, same iteration: no second pick
  const routed = read().filter((e) => e.run === RUN && e.stage === 'review' && e.status === 'routed');
  assert.equal(routed.length, 1);
  assert.deepEqual([routed[0].pipeline, routed[0].set, routed[0].iteration, routed[0].facts], ['hotfix', 0, 1, { labels: ['hotfix'], files: ['web/Button.tsx', 'web/Button.test.tsx'], diffLines: 12 }]);
  const r = getRun(RUN);
  assert.deepEqual([r.stage, r.status, r.route.pipeline, r.route.caps.loops], ['review', 'started', 'hotfix', 1], 'routed moves neither stage nor status');
  for (const stage of ['review', 'build', 'approve']) assert.throws(() => F(['event', RUN, stage, 'routed', '{"pipeline":"ui"}']), /"routed" is recorded by "axes", not by hand/, stage);
  const forged = { ts: 't', run: RUN, stage: 'build', status: 'routed', pipeline: 'default', off: [], caps: { loops: 3, budgetUsd: 5 } };
  assert.equal(routeOf([...r.events, forged]).pipeline, 'hotfix', 'only review routed counts');
  // gate uses the meet's caps: hotfix allows one loop
  for (const a of ['code', 'security']) record(RUN, 'review', 'failed', { axis: a, verdict: 'failed', findings: [{ severity: 'high', route: 'build', issue: 'x' }] });
  assert.match(JSON.parse(F(['gate', RUN])).reasons.at(-1), /^loop cap 1 reached \(rule run\.loops\)/);
});

test('a loop-back whose match changes only tightens: a step back on stays on, and the lowest cap stays', () => {
  setupThree();
  const RUN = 'acme/mt#11';
  record(RUN, 'intake', 'started', { association: 'OWNER', labels: [] }); record(RUN, 'build', 'started');
  assert.deepEqual(axes(RUN, 'web/page.html'), ['code', 'security', 'ux', 'ui'], 'ui: seo off'); // web/page.html is an SEO file too
  record(RUN, 'build', 'started');
  assert.deepEqual(axes(RUN, 'web/page.html', 'src/pay.ts'), ['code', 'security', 'ux', 'ui', 'seo'], 'the default: nothing off');
  for (const a of ['code', 'security', 'ux', 'ui', 'seo']) record(RUN, 'review', 'passed', { axis: a, verdict: 'passed', findings: [] }); // nothing carried over as failed
  record(RUN, 'build', 'started');
  assert.deepEqual(axes(RUN, 'web/page.html'), ['code', 'security', 'ux', 'ui', 'seo'], 'ui again: seo stays on');
  const r = getRun(RUN);
  assert.deepEqual([r.route.picks.map((p) => p.pipeline), r.route.off], [['ui', 'default', 'ui'], []]);
  // and a cap: hotfix's 1 loop, met once, stays even after the labels move to the default (here, by a needs-info resume)
  const RUN2 = 'acme/mt#12';
  record(RUN2, 'intake', 'started', { association: 'OWNER', labels: ['hotfix'] }); record(RUN2, 'build', 'started'); axes(RUN2, 'src/a.ts');
  record(RUN2, 'intake', 'needs-info'); record(RUN2, 'intake', 'started', { association: 'OWNER', labels: [] }); record(RUN2, 'build', 'started'); axes(RUN2, 'src/a.ts');
  const r2 = getRun(RUN2);
  assert.deepEqual([r2.route.pipeline, r2.route.caps.loops], ['default', 1]);
});

test('decide names the pipeline and the set, with each turned-off axis; a local user\'s routing rule escalates on GitHub', () => {
  setupThree();
  const RUN = 'acme/mt#13';
  record(RUN, 'intake', 'started', { association: 'OWNER', labels: ['hotfix'] }); record(RUN, 'build', 'started');
  record(RUN, 'build', 'opened', { pr: 'https://github.com/acme/mt/pull/13' });
  axes(RUN, 'web/Button.tsx', 'web/Button.test.tsx');
  for (const a of ['code', 'security']) record(RUN, 'review', 'passed', { axis: a, verdict: 'passed', findings: [] });
  const r = { ...derive(read())[RUN], reviewedSha: 'abc' };
  const facts = { autoMerge: true, association: 'OWNER', checks: 'pass', files: ['web/Button.tsx', 'web/Button.test.tsx'], additions: 5, deletions: 0, rules: rules('acme/mt').policy };
  const d = decide(r, facts);
  assert.equal(d.action, 'merge', d.reasons.join('; '));
  assert.ok(d.reasons.includes('pipeline hotfix (set 1: label hotfix): review.ux, review.ui off by rule steps.off on acme/mt@hotfix, set by stub-user: ship it'), d.reasons.join('\n'));
  const local = { ...r, route: { ...r.route, local: true } };
  assert.ok(decide(local, facts).reasons.includes('rule match or pipelines was set by a local user (unverified): routing needs a verified login (gh auth login) before the factory merges on its own'));
  assert.equal(decide(local, { ...facts, host: 'git' }).reasons.some((x) => /routing needs a verified login/.test(x)), false);
  const p = pick('acme/mt', { labels: [], files: ['docs/a.md'], diffLines: 3 });
  assert.deepEqual([p.pipeline, p.set], ['default', null]);
});

test('maxDiffLines holds only on a size F can trust: never with no count, and never on a git project', () => {
  reset();
  setRule('acme/mt@small', 'match', '[{"maxDiffLines":20}]', { reason: 'small', ask: yes('acme/mt@small') });
  setRule('acme/mt', 'pipelines', '["small"]', { reason: 'x', ask: yes('acme/mt') });
  assert.equal(pick('acme/mt', { labels: [], files: ['a.ts'], diffLines: 12 }).pipeline, 'small');
  assert.equal(pick('acme/mt', { labels: [], files: ['a.ts'], diffLines: 21 }).pipeline, 'default');
  assert.equal(pick('acme/mt', { labels: [], files: ['a.ts'], diffLines: null }).pipeline, 'default');
  const cfg = readSkills(); cfg['acme/gm@small'] = { rules: { match: { value: [{ maxDiffLines: 20 }], reason: 'x', setBy: 'acme', setAt: '2026-11-25T10:00:00Z' } } };
  cfg['acme/gm'] = { rules: { pipelines: { value: ['small'], reason: 'x', setBy: 'acme', setAt: '2026-11-25T10:00:00Z' } } };
  fs.writeFileSync(skillsFile(), JSON.stringify(cfg));
  assert.equal(pick('acme/gm', { labels: [], files: ['a.ts'], diffLines: 1 }).pipeline, 'default', 'a hand edit on a git project never matches on size');
  assert.equal(pick('acme/mt', { labels: [], files: [], diffLines: 1 }).pipeline, 'small');
  setRule('acme/mt@small', 'match', '[{"files":["docs/**"]}]', { reason: 'docs', ask: yes('acme/mt@small') });
  assert.equal(pick('acme/mt', { labels: [], files: [], diffLines: 1 }).pipeline, 'default', 'no files: files never holds');
});

test('the guard compares caps too, and the list being written: listing a draft that differs only in its loop cap is guarded', () => {
  reset();
  asAgent(() => setRule('acme/mt@x', 'match', '[{"labels":["x"]}]', { reason: 'x' })); // identical to the default: free
  asAgent(() => setRule('acme/mt@x', 'run.loops', '1', { reason: 'one try' })); // lowering a cap: free, and now x differs
  assert.equal(loosens('acme/mt', 'pipelines', ['x']), 'changing which pipeline a run gets', 'nothing is listed yet: only the new list names x');
  assert.throws(() => asAgent(() => setRule('acme/mt', 'pipelines', '["x"]', { reason: 'x' })), /changing which pipeline a run gets must come from you/);
});

test('an unlisted draft never matches, even when its match holds; a match a local user set marks the pick local', () => {
  setupThree();
  setRule('acme/mt@src', 'match', '[{"files":["src/**"]}]', { reason: 'a draft', ask: yes('acme/mt@src') });
  assert.equal(pick('acme/mt', { labels: [], files: ['src/a.ts'], diffLines: 1 }).pipeline, 'default');
  const cfg = readSkills(); cfg['acme/mt@ui'].rules.match = { ...cfg['acme/mt@ui'].rules.match, via: 'local', setBy: 'someone' };
  fs.writeFileSync(skillsFile(), JSON.stringify(cfg));
  assert.deepEqual([pick('acme/mt', { labels: [], files: ['src/a.ts'], diffLines: 1 }).local, pick('acme/mt', { labels: [], files: ['web/a.html'], diffLines: 1 }).local], [true, true], 'read on the way, even when the default is picked');
  assert.equal(pick('acme/mt', { labels: ['hotfix'], files: ['src/a.ts'], diffLines: 1 }).local, false, 'hotfix matched before ui was read');
});

test('routed moves neither the stage, the status nor the clock; decide takes the meet\'s caps from the run alone', () => {
  const ev = (stage, status, x = {}, ts = '2026-11-25T10:00:00Z') => ({ ts, run: 'acme/mt#20', stage, status, ...x });
  const caps = { loops: 1, budgetUsd: 5 };
  const r = derive([ev('intake', 'started', { labels: [] }), ev('build', 'started'), ev('build', 'started'), ev('review', 'routed', { pipeline: 'hot', set: 0, text: 'label hot', iteration: 2, off: [], caps }, '2026-11-25T11:00:00Z')])['acme/mt#20'];
  assert.deepEqual([r.stage, r.status, r.updated, r.pipeline, r.route.caps.loops], ['build', 'started', '2026-11-25T10:00:00Z', 'hot', 1]);
  const d = decide({ ...r, pr: 'https://github.com/acme/mt/pull/20', reviewedSha: 'abc' }, { autoMerge: true, association: 'OWNER', checks: 'pass', files: ['a.ts', 'a.test.ts'], additions: 1, deletions: 0, rules: {} });
  assert.ok(d.reasons.includes('iteration 2 exceeds cap 1 (rule run.loops)'), d.reasons.join('\n'));
});

test('ids are unique across a project and its pipelines: refused on write, dropped on read keeping the project\'s, then the first pipeline\'s', () => {
  // synthetic owners: the store can't hold a pipeline's custom steps or extra axes until slice 5, which adds the end-to-end test
  const owners = [{ owner: 'acme/mt', ids: ['lint', 'a11y'] }, { owner: 'acme/mt@hot', ids: ['smoke', 'lint'] }, { owner: 'acme/mt@ui', ids: ['smoke', 'visual'] }];
  assert.equal(idClash(owners, 'acme/mt@hot', 'a11y'), '"a11y" is already acme/mt\'s: ids are unique across a project and its pipelines', 'across project and pipeline');
  assert.equal(idClash(owners, 'acme/mt@ui', 'smoke'), '"smoke" is already acme/mt@hot\'s: ids are unique across a project and its pipelines', 'between two pipelines');
  assert.equal(idClash(owners, 'acme/mt@ui', 'visual'), null, 'its own id: a rewrite of its own list');
  assert.equal(idClash(owners, 'acme/mt', 'perf'), null);
  const { kept, warnings } = uniqueIds(owners);
  assert.deepEqual(kept, [{ owner: 'acme/mt', ids: ['lint', 'a11y'] }, { owner: 'acme/mt@hot', ids: ['smoke'] }, { owner: 'acme/mt@ui', ids: ['visual'] }]);
  assert.deepEqual(warnings, ['acme/mt@hot: "lint" is ignored: acme/mt already has it (ids are unique across a project and its pipelines)',
    'acme/mt@ui: "smoke" is ignored: acme/mt@hot already has it (ids are unique across a project and its pipelines)']);
});
