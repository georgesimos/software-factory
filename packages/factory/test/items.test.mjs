// @ts-nocheck
// The tracker side of a run behind the adapters (docs/plans/local-first.md PR 6b): F labels, F label, F comment, F split and
// F similar. The target is always the run's own item, and the text is F's or the recorded event's, never typed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import { comment, label, labels, similar, split } from '../../core/src/items.ts';
import { getRun } from '../../core/src/derive.ts';
import { io, read, record, runDir } from '../../core/src/log.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';

setup();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-items-'));
const ghLog = path.join(root, 'gh.log'), ghStub = path.join(root, 'gh.mjs'), count = path.join(root, 'count');
// logs argv and stdin; STUB_DEL: how a label DELETE fails (gone: "Label does not exist", else a real 404)
fs.writeFileSync(ghStub, `import fs from 'node:fs';
const a = process.argv.slice(2).join(' '), out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const input = a.includes('--input -') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ a, input }) + '\\n');
if (a.startsWith('label create')) out('');
else if (a.startsWith('issue list -R acme/it --state all')) out([]);
else if (a.startsWith('issue list -R acme/it --state open')) out([
  { number: 3, title: 'Login page crashes on Safari', labels: [], body: 'the login form' },
  { number: 4, title: 'Dark mode', labels: [{ name: 'factory:ready' }], body: 'login and dark mode colours' },
  { number: 5, title: 'Unrelated', labels: [], body: 'nothing' },
  { number: 9, title: 'Login crash (this run)', labels: [], body: 'login' }]);
else if (a.startsWith('issue create')) {
  const n = fs.existsSync(${JSON.stringify(count)}) ? +fs.readFileSync(${JSON.stringify(count)}, 'utf8') : 100;
  fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
  out('https://github.com/acme/it/issues/' + n + '\\n');
}
else if (/^api -X POST repos\\/acme\\/it\\/issues\\/\\d+\\/(labels|comments) --input -$/.test(a)) out('{}');
else if (a.startsWith('api -X DELETE repos/acme/it/issues/')) {
  if (process.env.STUB_DEL === 'gone') { process.stderr.write('gh: Label does not exist (HTTP 404)'); process.exit(1); }
  if (process.env.STUB_DEL) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
  out('');
}
else process.exit(1);
`);
io.gh = ghStub;
const calls = () => { try { return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reset = () => { fs.rmSync(ghLog, { force: true }); fs.rmSync(count, { force: true }); };
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const clone = fs.mkdtempSync(path.join(root, 'clone-'));
git('-C', clone, 'init', '-q', '-b', 'main');
fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'acme/it': { path: clone } }));
const started = (n, p = { association: 'OWNER' }) => { const run = `acme/it#${n}`; record(run, 'intake', 'started', { title: `Issue ${n}`, ...p }); return run; };
const F = (input, ...args) => spawnSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: ghStub }, input, encoding: 'utf8' });
const kids = [{ title: 'Part one', body: 'Do one, ask @octocat.', acceptance: ['one works'] }, { title: 'Part two', body: 'Do two.', acceptance: ['two works'] }];

test('F labels creates the factory\'s labels on the tracker', () => {
  reset();
  const made = labels('acme/it');
  const names = calls().map((c) => c.a.split(' ')[2]);
  for (const l of ['factory:in-progress', 'factory:needs-info', 'factory:rejected', 'factory:needs-human', 'factory:merged', 'factory:ready', 'factory:needs-approval', 'factory:epic']) assert.ok(names.includes(l), l);
  assert.ok(calls().every((c) => / -R acme\/it --force --color [0-9A-F]{6}$/.test(c.a)), calls()[0].a);
  assert.deepEqual(made.labels.length, names.length);
});

