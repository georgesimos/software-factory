// @ts-nocheck
// Projects not on GitHub (docs/plans/local-first.md §1.1, §2.3): the id a clone gets, the refusal of an id clash on attach,
// no gh call for a git project, and nothing of one on the published page.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { passSpec, setup } from './setup.mjs';
import { io, record } from '../../core/src/log.ts';
import { cloneId, hostFor, normRemote, withoutUserinfo } from '../../core/src/remote.ts';
import { clash, discover, sync } from '../../core/src/sync.ts';
import { hostOf, projects, projectsFile, worktree } from '../../core/src/workspace.ts';
import { approval, facts, intake, merge, openPRs, postmerge, relabelMerged, revert } from '../../core/src/github.ts';
import { artifact, page, residue, runsData } from '../../server/src/server.ts';

setup();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-projects-'));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const clone = (rel, origin, branch = 'main') => { // a real repo with one commit
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', branch);
  git(d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) { git(d, 'remote', 'add', 'origin', origin); git(d, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD'); } // as if fetched
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
  assert.equal(withoutUserinfo('https://pat:p@ss@gitlab.com/a/b.git'), 'https://gitlab.com/a/b.git'); // a password holding @: all of it goes
  assert.equal(withoutUserinfo('ssh://git:p@w@host:2222/a/b'), 'ssh://git@host:2222/a/b');
  assert.equal(normRemote('https://pat:p@ss@gitlab.com/a/b.git'), 'gitlab.com/a/b');
  // one GitHub host test, for hostFor() and discover(): github.com, www.github.com and ssh.github.com, on any port
  for (const u of ['ssh://git@ssh.github.com:443/acme/shop.git', 'https://www.github.com/acme/shop', 'ssh://git@github.com:22/acme/shop.git']) {
    assert.deepEqual([hostFor(u, 'acme/shop'), normRemote(u), cloneId(u, '/x')], ['github', 'github.com/acme/shop', 'acme/shop'], u);
  }
  assert.equal(hostFor('https://notgithub.com/acme/shop', 'acme/shop'), 'git');
  assert.equal(hostFor('git@github.com:acme/notes.git', 'local/notes'), 'git', 'a local/ id is never GitHub');
});

