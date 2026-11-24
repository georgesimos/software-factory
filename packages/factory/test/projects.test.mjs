// @ts-nocheck
// Projects not on GitHub (docs/plans/local-first.md §1.1, §2.3): the id a clone gets, the refusal of an id clash on attach,
// no gh call for a git project, and nothing of one on the published page.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { io, record } from '../../core/src/log.ts';
import { cloneId, hostFor, normRemote, withoutUserinfo } from '../../core/src/remote.ts';
import { clash, sync } from '../../core/src/sync.ts';
import { projects, projectsFile, worktree } from '../../core/src/workspace.ts';
import { approval, facts, intake, merge, openPRs, postmerge, relabelMerged, revert } from '../../core/src/github.ts';
import { artifact, page, residue } from '../../server/src/server.ts';

setup();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-projects-'));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const clone = (rel, origin) => { // a real repo with one commit on main
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git(d, 'remote', 'add', 'origin', origin);
  return d;
};
// a gh that logs every call and fails, so a call nobody catches still shows in the log
const ghLog = path.join(root, 'gh.log'), ghStub = path.join(root, 'gh-log.mjs');
fs.writeFileSync(ghStub, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(1);\n`);
const ghCalls = () => { try { return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const dataOf = (html) => JSON.parse(html.match(/<script type="application\/json" id="data">([^<]*)<\/script>/)[1]);

test('remote ids: one repo in any URL form is one remote; GitHub ids unchanged; credentials never kept', () => {
  for (const u of ['git@github.com:Acme/Shop.git', 'https://github.com/acme/shop', 'ssh://git@github.com/acme/shop.git/']) assert.equal(normRemote(u), 'github.com/acme/shop', u);
  assert.equal(cloneId('git@github.com:Acme/Shop.git', '/x'), 'Acme/Shop'); // byte-identical to what discover() always gave
  assert.equal(cloneId('https://gitlab.com/grp/sub/thing.git', '/x'), 'grp-sub/thing');
  assert.equal(cloneId('', path.join(root, 'My Notes')), 'local/My-Notes');
  for (const u of ['', '/srv/git/app.git', 'file:///srv/app', 'C:\\repos\\app', '../bare']) assert.equal(normRemote(u), null, u);
  assert.deepEqual(['git@github.com:a/b', 'git@gitlab.com:a/b', ''].map((u) => hostFor(u, cloneId(u, '/x/y'))), ['github', 'git', 'git']);
  assert.equal(hostFor('/srv/bare.git', 'acme/app'), 'github'); // an owner/repo attached with a local-path origin stays GitHub, as before
  assert.equal(withoutUserinfo('https://pat:s3cret@git.example.com/a/b.git'), 'https://git.example.com/a/b.git');
  assert.equal(withoutUserinfo('https://ghp_token@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(withoutUserinfo('ssh://git:pw@host/a/b'), 'ssh://git@host/a/b'); // ssh keeps the login it needs
  assert.equal(withoutUserinfo('git@gitlab.com:a/b.git'), 'git@gitlab.com:a/b.git');
});

test('attach refuses an id that is already another repository; a second clone of one repo is fine', () => {
  const gh = io.gh; io.gh = ghStub;
  try {
    const a = clone('a/notes'), b = clone('b/notes');
    sync('local/notes', a);
    assert.deepEqual([projects()['local/notes'].host, projects()['local/notes'].remote], ['git', undefined]);
    sync('local/notes', a); sync('local/notes'); // re-syncs: same folder
    assert.throws(() => sync('local/notes', b), /local\/notes is already attached to another folder.*attach it under another id/);
    assert.equal(projects()['local/notes'].path, a, 'the refused attach changed nothing');
    const g = clone('g/thing', 'https://pat:s3cret@gitlab.com/acme/thing.git');
    sync('acme/thing', g);
    assert.deepEqual([projects()['acme/thing'].host, projects()['acme/thing'].remote], ['git', 'https://gitlab.com/acme/thing.git']);
    assert.ok(!fs.readFileSync(projectsFile(), 'utf8').includes('s3cret'));
    const g2 = clone('g2/thing', 'git@gitlab.com:acme/thing.git'); // the same repo over ssh
    sync('acme/thing', g2);
    assert.equal(projects()['acme/thing'].remote, 'https://gitlab.com/acme/thing.git', 'host and remote stay as first attached');
    assert.throws(() => sync('acme/thing', clone('h/thing', 'git@gitlab.com:other/thing.git')), /already attached to gitlab\.com\/acme\/thing/);
    assert.throws(() => sync('acme/thing', clone('n/thing')), /already attached to gitlab\.com\/acme\/thing/);
    // a legacy GitHub entry (no host, no remote) is github.com/<id>
    const legacy = { path: path.join(root, 'old') };
    assert.equal(clash('acme/shop', legacy, 'https://github.com/acme/shop.git', '/elsewhere'), null);
    assert.equal(clash('acme/shop', legacy, 'git@github.com:ACME/shop', '/elsewhere'), null);
    assert.equal(clash('acme/shop', legacy, '/srv/mirror.git', '/elsewhere'), null); // a local-path origin, as the CLI tests use
    assert.equal(clash('acme/shop', legacy, 'git@gitlab.com:acme/shop.git', '/elsewhere'), 'github.com/acme/shop');
    assert.equal(clash('acme/shop', {}, 'git@gitlab.com:acme/shop.git', '/elsewhere'), null, 'never attached: an auto-merge setting alone');
    assert.deepEqual(ghCalls(), [], 'no gh call for a git project');
  } finally { io.gh = gh; }
});

test('a git project never calls gh: every GitHub path refuses by name, and its worktree starts from the local main', () => {
  const gh = io.gh; io.gh = ghStub;
  try {
    const run = 'local/notes#1';
    record(run, 'intake', 'started', { title: 'a local item' });
    for (const [name, f] of [['intake', () => intake(run)], ['openPRs', () => openPRs('local/notes')], ['facts', () => facts({ id: run, events: [] })],
      ['merge', () => merge(run)], ['relabelMerged', () => relabelMerged(run)], ['approval', () => approval(run)], ['postmerge', () => postmerge(run)], ['revert', () => revert(run, 'red')]])
      assert.throws(f, /local\/notes is a git project, not on GitHub: .* works only for GitHub projects/, name);
    const w = worktree(run);
    assert.deepEqual([w.base, w.branch], ['main', 'factory/issue-1']);
    assert.equal(git(w.path, 'rev-parse', 'HEAD'), git(projects()['local/notes'].path, 'rev-parse', 'main'));
    assert.deepEqual(ghCalls(), []);
    // the stub does log: a GitHub project's call shows up
    assert.throws(() => openPRs('acme/app'));
    assert.equal(ghCalls().length, 1);
  } finally { io.gh = gh; }
});

test('the published page leaves out every project not on GitHub; the backstop refuses one left in', () => {
  record('acme/thing#2', 'intake', 'started', { title: 'a private host item' });
  record('acme/app#3', 'intake', 'started', { title: 'a github item' });
  const pub = artifact(), d = dataOf(pub);
  for (const leak of ['local/notes', 'acme/thing', 'a local item', 'a private host item', 'gitlab', path.basename(root)]) assert.ok(!pub.includes(leak), leak);
  assert.deepEqual(d.runs.map((r) => r.id), ['acme/app#3']);
  assert.equal(d.metrics.all.runs, 1, 'no total counts a private project');
  assert.ok(!('local/notes' in d.metrics.byProject) && !d.projects.includes('acme/thing'));
  // dropPrivate alone (a page not built for publishing still has them): nothing private is left
  const full = page({}, { sheet: true });
  assert.ok(full.includes('local/notes'));
  assert.ok(!artifact(full).includes('local/notes'));
  // the backstop alone: an id left in prose refuses the page
  assert.throws(() => artifact(page({ note: 'see local/notes#1' })), /still carries a project that is not on GitHub/);
  assert.deepEqual(residue(JSON.stringify({ runs: [{ id: 'acme/thing#2' }] }), { runs: [] }, { user: 'nobody-x', host: 'h', home: '/nowhere', projects: projects() }), ['a project that is not on GitHub']);
  assert.deepEqual(residue(JSON.stringify({ x: 'local/notesy and acme/things' }), { runs: [] }, { user: 'nobody-x', host: 'h', home: '/nowhere', projects: projects() }), []); // whole ids only
});
