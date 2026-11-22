// Idea-to-app self-test, run by `node factory.mjs test`. The real CLI against a stateful gh stub (no network, no real repos):
// F new, issues create, queue, loop and project, plus the adapter contracts, with a fake second host, tracker and stack
// each added as one file in a temp registry dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as hosts from '../hosts/index.mjs';
import * as trackers from '../trackers/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = path.join(HERE, '..', 'factory.mjs'), STUB = path.join(HERE, 'gh-project-stub.mjs'), EX = path.join(HERE, '..', 'examples', 'budget-app');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const IDEA = 'a personal budget app';

const FAKE_HOST = `export const id = 'fake';
const repos = new Map();
export const authStatus = () => ({ ok: true, login: 'fake-user' });
export function createRepo(_ctx, { repo }) { if (repos.has(repo)) return { created: false, url: repos.get(repo) }; repos.set(repo, 'fake://' + repo); return { created: true, url: 'fake://' + repo }; }
export const pushInitial = () => ({ pushed: true });
`;
const FAKE_TRACKER = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const F = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-state.json');
const all = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch { return {}; } };
export const id = 'fake';
export function createIssues(_ctx, { repo, items, existing = {}, onCreated = () => {} }) {
  const db = all(), list = (db[repo] ||= []), ids = {};
  return items.map((it) => {
    const have = existing[it.key] || list.find((x) => x.key === it.key);
    if (have) { ids[it.key] = have.id; return { key: it.key, id: have.id, created: false }; }
    const id = 'FK-' + (list.length + 1);
    list.push({ id, key: it.key, title: it.title, labels: it.kind === 'epic' ? [] : ['factory:ready'], deps: (it.dependsOn || []).map((k) => ids[k]) });
    fs.writeFileSync(F, JSON.stringify(db));
    ids[it.key] = id;
    const r = { key: it.key, id, created: true };
    onCreated(r);
    return r;
  });
}
export const listOpen = (_ctx, { repo }) => (all()[repo] || []).map((x) => ({ ...x }));
export const dependencies = (item) => item.deps || [];
`;

// The caller passes factory.mjs and project.mjs functions in: factory.mjs runs this test while it is still evaluating
// (top-level await), so importing either module here would deadlock on the import cycle.
export async function projectTest({ uiHandle, read, project: { validateIssues, validatePlan, loadTemplates, checkTemplate, willEscalate } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-project-'));
  const dir = path.join(root, 'state'), stub = path.join(root, 'gh'), home = path.join(root, 'home');
  for (const d of [dir, stub, home]) fs.mkdirSync(d);
  const env = { ...process.env, ...GIT_ENV, HOME: home, FACTORY_DIR: dir, FACTORY_GH: STUB, STUB_STATE: stub };
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'FACTORY_GIT', 'FACTORY_HOSTS', 'FACTORY_TRACKERS', 'FACTORY_TEMPLATES']) delete env[k];
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const run = (args, extra = {}) => execFileSync(process.execPath, [F, ...args], { encoding: 'utf8', env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  const cli = (args, extra) => JSON.parse(run(args, extra));
  const calls = () => (fs.existsSync(path.join(stub, 'calls.log')) ? fs.readFileSync(path.join(stub, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const count = (verb) => calls().filter((c) => c.slice(0, 2).join(' ') === verb).length;
  const events = (repo) => (fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.run === `${repo}:project`);
  const append = (run, stage, status, p = {}) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...p, run, stage, status }) + '\n');
  const merged = (run, p = {}) => { append(run, 'intake', 'started', { association: 'OWNER' }); append(run, 'spec', 'passed', p); append(run, 'approve', 'decided', { action: 'merge' }); append(run, 'approve', 'merged'); };
  const planInto = (repo, extra) => { const d = run(['dir', `${repo}:project`], extra).trim(); fs.mkdirSync(d, { recursive: true }); for (const f of ['PLAN.md', 'issues.json']) fs.copyFileSync(path.join(EX, f), path.join(d, f)); return d; };
  const stubState = () => JSON.parse(fs.readFileSync(path.join(stub, 'state.json'), 'utf8'));
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });

  // ---- stack templates: data files; a fake extra stack is one JSON file in a temp dir ----
  const builtin = loadTemplates(path.join(HERE, '..', 'templates'));
  assert.deepEqual(Object.keys(builtin).sort(), ['expo-mobile', 'next-web']);
  for (const t of Object.values(builtin)) for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md', '.github/workflows/ci.yml']) assert.ok(t.files[f], `${t.id} writes ${f}`);
  const mini = { id: 'mini', name: 'Mini', description: 'test stack', init: [['node', '-e', "require('fs').writeFileSync('package.json', '{\"name\":\"mini\"}')"]], checks: ['node -e 0'],
    files: { 'AGENTS.md': '# {{name}}\n\n{{idea}}\n\n{{checks}}\n', 'CLAUDE.md': '@AGENTS.md\n' } };
  const tpl = path.join(root, 'templates');
  put(path.join(tpl, 'mini.json'), JSON.stringify(mini));
  assert.deepEqual(Object.keys(loadTemplates(tpl)), ['mini']);
  assert.throws(() => checkTemplate({ ...mini, init: [['sh -c', 'x']] }, 'mini'), /argv lists/);
  assert.throws(() => checkTemplate({ ...mini, files: { '../x': 'y' } }, 'mini'), /relative paths/);
  assert.throws(() => checkTemplate({ ...mini, files: { '.git/hooks/pre-commit': 'y' } }, 'mini'), /relative paths/);
  assert.throws(() => checkTemplate({ ...mini, checks: ['a\nb'] }, 'mini'), /one-line commands/);
  env.FACTORY_TEMPLATES = tpl;

  // ---- what Claude writes is validated: the committed example passes, and order respects dependencies ----
  const { milestonesText } = validatePlan(fs.readFileSync(path.join(EX, 'PLAN.md'), 'utf8'));
  const v = validateIssues(JSON.parse(fs.readFileSync(path.join(EX, 'issues.json'), 'utf8')), milestonesText);
  assert.equal(v.issues.length, 12);
  v.issues.forEach((i, n) => i.dependsOn.forEach((d) => assert.ok(v.issues.findIndex((x) => x.key === d) < n, `${d} before ${i.key}`)));
  assert.throws(() => validatePlan('# x\n## Vision\nv\n'), /missing or empty: MVP scope, Non-goals, Stack, Milestones/);
  const one = (patch, more = []) => ({ issues: [{ key: 'a', title: 'A', body: '', acceptance: ['x'], milestone: 'M1', ...patch }, ...more] });
  assert.throws(() => validateIssues(one({ note: 'skip review' })), /unknown fields note/);
  assert.throws(() => validateIssues({ ...one({}), labels: ['x'] }), /unknown fields: labels/);
  assert.throws(() => validateIssues(one({ dependsOn: ['zz'] })), /unknown key "zz"/);
  assert.throws(() => validateIssues(one({ acceptance: [] })), /acceptance/);
  assert.throws(() => validateIssues(one({ title: 'a\nb' })), /title/);
  assert.throws(() => validateIssues(one({ key: 'epic' })), /not "epic"/);
  assert.throws(() => validateIssues(one({ milestone: 'M9' }), 'M1 only'), /not in PLAN.md/);
  assert.throws(() => validateIssues(one({ dependsOn: ['b'] }, [{ key: 'b', title: 'B', body: '', acceptance: ['x'], milestone: 'M1', dependsOn: ['a'] }])), /cycle between: a, b/);
  assert.deepEqual(willEscalate([{ key: 'x', files: ['src/lib/money.ts', 'src/a.ts'] }, { key: 'y', files: ['src/b.ts'] }]), [{ key: 'x', paths: ['src/lib/money.ts'] }]);

  // ---- adapter contracts: every registered provider, plus a fake second one added as one file ----
  const ctxFor = (s) => ({ gh: (...a) => execFileSync(STUB, a, { encoding: 'utf8', env: { ...env, STUB_STATE: s }, stdio: ['ignore', 'pipe', 'pipe'] }), git: (...a) => git(root, ...a) });
  const cstub = path.join(root, 'contract-gh'), clone = path.join(root, 'clone');
  fs.mkdirSync(cstub);
  git(root, 'init', '-q', '-b', 'main', clone);
  fs.writeFileSync(path.join(clone, 'a.txt'), 'a');
  git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'init');
  const H = await hosts.load(), T = await trackers.load();
  assert.deepEqual([Object.keys(H), Object.keys(T)], [['github'], ['github-issues']]); // _template.mjs and index.mjs are not providers
  for (const p of Object.values(H)) hosts.contract(p, { ctx: ctxFor(cstub), repo: 'acme/contract', clone });
  for (const p of Object.values(T)) trackers.contract(p, { ctx: ctxFor(cstub), repo: 'acme/contract' });
  assert.equal(git(root, '--git-dir', stubStateOf(cstub).repos['acme/contract'].bare, 'log', '--format=%s', 'main').trim(), 'init'); // a real push
  assert.equal(T['github-issues'].createIssues(ctxFor(cstub), { repo: 'acme/contract', items: [{ key: 'a', title: 'First', body: '', acceptance: ['x'], dependsOn: [], milestone: 'M1' }] })[0].created, false); // the hidden key marker, with no local map
  const reg = path.join(root, 'registry');
  put(path.join(reg, 'hosts', 'fake.mjs'), FAKE_HOST);
  put(path.join(reg, 'trackers', 'fake.mjs'), FAKE_TRACKER);
  const FH = await hosts.load(path.join(reg, 'hosts')), FT = await trackers.load(path.join(reg, 'trackers'));
  hosts.contract(FH.fake, { ctx: {}, repo: 'acme/contract', clone });
  trackers.contract(FT.fake, { ctx: {}, repo: 'acme/contract' });
  put(path.join(root, 'bad', 'half.mjs'), "export const id = 'half';\nexport const listOpen = () => [];\n");
  await assert.rejects(trackers.load(path.join(root, 'bad')), /half.mjs: missing createIssues, dependencies/);

  // ---- F new: no login -> stop, record nothing ----
  assert.throws(() => cli(['new', IDEA, '--name', 'acme/budget', '--stack', 'mini'], { STUB_NO_AUTH: '1' }), /not logged in .*never creates accounts/);
  assert.deepEqual([events('acme/budget').length, calls()], [0, [['auth', 'status']]]);
  // ---- dry run: needs-plan, then validates and writes locally, with no gh call at all ----
  assert.equal(cli(['new', IDEA, '--name', 'acme/budget', '--stack', 'mini', '--dry-run']).status, 'needs-plan');
  const pdir = planInto('acme/budget'), issuesFile = path.join(pdir, 'issues.json');
  const dry = cli(['new', IDEA, '--name', 'acme/budget', '--stack', 'mini', '--dry-run']);
  assert.equal(dry.status, 'dry-run');
  assert.deepEqual(dry.order.slice(0, 3), ['amount-format', 'store', 'categories']);
  for (const f of ['PLAN.md', 'issues.json', 'dry-run.json', 'scaffold/AGENTS.md']) assert.ok(fs.existsSync(path.join(dry.out, f)), f);
  assert.match(fs.readFileSync(path.join(dry.out, 'scaffold/AGENTS.md'), 'utf8'), /^# budget\n\na personal budget app\n\n- `node -e 0`/);
  cli(['new', IDEA, '--name', 'acme/budget', '--stack', 'mini', '--dry-run']);
  assert.deepEqual(events('acme/budget').map((e) => `${e.stage} ${e.status}`), ['idea started', 'plan passed']); // re-runs add nothing
  assert.equal(calls().length, 1); // still only the failed auth check
  assert.throws(() => cli(['new', 'a todo app', '--name', 'acme/budget', '--stack', 'mini', '--dry-run']), /already holds the idea/);
  // ---- checkpoint: without --yes nothing remote happens; with it, a private repo + scaffold + push + checks rule ----
  assert.equal(cli(['new', IDEA, '--name', 'acme/budget', '--stack', 'mini']).status, 'needs-confirmation');
  assert.equal(count('repo create'), 0);
  const dest = path.join(root, 'work', 'budget');
  const made = cli(['new', IDEA, '--name', 'acme/budget', '--stack', 'mini', '--yes', '--path', dest]);
  assert.deepEqual([made.status, made.url, stubState().repos['acme/budget'].visibility], ['created', stubState().repos['acme/budget'].bare, 'private']);
  const bare = stubState().repos['acme/budget'].bare;
  assert.equal(git(root, '--git-dir', bare, 'log', '--format=%s', 'main').trim(), 'chore: scaffold from the mini stack template');
  assert.deepEqual(git(root, '--git-dir', bare, 'ls-tree', '--name-only', 'main').trim().split('\n').sort(), ['AGENTS.md', 'CLAUDE.md', 'PLAN.md', 'package.json']);
  const rule = cli(['rules', 'acme/budget']).policy['checks.commands'];
  assert.deepEqual([rule.value, rule.setBy], [['node -e 0'], 'stub-user']);
  cli(['new', IDEA, '--name', 'acme/budget', '--stack', 'mini', '--yes', '--path', dest]); // resume: no second repo, push is a no-op
  assert.deepEqual([count('repo create'), events('acme/budget').filter((e) => e.stage === 'repo').length], [1, 1]);
  ctxFor(stub).gh('repo', 'create', 'acme/taken', '--private', '--description', 'not ours');
  planInto('acme/taken');
  assert.throws(() => cli(['new', IDEA, '--name', 'acme/taken', '--stack', 'mini', '--yes', '--path', path.join(root, 'work', 'taken')]), /already exists on github and this project did not create it/);
  assert.equal(events('acme/taken').filter((e) => e.stage === 'repo').length, 0);
  // an init tool that commits on its own, then a later init step fails: nothing is pushed, and a re-run refuses the half-made folder
  put(path.join(tpl, 'half.json'), JSON.stringify({ ...mini, id: 'half', init: [['git', 'init', '-q', '-b', 'main'], ['git', 'commit', '-q', '--allow-empty', '-m', 'Initial commit from the init tool'], ['node', '-e', 'process.exit(1)']] }));
  planInto('acme/half');
  const half = path.join(root, 'work', 'half');
  assert.throws(() => cli(['new', IDEA, '--name', 'acme/half', '--stack', 'half', '--yes', '--path', half]), /process\.exit\(1\) failed \(exit 1\)/);
  assert.throws(() => git(root, '--git-dir', stubState().repos['acme/half'].bare, 'rev-parse', '--verify', 'main')); // nothing pushed
  assert.throws(() => cli(['new', IDEA, '--name', 'acme/half', '--stack', 'half', '--yes', '--path', half]), /exists and is not empty/);
  // ---- owned events ----
  for (const [stage, status, owner] of [['repo', 'created', 'new'], ['issues', 'created', 'issues create'], ['loop', 'running', 'loop'], ['loop', 'stopped', 'loop'], ['idea', 'started', 'new'], ['plan', 'passed', 'new']])
    assert.throws(() => run(['event', 'acme/budget:project', stage, status]), new RegExp(`recorded by "${owner}"`));
  assert.throws(() => run(['event', 'acme/budget:project', 'build', 'started']), /project runs are recorded by/);
  // ---- issue batch: preview, then one approval; dependency order, idempotent by key ----
  const pre = cli(['issues', 'create', 'acme/budget', issuesFile]);
  assert.deepEqual([pre.status, pre.issues.length, pre.issues.at(-1).kind, count('issue create')], ['needs-approval', 13, 'epic', 0]);
  const batch = cli(['issues', 'create', 'acme/budget', issuesFile, '--yes']);
  assert.deepEqual([batch.created, batch.issues.map((i) => i.id).join()], [13, '1,2,3,4,5,6,7,8,9,10,11,12,13']);
  const gi = stubState().issues['acme/budget'];
  assert.match(gi[2].body, /## Acceptance criteria\n- \[ \] The six default/);
  assert.match(gi[2].body, /Depends on #2\nMilestone: M1 Track\n\n<!-- factory-key: categories -->$/);
  assert.match(gi[8].body, /Depends on #8, #7/); // budget-summary
  assert.match(gi[12].body, /## Issues\n- \[ \] #1 Parse and format amounts/);
  assert.deepEqual([gi[0].labels, gi[12].labels], [[{ name: 'factory:ready' }], [{ name: 'factory:epic' }]]);
  const n = calls().length;
  assert.equal(cli(['issues', 'create', 'acme/budget', issuesFile, '--yes']).created, 0);
  assert.equal(calls().length, n); // every key known locally: no tracker call
  fs.rmSync(path.join(pdir, 'issues-map.json'));
  assert.equal(cli(['issues', 'create', 'acme/budget', issuesFile, '--yes']).created, 0); // map lost: the marker still finds them
  assert.equal(count('issue create'), 13);
  assert.equal(events('acme/budget').filter((e) => e.stage === 'issues').length, 1);
  // ---- sync, dependency-aware queue, loop ----
  assert.deepEqual(cli(['sync', 'acme/budget', dest])[0].added, []);
  const q = cli(['queue', 'acme/budget']);
  assert.deepEqual(q.ready.map((x) => x.run), ['acme/budget#1', 'acme/budget#2']);
  assert.deepEqual(q.blocked.find((x) => x.key === 'categories').waitingOn, ['acme/budget#2']);
  assert.deepEqual(q.untriaged, []);
  assert.equal(cli(['loop', 'acme/budget']).next, 'acme/budget#1');
  assert.deepEqual(cli(['loop', 'acme/budget']), { state: 'running', next: 'acme/budget#1', resume: true, goal: '`node -e 0` exit 0, only files listed in the spec changed, or stop after 20 turns' });
  assert.equal(events('acme/budget').filter((e) => e.status === 'running').length, 1);
  merged('acme/budget#1');
  assert.equal(cli(['loop', 'acme/budget']).next, 'acme/budget#2');
  append('acme/budget#2', 'intake', 'started', { association: 'OWNER' });
  append('acme/budget#2', 'approve', 'escalated');
  assert.match(cli(['loop', 'acme/budget']).reason, /^acme\/budget#2 is escalated: a human needs to resolve it/); // first escalation stops
  assert.equal(cli(['loop', 'acme/budget']).state, 'stopped'); // continue: still unresolved
  const st = stubState(); st.issues['acme/budget'][1].state = 'CLOSED'; fs.writeFileSync(path.join(stub, 'state.json'), JSON.stringify(st)); // a human merged it by hand
  assert.equal(cli(['loop', 'acme/budget']).next, 'acme/budget#3'); // continue picks up, and the closed dependency counts as done
  // ---- the project budget and the session cap, through rules ----
  assert.throws(() => run(['rules', 'set', 'acme/budget', 'project.budgetUsd', '500', '--reason', 'x']), /at most 50/);
  run(['rules', 'set', 'acme/budget', 'project.budgetUsd', '1', '--reason', 'try it cheaply']);
  merged('acme/budget#3', { costUsd: 2 });
  assert.match(cli(['loop', 'acme/budget']).reason, /^project budget reached: \$2 of \$1/);
  run(['rules', 'unset', 'acme/budget', 'project.budgetUsd']);
  run(['rules', 'set', 'acme/budget', 'project.maxIssuesPerSession', '1', '--reason', 'one at a time']);
  assert.equal(cli(['loop', 'acme/budget']).next, 'acme/budget#4'); // a new session after the stop
  merged('acme/budget#4');
  assert.match(cli(['loop', 'acme/budget']).reason, /1 issue\(s\) this session/);
  const s = cli(['project', 'acme/budget']);
  assert.deepEqual([s.phase, s.milestones[0], s.burn.usd, s.next.key, s.epic.id], ['stopped', { name: 'M1 Track', merged: 3, total: 6 }, 2, 'transaction-list', '13']);
  assert.deepEqual(s.issues.slice(0, 5).map((i) => i.state), ['merged', 'escalated', 'merged', 'merged', 'ready']);
  const html = fs.readFileSync(path.join(dir, 'dashboard.html'), 'utf8');
  assert.equal(html.split('__FACTORY_DATA__').length, 1);
  assert.match(html, /"ideas":\{"acme\/budget":\{"run":"acme\/budget:project"/);
  // a merged run reverted after merge stops the loop once, and keeps blocking its dependents
  run(['rules', 'unset', 'acme/budget', 'project.maxIssuesPerSession']);
  assert.equal(cli(['loop', 'acme/budget']).next, 'acme/budget#5');
  merged('acme/budget#5');
  append('acme/budget#5', 'approve', 'reverted', { pr: 'https://github.com/acme/budget/pull/99', reason: 'main CI red' });
  assert.match(cli(['loop', 'acme/budget']).reason, /^acme\/budget#5 was reverted after merge \(main CI red\)/);
  assert.equal(cli(['loop', 'acme/budget']).next, 'acme/budget#8'); // continue: #6 and #7 depend on #5 and stay blocked
  assert.deepEqual(cli(['queue', 'acme/budget']).blocked.filter((x) => x.waitingOn.includes('acme/budget#5')).map((x) => x.run), ['acme/budget#6', 'acme/budget#7']);
  // ---- a fake host and tracker, one file each in a registry dir, end to end: no core change ----
  const fk = { FACTORY_HOSTS: path.join(reg, 'hosts'), FACTORY_TRACKERS: path.join(reg, 'trackers') };
  assert.equal(cli(['new', IDEA, '--name', 'acme/fk', '--stack', 'mini', '--host', 'fake', '--tracker', 'fake', '--dry-run'], fk).status, 'needs-plan');
  const fdir = planInto('acme/fk', fk);
  assert.equal(cli(['new', IDEA, '--name', 'acme/fk', '--stack', 'mini', '--host', 'fake', '--tracker', 'fake', '--yes', '--path', path.join(root, 'work', 'fk')], fk).url, 'fake://acme/fk');
  assert.equal(cli(['issues', 'create', 'acme/fk', path.join(fdir, 'issues.json'), '--yes'], fk).created, 13);
  assert.deepEqual(cli(['queue', 'acme/fk'], fk).ready.map((x) => x.run), ['acme/fk#FK-1', 'acme/fk#FK-2']);
  // ---- F ui: the wizard endpoint only records "idea started" and returns an id-based command ----
  const tok = 'w'.repeat(32), uctx = { token: tok, port: 4242 };
  const post = (h, body) => uiHandle({ method: 'POST', url: '/idea', headers: { host: '127.0.0.1:4242', origin: 'http://127.0.0.1:4242', 'content-type': 'application/json', 'x-factory-token': tok, ...h }, body: JSON.stringify(body) }, uctx);
  const idea = { repo: 'acme/ui', idea: 'a habit tracker; $(rm -rf ~) `x`', stack: 'next-web' };
  assert.equal(post({ 'x-factory-token': 'u'.repeat(32) }, idea).status, 403);
  assert.equal(post({ origin: 'https://evil.test' }, idea).status, 403);
  for (const bad of [{ ...idea, repo: 'acme' }, { ...idea, idea: '' }, { ...idea, stack: 'cobol' }, { ...idea, idea: 'x\ny' }]) assert.equal(post({}, bad).status, 400);
  const ok = post({}, idea);
  assert.deepEqual([ok.status, JSON.parse(ok.body)], [200, { run: 'acme/ui:project', next: '/software-factory new acme/ui' }]);
  post({}, idea);
  assert.deepEqual(read().filter((e) => e.run === 'acme/ui:project').map((e) => [e.stage, e.status, e.idea]), [['idea', 'started', idea.idea]]);
  // ---- F retire: an idea that never got a repo is hidden by an appended event; the log keeps every line ----
  assert.equal(cli(['new', 'a habit tracker', '--name', 'acme/gone', '--stack', 'mini', '--dry-run']).status, 'needs-plan');
  assert.throws(() => run(['retire', 'acme/gone']), /--reason/);
  assert.throws(() => run(['retire', 'acme/budget', '--reason', 'x']), /already has a repo/);
  assert.throws(() => run(['event', 'acme/gone:project', 'idea', 'retired']), /recorded by "retire"/);
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').length;
  assert.equal(cli(['retire', 'acme/gone', '--reason', 'leaked test fixture']).status, 'retired');
  assert.equal(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').length, lines + 1);
  assert.throws(() => run(['project', 'acme/gone']), /no project acme\/gone/);
  assert.throws(() => run(['retire', 'acme/gone', '--reason', 'again']), /no project acme\/gone/);
  assert.ok(!fs.readFileSync(path.join(dir, 'dashboard.html'), 'utf8').includes('acme/gone'));
  assert.equal(cli(['new', 'a reading log', '--name', 'acme/gone', '--stack', 'mini', '--dry-run']).status, 'needs-plan'); // the name is free again
  assert.equal(cli(['project', 'acme/gone']).idea, 'a reading log');
}

const stubStateOf = (s) => JSON.parse(fs.readFileSync(path.join(s, 'state.json'), 'utf8'));