test('attach refuses an id that is already another repository; a second clone of one repo is fine', () => {
  const gh = io.gh; io.gh = ghStub;
  try {
    const a = clone('a/notes'), b = clone('b/notes');
    sync('local/notes', a);
    assert.deepEqual([projects()['local/notes'].host, projects()['local/notes'].remote], ['git', undefined]);
    sync('local/notes', a); sync('local/notes'); // re-syncs: same folder
    assert.throws(() => sync('local/notes', b), /local\/notes is already attached to another folder.*attach it under another id \(F sync local\/<name> /);
    assert.equal(projects()['local/notes'].path, a, 'the refused attach changed nothing');
    sync('local/notes-b', b); // what the refusal says: still a git project
    assert.equal(projects()['local/notes-b'].host, 'git');
    const seen = discover([root]).filter((f) => f.path === a || f.path === b).map((f) => [f.repo, f.attached]).sort();
    assert.deepEqual(seen, [['local/notes', true], ['local/notes-b', true]], 'discover shows each folder under the id it was attached as');
    git(a, 'remote', 'add', 'origin', 'git@gitlab.com:me/notes.git'); // its own folder, now with an origin: not a clash
    git(a, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    sync('local/notes', a);
    assert.deepEqual([projects()['local/notes'].host, projects()['local/notes'].remote], ['git', undefined], 'host and remote stay as first attached');
    git(a, 'remote', 'remove', 'origin');
    assert.throws(() => sync('local/trunk', clone('t/trunk', '', 'trunk')), /cannot tell the base branch .*no main or master branch$/);
    assert.equal(projects()['local/trunk'], undefined, 'a clone with no base branch is not attached');
    // an origin with nothing fetched yet attaches on the local main, and says to fetch; its worktree still needs origin's
    const e = clone('e/empty', 'git@gitlab.com:acme/empty.git');
    git(e, 'update-ref', '-d', 'refs/remotes/origin/main');
    assert.equal(sync('acme/empty', e).note, 'nothing is fetched from origin yet, so acme/empty is attached on its local main; run git fetch origin before its first run');
    passSpec('acme/empty#1'); // a git project's run builds only after its spec passed (5b)
    assert.throws(() => worktree('acme/empty#1'), /no main or master branch on origin, and no origin\/HEAD \(git fetch origin/);
    const o = clone('e/fetched', 'git@gitlab.com:acme/fetched.git'); // fetched, but no main or master on origin: refused, not guessed
    git(o, 'update-ref', '-d', 'refs/remotes/origin/main'); git(o, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
    assert.throws(() => sync('acme/fetched', o), /no main or master branch on origin/);
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
    // local-first 5a: the change requests and facts come from git; the local tracker (5b) has no trust() to read, so it escalates
    assert.deepEqual(openPRs('local/notes'), { base: 'main', open: [], doneBranches: ['main'] });
    assert.deepEqual([facts({ id: run, events: [] }).host, facts({ id: run, events: [] }).trustBroken], ['git', 'tracker "local" cannot tell who wrote an item, so local/notes#1\'s author is unknown and not trusted']);
    assert.throws(() => intake(run), /no item 1 in \.factory\/issues: write one with F item new/, 'intake reads the local tracker (5b), never gh');
    assert.throws(() => approval(run), /local\/notes#1 is not awaiting approval/, 'approval reads F approve\'s record, never gh');
    for (const [name, f] of [['relabelMerged', () => relabelMerged(run)], ['revert', () => revert(run, 'red')]])
      assert.throws(f, /local\/notes is a git project, not on GitHub: .* works only for GitHub projects/, name);
    assert.deepEqual([merge(run).action, postmerge(run).state], ['escalate', 'not-merged'], 'PR 7: a git project merges through its host, never gh');
    passSpec(run);
    const w = worktree(run);
    assert.deepEqual([w.base, w.branch], ['main', 'factory/issue-1']);
    assert.equal(git(w.path, 'rev-parse', 'HEAD'), git(projects()['local/notes'].path, 'rev-parse', 'main'));
    assert.deepEqual(ghCalls(), []);
    // the stub does log: a GitHub project's call shows up
    assert.throws(() => openPRs('acme/app'));
    assert.equal(ghCalls().length, 1);
  } finally { io.gh = gh; }
});

test('review: a resume keeps a git project\'s commits; discover never renames an attached id; a moved folder re-points; worktree attaches like sync', () => {
  const gh = io.gh; io.gh = ghStub;
  fs.rmSync(ghLog, { force: true }); // the call the test above made on purpose
  try {
    // a git project with an origin it can fetch from (a bare repo), where nothing pushes factory/issue-N
    const bare = path.join(root, 'rt.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const c = clone('rt/app', bare);
    git(c, 'push', '-q', 'origin', 'main');
    sync('local/rt', c);
    passSpec('local/rt#5');
    const w = worktree('local/rt#5');
    git(w.path, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'run work');
    const work = git(w.path, 'rev-parse', 'HEAD');
    git(c, 'worktree', 'remove', '--force', w.path);
    assert.equal(git(worktree('local/rt#5').path, 'rev-parse', 'HEAD'), work, 'the resumed worktree starts from the local branch');
    assert.equal(git(c, 'rev-parse', 'factory/issue-5'), work);
    // an attached GitLab acme/shop keeps its id next to a GitHub acme/shop clone
    const gl = clone('d/shop-gitlab', 'git@gitlab.com:acme/shop.git');
    clone('d/shop-github', 'git@github.com:acme/shop.git');
    sync('acme/shop', gl);
    const rows = discover([path.join(root, 'd')]).map((f) => [f.repo, f.attached, f.host ?? 'github']).sort((x, y) => x[2].localeCompare(y[2]));
    assert.deepEqual(rows, [['acme/shop', true, 'git'], ['acme/shop', false, 'github']]);
    // a no-remote project whose folder moved is re-pointed, its runs kept
    const m1 = clone('m1/moved');
    sync('local/moved', m1);
    record('local/moved#1', 'intake', 'started', { title: 'before the move' });
    const m2 = path.join(root, 'm2-moved');
    fs.renameSync(m1, m2);
    sync('local/moved', m2);
    assert.deepEqual([projects()['local/moved'].path, projects()['local/moved'].host], [m2, 'git']);
    assert.ok(runsData().some((r) => r.id === 'local/moved#1'));
    // worktree with a path: an unattached local/ project is attached as git, with no gh call; another folder is a clash
    const x = clone('x/wt');
    passSpec('local/wt#1'); passSpec('local/wt#2');
    worktree('local/wt#1', x);
    assert.equal(projects()['local/wt'].host, 'git');
    assert.equal(hostOf('local/never-attached'), 'git');
    assert.throws(() => worktree('local/wt#2', clone('y/wt')), /local\/wt is already attached to another folder/);
    assert.deepEqual(ghCalls(), [], 'no gh call');
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
  for (const note of ['mirrored at https://gitlab.com/acme/thing', 'git@GitLab.com:acme/thing.git', 'ssh://gitlab.com:2222/acme/thing.git', 'gitlab.com:8443/acme/thing']) assert.throws(() => artifact(page({ note })), /a remote that is not on GitHub/, note);
  assert.deepEqual(residue(JSON.stringify({ runs: [{ id: 'acme/thing#2' }] }), { runs: [] }, { user: 'nobody-x', host: 'h', home: '/nowhere', projects: projects() }), ['a project that is not on GitHub']);
  assert.deepEqual(residue(JSON.stringify({ x: 'local/notesy and acme/things' }), { runs: [] }, { user: 'nobody-x', host: 'h', home: '/nowhere', projects: projects() }), []); // whole ids only
});