test('F label: only the allow-list, on the run\'s own issue; a gone label on remove is fine, any other failure throws', () => {
  reset();
  const run = started(1);
  assert.deepEqual(label(run, 'add', 'factory:in-progress'), { labelled: true });
  assert.deepEqual(calls().map((c) => [c.a, c.input]), [['api -X POST repos/acme/it/issues/1/labels --input -', '{"labels":["factory:in-progress"]}']]);
  reset();
  label(run, 'remove', 'factory:needs-info');
  assert.deepEqual(calls().map((c) => c.a), ['api -X DELETE repos/acme/it/issues/1/labels/factory:needs-info']);
  process.env.STUB_DEL = 'gone';
  try { assert.deepEqual(label(run, 'remove', 'factory:needs-info'), { labelled: true }); } finally { delete process.env.STUB_DEL; }
  process.env.STUB_DEL = '404';
  try { assert.throws(() => label(run, 'remove', 'factory:needs-info'), /Not Found/); } finally { delete process.env.STUB_DEL; }
  reset();
  assert.throws(() => label(run, 'add', 'factory:ready'), /factory:ready is added by F split \(a trusted parent's children\) or a human, not by F label/);
  assert.throws(() => label(run, 'add', 'factory:merged'), /factory:merged is added by F merge and F sync, not by F label/);
  assert.throws(() => label(run, 'add', 'factory:needs-human'), /factory:needs-human is added by F escalate and F revert/);
  assert.throws(() => label(run, 'remove', 'factory:epic'), /factory:epic is added by F issues create/);
  assert.throws(() => label(run, 'add', 'bug'), /bug is not one of the labels F label sets: factory:in-progress, factory:needs-info, factory:rejected, factory:needs-approval/);
  assert.throws(() => label(run, 'toggle', 'factory:in-progress'), /label RUN add\|remove LABEL/);
  record('acme/it#2', 'intake', 'started', { title: 'Theirs', imported: true });
  assert.throws(() => label('acme/it#2', 'add', 'factory:in-progress'), /is imported/);
  assert.deepEqual(calls(), []);
  const cli = F('', 'label', run, 'add', 'factory:rejected');
  assert.equal(cli.status, 0, cli.stderr);
});

test('F comment posts intake\'s recorded reason or questions, scrubbed and unmentioned; nothing else', () => {
  reset();
  const run = started(6);
  assert.throws(() => comment(run), /acme\/it#6 has nothing to comment: no recorded rejection \(with a reason\), needs-info \(with questions\) or spec awaiting approval/);
  record(run, 'intake', 'rejected', { reason: 'A duplicate of #3; see /Users/pat-private/notes, ask @octocat' });
  assert.deepEqual(comment(run), { posted: true });
  const [c] = calls();
  assert.equal(c.a, 'api -X POST repos/acme/it/issues/6/comments --input -');
  assert.equal(JSON.parse(c.input).body, 'The software factory won\'t build this.\n\nWhy: A duplicate of #3; see [local path], ask @‍octocat');
  const r7 = started(7);
  record(r7, 'intake', 'needs-info', { questions: ['Which browser?', 'Since which release?'] });
  reset();
  comment(r7);
  assert.equal(JSON.parse(calls()[0].input).body, 'The software factory needs more information before it can build this:\n\n1. Which browser?\n2. Since which release?\n\nAnswer in a comment here; the factory reads new comments when it runs again.');
  const r9 = started(20); // a risky spec waiting for a maintainer: the spec F recorded it with, and how to answer
  fs.mkdirSync(runDir(r9), { recursive: true });
  fs.writeFileSync(path.join(runDir(r9), 'spec.md'), '# Goal\n\nFix it, cc @octocat.\n');
  record(r9, 'intake', 'passed', { summary: 's' });
  record(r9, 'spec', 'awaiting-approval', { spec: 'one line', reasons: ['author association "NONE" is not trusted'] });
  reset();
  comment(r9);
  assert.equal(JSON.parse(calls()[0].input).body, '# Goal\n\nFix it, cc @\u200doctocat.\n\nA maintainer can reply `/factory approve` or `/factory reject`.');
  record(r9, 'spec', 'passed', { spec: 'one line' });
  assert.throws(() => comment(r9), /has nothing to comment/, 'a spec that passed has nothing to ask');
  record('acme/it#21', 'intake', 'started', { title: 'x' });
  record('acme/it#21', 'intake', 'rejected', {});
  assert.throws(() => comment('acme/it#21'), /has nothing to comment/, 'a rejection with no reason');
  record('acme/it#8', 'intake', 'started', { title: 'x' });
  record('acme/it#8', 'intake', 'needs-info', { questions: [] });
  assert.throws(() => comment('acme/it#8'), /has nothing to comment/);
});

test('F split: children from F\'s text ("Part of #N", a key per child), factory:ready only for a trusted parent; F records the split', () => {
  reset();
  const run = started(10);
  assert.match(F('{"children":["acme/it#99"]}', 'event', run, 'intake', 'split', '-').stderr, /"intake split" is recorded by "split", not by hand/);
  assert.match(F('{"children":["acme/it#99"]}', 'event', run, 'intake', 'passed', '-').stderr, /not from a payload: children/);
  const out = split(run, { children: kids });
  assert.deepEqual(out, { ready: true, children: [{ run: 'acme/it#100', url: 'https://github.com/acme/it/issues/100', created: true }, { run: 'acme/it#101', url: 'https://github.com/acme/it/issues/101', created: true }] });
  const made = calls().filter((c) => c.a.startsWith('issue create'));
  assert.equal(made.length, 2);
  assert.match(made[0].a, /^issue create -R acme\/it --title Part one --body Part of #10\n\nDo one, ask @‍octocat\.\n\n## Acceptance criteria\n- \[ \] one works\n\n<!-- factory-key: split-10-1 --> --label factory:ready$/);
  assert.match(made[1].a, /<!-- factory-key: split-10-2 --> --label factory:ready$/);
  const e = read().filter((x) => x.run === run).at(-1);
  assert.deepEqual([e.stage, e.status, e.children], ['intake', 'split', ['acme/it#100', 'acme/it#101']]);
  assert.equal(getRun(run).outcome, 'split');
  assert.throws(() => split(run, { children: kids }), /acme\/it#10 is not right after F intake/);
});

test('F split: an untrusted parent, or one split from an untrusted origin, makes children nobody can pick up', () => {
  reset();
  const run = started(11, { association: 'NONE' });
  assert.equal(split(run, { children: kids }).ready, false);
  assert.ok(calls().filter((c) => c.a.startsWith('issue create')).every((c) => !c.a.includes('--label')), 'no factory:ready, ever: F queue could pick it up before a removal');
  reset();
  const r2 = started(12, { association: 'OWNER', origin: 'acme/it#11', originAssociation: 'NONE' });
  assert.equal(split(r2, { children: kids }).ready, false);
  assert.ok(calls().filter((c) => c.a.startsWith('issue create')).every((c) => !c.a.includes('--label')));
  assert.equal(split(started(15, {}), { children: kids }).ready, false, 'no recorded association: never trusted');
  reset();
  split(started(16), { children: [{ ...kids[0], title: 'Ask @octocat' }, kids[1]] });
  assert.match(calls().find((c) => c.a.startsWith('issue create')).a, /--title Ask @\u200doctocat --body/);
});

test('F split refuses bad children and an imported run; --dry-run creates and records nothing', () => {
  reset();
  const run = started(13);
  for (const [bad, why] of [[{}, /2 to 10 children/], [{ children: [kids[0]] }, /2 to 10 children/], [{ children: Array(11).fill(kids[0]) }, /2 to 10 children/],
    [{ children: [kids[0], { ...kids[1], title: 'a\nb' }] }, /child 2: a one-line title of 1-200 characters/], [{ children: [kids[0], { ...kids[1], title: 'x'.repeat(201) }] }, /child 2: a one-line title/],
    [{ children: [kids[0], { ...kids[1], acceptance: [] }] }, /child 2: acceptance needs 1 to 20 testable criteria/], [{ children: [kids[0], { ...kids[1], body: 'x'.repeat(20_001) }] }, /child 2: a body of at most 20000 characters/],
    [{ children: [kids[0], { ...kids[1], labels: ['factory:ready'] }] }, /child 2: unknown field labels \(title, body, acceptance\)/]]) assert.throws(() => split(run, bad), why);
  const before = read().length;
  assert.deepEqual(split(run, { children: kids }, { dryRun: true }), { dryRun: true, ready: true, children: [{ key: 'split-13-1', title: 'Part one' }, { key: 'split-13-2', title: 'Part two' }] });
  assert.deepEqual([calls(), read().length], [[], before]);
  record('acme/it#14', 'intake', 'started', { title: 'Theirs', imported: true });
  assert.throws(() => split('acme/it#14', { children: kids }), /is imported/);
  const cli = F(JSON.stringify({ children: kids }), 'split', run, '-', '--dry-run');
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).dryRun, true);
});

test('F similar: open items matching the words, best first, never the run\'s own, ids and titles only', () => {
  reset();
  assert.deepEqual(similar('acme/it#9', ['Login', 'crash', 'it']), { similar: [{ run: 'acme/it#3', title: 'Login page crashes on Safari' }, { run: 'acme/it#4', title: 'Dark mode' }], note: 'open items only: a closed duplicate is not listed' });
  assert.deepEqual(calls().map((c) => c.a), ['issue list -R acme/it --state open --limit 200 --json number,title,labels,body']);
  assert.deepEqual(similar('acme/it#9', ['login', 'dark', 'mode']).similar.map((x) => x.run), ['acme/it#4', 'acme/it#3'], 'most matches first, not lowest id');
  assert.throws(() => similar('acme/it#9', ['a', 'of']), /at least one word of 3 or more letters/);
});

test('a local project: F label edits the item file, F comment posts nothing, F split children are never ready', () => {
  reset();
  const g = fs.mkdtempSync(path.join(root, 'local-'));
  git('-C', g, 'init', '-q', '-b', 'main');
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'local/it': { path: g } }));
  fs.mkdirSync(path.join(g, '.factory', 'issues'), { recursive: true });
  fs.writeFileSync(path.join(g, '.factory', 'issues', '1.md'), '---\ntitle: "Local one"\nstate: open\nlabels: ["factory:ready"]\n---\n\nBody text.\n');
  const run = 'local/it#1';
  record(run, 'intake', 'started', { title: 'Local one', association: 'NONE' });
  assert.deepEqual(label(run, 'add', 'factory:in-progress'), { labelled: true });
  const text = () => fs.readFileSync(path.join(g, '.factory', 'issues', '1.md'), 'utf8');
  assert.equal(text(), '---\ntitle: "Local one"\nstate: open\nlabels: ["factory:ready","factory:in-progress"]\n---\n\nBody text.\n');
  label(run, 'remove', 'factory:in-progress');
  assert.match(text(), /^labels: \["factory:ready"\]$/m);
  record(run, 'intake', 'rejected', { reason: 'no' });
  assert.deepEqual(comment(run), { posted: false, detail: 'local items have no comments: the reason is in the run\'s events and the dashboard' });
  record('local/it#2', 'intake', 'started', { title: 'Big', association: 'NONE' });
  assert.equal(split('local/it#2', { children: kids }).ready, false);
  const child = fs.readFileSync(path.join(g, '.factory', 'issues', '2.md'), 'utf8');
  assert.match(child, /^labels: \[\]$/m);
  assert.match(child, /\n\nPart of #2\n\nDo one/);
  assert.deepEqual(calls(), [], 'no gh at all');
});

test('SKILL.md and its references name no gh: every host and tracker write is an F command (the user\'s own `gh auth login` aside)', () => {
  for (const f of ['SKILL.md', ...fs.readdirSync(path.join(HERE, 'references')).filter((x) => x.endsWith('.md')).map((x) => path.join('references', x))]) {
    const text = fs.readFileSync(path.join(HERE, f), 'utf8').replaceAll('`gh auth login`', '');
    const at = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\bgh\b/.test(l)).map(([i, l]) => `${f}:${i}: ${l.slice(0, 120)}`);
    assert.deepEqual(at, [], at.join('\n'));
  }
});

test('the tracker contract fails a tracker that labels factory:ready whatever ready says', async () => {
  const { contract } = await import('../../adapters/trackers/index.ts');
  const db = [];
  const careless = { id: 'careless', dependencies: (i) => i.deps,
    listOpen: () => db.map((x) => ({ ...x })),
    createIssues: (_c, { items, existing = {}, onCreated = () => {} }) => items.map((it) => {
      const have = existing[it.key] || db.find((x) => x.key === it.key);
      if (have) return { key: it.key, id: have.id, created: false };
      const x = { id: String(db.length + 1), key: it.key, title: it.title, labels: it.kind === 'epic' ? [] : ['factory:ready'], deps: (it.dependsOn || []).map((k) => db.find((y) => y.key === k).id) };
      db.push(x); const r = { key: it.key, id: x.id, created: true }; onCreated(r); return r;
    }) };
  assert.throws(() => contract(careless, { ctx: {}, repo: 'acme/careless' }), /careless: ready: false creates it without factory:ready/);
});
