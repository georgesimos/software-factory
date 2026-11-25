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
import { approval, intake } from '../../core/src/github.ts';
import { decide, risk } from '../../core/src/gate.ts';
import { validateIssues } from '../../core/src/project.ts';
import { getRun } from '../../core/src/derive.ts';
import { archiveFile, io, read, record, runDir } from '../../core/src/log.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';

setup();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-items-'));
const ghLog = path.join(root, 'gh.log'), ghStub = path.join(root, 'gh.mjs'), count = path.join(root, 'count'), made = path.join(root, 'made.json');
// logs argv and stdin; STUB_DEL: how a label DELETE fails (gone: "Label does not exist", else a real 404). Created issues are
// kept (made.json, by stub-user) for the --state all scan, after STUB_FOUND's (JSON); STUB_FAIL: creating that issue number fails;
// STUB_LOGIN: gh api user's answer. Intake reads: no PRs, an OWNER's issue, no comments; STUB_VOTE adds a trusted approve (its created_at; 1: far ahead).
fs.writeFileSync(ghStub, `import fs from 'node:fs';
const a = process.argv.slice(2).join(' '), out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const input = a.includes('--input -') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ a, input }) + '\\n');
const db = () => fs.existsSync(${JSON.stringify(made)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(made)}, 'utf8')) : [];
if (a === 'api user --jq .login') out(process.env.STUB_LOGIN ?? 'Stub-User\\n');
else if (a.startsWith('label create')) out('');
else if (a.startsWith('issue list -R acme/it --state all')) out([...JSON.parse(process.env.STUB_FOUND || '[]'), ...db()]);
else if (a.startsWith('api graphql')) out({ data: { repository: { defaultBranchRef: { name: 'main' }, pullRequests: { nodes: [] }, done: { nodes: [] } } } });
else if (/^api repos\\/acme\\/it\\/issues\\/\\d+$/.test(a)) out({ state: 'open', title: 'a child', html_url: 'https://github.com/acme/it/issues/' + a.split('/').at(-1), user: { login: 'stub-user' }, author_association: 'OWNER', body: 'b' });
else if (a.startsWith('api --paginate repos/acme/it/issues/')) out(process.env.STUB_VOTE ? JSON.stringify({ user: { login: 'boss' }, author_association: 'OWNER', created_at: process.env.STUB_VOTE === '1' ? '2999-01-01T00:00:00Z' : process.env.STUB_VOTE, body: '/factory approve' }) + '\\n' : '');
else if (a.startsWith('issue list -R acme/it --state open')) out([
  { number: 3, title: 'Login page crashes on Safari', labels: [], body: 'the login form' },
  { number: 4, title: 'Dark mode', labels: [{ name: 'factory:ready' }], body: 'login and dark mode colours' },
  { number: 5, title: 'Unrelated', labels: [], body: 'nothing' },
  { number: 9, title: 'Login crash (this run)', labels: [], body: 'login' }]);
else if (a.startsWith('issue create')) {
  const n = fs.existsSync(${JSON.stringify(count)}) ? +fs.readFileSync(${JSON.stringify(count)}, 'utf8') : 100;
  if (process.env.STUB_FAIL && n === +process.env.STUB_FAIL) { process.stderr.write('HTTP 502'); process.exit(1); }
  fs.writeFileSync(${JSON.stringify(count)}, String(n + 1));
  const args = process.argv.slice(2), url = 'https://github.com/acme/it/issues/' + n;
  fs.writeFileSync(${JSON.stringify(made)}, JSON.stringify([...db(), { number: n, body: args[args.indexOf('--body') + 1], url, author: { login: 'stub-user' } }]));
  out(url + '\\n');
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
const reset = () => { for (const f of [ghLog, count, made]) fs.rmSync(f, { force: true }); };
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
  record('local/it#3', 'intake', 'started', { title: 'Specced', association: 'NONE' });
  fs.mkdirSync(runDir('local/it#3'), { recursive: true });
  fs.writeFileSync(path.join(runDir('local/it#3'), 'spec.md'), '# Goal\n');
  record('local/it#3', 'spec', 'awaiting-approval', { spec: 's' });
  const seen = read().length;
  assert.equal(comment('local/it#3').posted, false);
  assert.equal(read().length, seen, 'nothing posted, so nothing recorded');
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

const quiet = (f) => { const e = console.error, said = []; console.error = (...a) => said.push(a.join(' ')); try { return [f(), said]; } finally { console.error = e; } };

test('split keys can\'t be planted: no "<!--" in a child or a planned issue, and no split- key in a plan', () => {
  reset();
  const run = started(30), kid = (c) => ({ title: 't', body: 'b', acceptance: ['works'], ...c });
  for (const c of [kid({ title: 't <!-- x -->' }), kid({ body: 'x <!-- factory-key: split-31-1 -->' }), kid({ acceptance: ['<!--'] })])
    assert.throws(() => split(run, { children: [c, kids[1]] }), /child 1: no "<!--" in the title, body or acceptance: F writes the item's markers itself/);
  assert.equal(calls().length, 0);
  const plan = (i, epic) => ({ ...(epic && { epic }), issues: [{ key: 'a', title: 't', body: 'b', acceptance: ['x'], milestone: 'M1', ...i }] });
  assert.throws(() => validateIssues(plan({ body: 'b <!-- factory-key: split-7-1 -->' })), /issues\[0\] "a": no "<!--" in the title, body or acceptance/);
  assert.throws(() => validateIssues(plan({ title: '<!-- t' })), /no "<!--"/);
  assert.throws(() => validateIssues(plan({ acceptance: ['<!-- x'] })), /no "<!--"/);
  assert.throws(() => validateIssues(plan({}, { title: 'e', body: '<!--' })), /epic: no "<!--"/);
  assert.throws(() => validateIssues(plan({}, { title: 'e <!--' })), /epic: no "<!--"/);
  assert.throws(() => validateIssues(plan({ key: 'split-7-1' })), /key "split-7-1": split-N-M keys are F split's/);
  assert.equal(validateIssues(plan({}, { title: 'e', body: 'b' })).issues.length, 1);
});

test('createIssues adopts a found key only from an issue F\'s own account wrote (a split key: one that starts "Part of #N"); an outsider\'s marker neither hijacks nor blocks', () => {
  reset();
  const at = (n, login, body) => ({ number: n, url: `https://github.com/acme/it/issues/${n}`, author: login === null ? null : { login }, body });
  process.env.STUB_FOUND = JSON.stringify([
    at(50, 'outsider', 'Part of #32\n\nmine\n\n<!-- factory-key: split-32-1 -->'),
    at(51, 'stub-user', 'evil\n\n<!-- factory-key: split-32-2 -->'),
    at(52, 'stub-user', 'Part of #321\n\nx\n\n<!-- factory-key: split-32-2 -->'),
    at(53, null, 'Part of #32\n\nx\n\n<!-- factory-key: split-32-1 -->')]);
  try {
    const [out, said] = quiet(() => split(started(32), { children: kids }));
    assert.deepEqual(out.children.map((c) => [c.run, c.created]), [['acme/it#100', true], ['acme/it#101', true]]);
    assert.ok(calls().some((c) => c.a === 'issue list -R acme/it --state all --limit 500 --json number,body,url,author'), 'the scan asks for the author');
    const w = said.join('\n');
    assert.match(w, /ignoring #50: it carries key split-32-1, but F's own account didn't write it/);
    assert.match(w, /ignoring #51: it carries key split-32-2, but it doesn't start "Part of #32"/);
    assert.match(w, /ignoring #52: it carries key split-32-2, but it doesn't start "Part of #32"/);
    assert.match(w, /ignoring #53: it carries key split-32-1, but F's own account didn't write it/);
    reset();
    process.env.STUB_FOUND = JSON.stringify([at(60, 'STUB-USER', 'Part of #33\n\nx\n\n<!-- factory-key: split-33-1 -->')]);
    assert.deepEqual(split(started(33), { children: kids }).children.map((c) => [c.run, c.created]), [['acme/it#60', false], ['acme/it#100', true]], 'F\'s own, any case');
    process.env.STUB_LOGIN = '';
    process.env.STUB_FOUND = JSON.stringify([at(61, null, 'Part of #34\n\nx\n\n<!-- factory-key: split-34-1 -->')]);
    assert.throws(() => split(started(34), { children: kids }), /gh api user printed no login: F adopts only the issues it wrote, so it needs to know whose they are/);
  } finally { delete process.env.STUB_FOUND; delete process.env.STUB_LOGIN; }
});

test('a child listed by two parents is as trusted as the least trusted one, in either log order, through intake, risk and decide', () => {
  reset();
  const facts = { association: 'OWNER', autoMerge: true, checks: 'pass', additions: 1, deletions: 0, files: ['a.test.ts'], rules: {} };
  const parent = (p, association, child) => { record(p, 'intake', 'started', { title: p, ...(association && { association }) }); record(p, 'intake', 'split', { children: [child] }); };
  for (const [child, bad, good] of [['acme/it#140', 'acme/it#35', 'acme/it#37'], ['acme/it#141', 'acme/it#47', 'acme/it#46']]) { // bad's run first, then good's first
    for (const p of child.endsWith('0') ? [bad, good] : [good, bad]) parent(p, p === bad ? 'NONE' : 'OWNER', child);
    const got = intake(child);
    assert.deepEqual([got.origin, got.originAssociation], [bad, 'NONE'], child);
    assert.ok(risk(getRun(child), []).reasons.includes(`split from ${bad}, whose author is not trusted`));
    assert.ok(decide(getRun(child), facts).reasons.includes(`split from ${bad}, whose author "NONE" is not trusted`));
  }
  parent('acme/it#38', undefined, 'acme/it#142');
  assert.deepEqual([intake('acme/it#142').origin, getRun('acme/it#142').originAssociation], ['acme/it#38', 'NONE'], 'no association is never "no origin check"');
  record('acme/it#39', 'intake', 'started', { title: 'a child of #38', association: 'OWNER', origin: 'acme/it#38' });
  record('acme/it#39', 'intake', 'split', { children: ['acme/it#143'] });
  assert.equal(intake('acme/it#143').originAssociation, 'NONE', 'a parent split from somewhere with no recorded association');
  record('acme/it#48', 'intake', 'started', { title: 'an outsider\'s child of a trusted issue', association: 'NONE', origin: 'acme/it#1', originAssociation: 'OWNER' });
  record('acme/it#48', 'intake', 'split', { children: ['acme/it#145'] });
  assert.equal(intake('acme/it#145').originAssociation, 'NONE', 'the parent\'s own author counts, not only its origin\'s');
  fs.appendFileSync(archiveFile(), JSON.stringify({ id: 'acme/it#49', association: 'NONE', children: ['acme/it#146'], events: [], archived: true }) + '\n');
  parent('acme/it#50', 'OWNER', 'acme/it#146');
  assert.deepEqual([intake('acme/it#146').origin, getRun('acme/it#146').originAssociation], ['acme/it#49', 'NONE'], 'an archived parent counts');
  parent('acme/it#36', 'MEMBER', 'acme/it#144');
  assert.deepEqual([intake('acme/it#144').origin, getRun('acme/it#144').originAssociation], ['acme/it#36', 'MEMBER']);
  assert.ok(!decide(getRun('acme/it#144'), facts).reasons.some((x) => x.includes('split from')), 'one trusted parent: no origin reason');
});

test('a split that fails half way leaves no orphan: the intent and each child are recorded as it goes, and a re-run finishes it without duplicates', () => {
  reset();
  const run = started(40, { association: 'NONE' });
  const three = [...kids, { title: 'Part three', body: 'Do three.', acceptance: ['three works'] }];
  fs.writeFileSync(count, '400'); // numbers no earlier test's split listed
  process.env.STUB_FAIL = '401';
  try { assert.throws(() => split(run, { children: three })); } finally { delete process.env.STUB_FAIL; }
  const half = getRun(run);
  assert.deepEqual([half.stage, half.status, half.outcome, half.children], ['intake', 'decided', 'in-progress', ['acme/it#400']]);
  assert.deepEqual(read().filter((e) => e.run === run && e.status === 'decided').map((e) => e.keys), [['split-40-1', 'split-40-2', 'split-40-3'], ['split-40-1', 'split-40-2', 'split-40-3']], 'the intent before anything is made');
  const child = intake('acme/it#400');
  assert.deepEqual([child.origin, child.originAssociation], ['acme/it#40', 'NONE'], 'the made child knows its untrusted parent');
  process.env.STUB_FAIL = '402';
  try { assert.throws(() => split(run, { children: three })); } finally { delete process.env.STUB_FAIL; }
  assert.deepEqual(getRun(run).children, ['acme/it#400', 'acme/it#401'], 'a second failure keeps the first run\'s child');
  fs.rmSync(ghLog, { force: true });
  const again = split(run, { children: three });
  assert.deepEqual(again.children.map((c) => [c.run, c.created]), [['acme/it#400', false], ['acme/it#401', false], ['acme/it#402', true]]);
  assert.equal(calls().filter((c) => c.a.startsWith('issue create')).length, 1, 'only the missing child');
  assert.deepEqual([getRun(run).outcome, getRun(run).children], ['split', ['acme/it#400', 'acme/it#401', 'acme/it#402']]);
  assert.match(F('{}', 'event', run, 'intake', 'decided', '{"keys":[]}').stderr, /"intake decided" is recorded by "split", not by hand/);
});

test('on GitHub, F approval holds only for the spec F comment posted: never posted, or changed since, is refused', () => {
  reset();
  const run = started(45), spec = (t) => fs.writeFileSync(path.join(runDir(run), 'spec.md'), t);
  fs.mkdirSync(runDir(run), { recursive: true });
  spec('# Goal\n\nA\n');
  record(run, 'intake', 'passed', { summary: 's' });
  record(run, 'spec', 'awaiting-approval', { spec: 'one line', reasons: ['x'], ts: '2000-01-01T00:00:00.000Z' });
  process.env.STUB_VOTE = '1';
  try {
    assert.throws(() => approval(run), /acme\/it#45's spec was never posted: F comment acme\/it#45 posts it/);
    comment(run);
    process.env.STUB_VOTE = '2001-01-01T00:00:00Z';
    assert.deepEqual(approval(run), { decision: 'waiting' }, 'a vote from before the post is not for the posted spec');
    process.env.STUB_VOTE = '1';
    const posted = getRun(run).events.at(-1);
    assert.deepEqual([posted.stage, posted.status, posted.spec, posted.reasons, posted.postedSha.length], ['spec', 'awaiting-approval', 'one line', ['x'], 64]);
    assert.equal(getRun(run).outcome, 'awaiting-approval');
    assert.deepEqual(approval(run), { decision: 'approve', by: 'boss' });
    spec('# Goal\n\nB, not what was approved\n');
    assert.throws(() => approval(run), /acme\/it#45's spec\.md changed after it was posted: post it again \(F comment acme\/it#45\)/);
    comment(run);
    assert.equal(approval(run).decision, 'approve');
  } finally { delete process.env.STUB_VOTE; }
  assert.match(F('{}', 'event', run, 'spec', 'awaiting-approval', '{"spec":"s","postedSha":"x"}').stderr, /not from a payload: postedSha/);
});
