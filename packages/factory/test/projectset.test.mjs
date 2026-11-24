// @ts-nocheck
// F project set (docs/plans/local-first.md §2.2 step 4) and the host seam (§1.2): who may change a project's host, CI or base,
// and that whoami and the base branch come from the project's host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from './setup.mjs';
import { HERE } from '../factory.mjs';
import { io, read } from '../../core/src/log.ts';
import { humanOnly, setProject } from '../../core/src/projectset.ts';
import { setRule, whoami } from '../../core/src/rules.ts';
import { builtin, load } from '../../adapters/hosts/index.ts';
import { sync } from '../../core/src/sync.ts';
import { baseBranch, projects, projectsFile } from '../../core/src/workspace.ts';
import { UI_ROUTES, artifact } from '../../server/src/server.ts';

setup();
const STUB = path.join(HERE, 'test', 'gh-stub.mjs'), NO_GH = path.join(HERE, 'test', 'no-such-gh');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-pset-'));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const clone = (rel, origin) => {
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init', '-q', '-b', 'main');
  git(d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) { git(d, 'remote', 'add', 'origin', origin); git(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); } // as if fetched
  return d;
};
const ghLog = path.join(root, 'gh.log'), ghStub = path.join(root, 'gh-log.mjs'); // logs each call, then answers as the shared stub would for a login
fs.writeFileSync(ghStub, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(ghLog)}, process.argv.slice(2).join(' ') + '\\n');\nif (process.argv.slice(2).join(' ') === 'api user --jq .login') process.stdout.write('stub-user\\n'); else process.exit(1);\n`);
const badLogin = path.join(root, 'gh-bad.mjs'); // a gh that answers with something that is no GitHub login
fs.writeFileSync(badLogin, `process.stdout.write('not a login!\\n');\n`);
const ghCalls = () => { try { return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const lastRule = () => read().filter((e) => e.stage === 'rules').at(-1);
const me = os.userInfo().username;

test('F project set is yours only: refused inside an agent session, not attached, unknown key; no page or HTTP route', () => {
  for (const [k, v] of [['FACTORY_CLAIM', 'tok'], ['CLAUDECODE', '1'], ['CLAUDE_CODE_SESSION_ID', 's-1']]) {
    process.env[k] = v;
    try { assert.throws(() => setProject('acme/none', 'ci', 'none', { reason: 'x' }), /must come from you, not from an agent session/, k); }
    finally { delete process.env[k]; }
  }
  assert.doesNotThrow(() => humanOnly('x'));
  assert.throws(() => setProject('acme/none', 'ci', 'none'), /acme\/none is not attached; run sync first/);
  assert.ok(!Object.keys(UI_ROUTES).some((r) => /project/.test(r)), 'the page cannot change a project\'s providers');
});

test('a GitHub project: relaxing needs a reason and a verified login; github -> git stops every gh call and leaves the page', () => {
  const gh = io.gh;
  try {
    io.gh = STUB;
    const c = clone('gp', 'https://pat:s3cret@github.com/acme/gp.git');
    sync('acme/gp', c);
    assert.throws(() => setProject('acme/gp', 'host', 'git'), /host github -> git relaxes what the factory checks: say why with --reason/);
    assert.throws(() => setProject('acme/gp', 'base', 'main'), /acme\/gp is on GitHub: its base is the repo's default branch/);
    assert.throws(() => setProject('acme/gp', 'host', 'gitlab'), /host must be github\|git: "gitlab" can't host an attached project/);
    assert.throws(() => setProject('acme/gp', 'host', 'constructor'), /host must be/);
    // an unverified local login can't relax a GitHub project, whatever the reason
    io.gh = NO_GH;
    assert.throws(() => setProject('acme/gp', 'host', 'git', { reason: 'offline' }), /relaxes a GitHub project, which needs a verified login \(gh auth login\), not a local user; or attach the clone under a local\/<name> id/);
    assert.throws(() => setProject('acme/gp', 'ci', 'none', { reason: 'no CI' }), /verified login/);
    assert.equal(projects()['acme/gp'].host, undefined, 'nothing changed');
    // a verified login may, with a reason; audited like a rule
    io.gh = STUB;
    assert.throws(() => setProject('acme/gp', 'ci', 'local'), /ci github-actions -> local relaxes/);
    assert.deepEqual(setProject('acme/gp', 'host', 'git', { reason: 'moving off GitHub' }), { repo: 'acme/gp', key: 'host', from: 'github', to: 'git', by: 'stub-user', via: 'github', note: 'ci is none (the git default)' });
    assert.deepEqual([projects()['acme/gp'].host, projects()['acme/gp'].remote], ['git', 'https://github.com/acme/gp.git']);
    const e = lastRule();
    assert.deepEqual([e.run, e.status, e.key, e.from, e.value, e.reason, e.setBy, e.via], ['acme/gp', 'set', 'project.host', 'github', 'git', 'moving off GitHub', 'stub-user', undefined]);
    // now a git project: no gh call about it, nothing of it on the published page
    io.gh = ghStub;
    sync('acme/gp');
    assert.ok(!artifact().includes('acme/gp'));
    assert.deepEqual(ghCalls(), []);
    // a git project's base must be on origin when the clone has one; back to github clears it
    git(c, 'branch', 'dev');
    assert.throws(() => setProject('acme/gp', 'base', 'dev'), /base branch dev is not on origin in .*push it, then git fetch origin/);
    git(c, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
    setProject('acme/gp', 'base', 'dev');
    assert.equal(baseBranch('acme/gp', c), 'dev');
    // the only gh call is who is acting: a verified login counts on a git project too
    assert.deepEqual(ghCalls(), ['api user --jq .login']);
    // back to github is stricter: no reason needed, but the clone must be that GitHub repo
    assert.equal(setProject('acme/gp', 'host', 'github').note, "base dev cleared: GitHub's base is the repo's default branch; ci is github-actions (the github default)");
    assert.deepEqual([projects()['acme/gp'].host, projects()['acme/gp'].remote, projects()['acme/gp'].base], ['github', undefined, undefined]);
    assert.deepEqual([lastRule().key, lastRule().cleared], ['project.host', { base: 'dev' }]);
    sync('acme/gx', clone('gx', 'git@gitlab.com:acme/gx.git'));
    assert.throws(() => setProject('acme/gx', 'host', 'github'), /host github needs acme\/gx's clone to have the GitHub origin acme\/gx/);
  } finally { io.gh = gh; }
});

test('a git project: a local login may change it, a relaxing change still needs a reason; base is checked against the clone', () => {
  const gh = io.gh; io.gh = NO_GH;
  try {
    const c = clone('lx');
    sync('local/lx', c);
    assert.throws(() => setProject('local/lx', 'host', 'github'), /local\/lx is a local\/ id, which is never on GitHub/);
    assert.equal(setProject('local/lx', 'ci', 'local').via, 'local'); // stricter than none
    assert.throws(() => setProject('local/lx', 'ci', 'none'), /ci local -> none relaxes/);
    setProject('local/lx', 'ci', 'none', { reason: 'no checks yet' });
    assert.deepEqual([lastRule().setBy, lastRule().via], [me, 'local']); // shown as "(local, unverified)", scrubbed on publish
    assert.throws(() => setProject('local/lx', 'ci', 'jenkins'), /ci must be none\|local\|github-actions/);
    // base: a real branch of the clone, used by the host's baseBranch
    assert.throws(() => setProject('local/lx', 'base', 'a..b'), /"a\.\.b" is not a branch name/);
    assert.throws(() => setProject('local/lx', 'base', 'dev'), /base branch dev is not a branch in/);
    assert.equal(projects()['local/lx'].base, undefined);
    git(c, 'branch', 'dev'); git(c, 'tag', 'v1');
    git(c, 'checkout', '-q', 'dev'); git(c, 'checkout', '-q', 'main'); // @{-1} is dev now
    const sha = git(c, 'rev-parse', 'HEAD').trim();
    for (const bad of ['v1', sha, '@{-1}']) assert.throws(() => setProject('local/lx', 'base', bad), /is not a branch|is not a branch name/, bad);
    setProject('local/lx', 'base', 'dev');
    assert.equal(baseBranch('local/lx', c), 'dev');
    // --unset: the host's own base again, audited
    assert.equal(setProject('local/lx', 'base', null).from, 'dev');
    assert.deepEqual([projects()['local/lx'].base, lastRule().status, lastRule().key, lastRule().value], [undefined, 'unset', 'project.base', undefined]);
    assert.equal(baseBranch('local/lx', c), 'main');
    assert.throws(() => setProject('local/lx', 'base', null), /local\/lx has no base set/);
    assert.throws(() => setProject('local/lx', 'ci', null), /only base can be unset/);
    // an unknown stored ci counts as the strictest: any change from it relaxes
    fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), 'local/lx': { ...projects()['local/lx'], ci: 'jenkins' } }));
    assert.throws(() => setProject('local/lx', 'ci', 'github-actions'), /ci jenkins -> github-actions relaxes/);
  } finally { io.gh = gh; }
});

test('whoami: a verified login counts on every project, whatever its host; the OS user alone still can\'t loosen its rules', () => {
  const gh = io.gh;
  try {
    io.gh = STUB; // gh logged in: verified, on a local/ (git) project too
    assert.deepEqual(whoami('x'), { by: 'stub-user', via: 'github' });
    assert.equal(setRule('local/lx', 'ci', 'required', { reason: 'mine' }).policy.ci.setBy, 'stub-user');
    io.gh = NO_GH; // no gh: the OS user, who can't loosen what a verified login set there
    assert.throws(() => setRule('local/lx', 'ci', 'skip', { reason: 'looser' }), /set by stub-user \(GitHub\): changing it needs that verified login/);
    io.gh = STUB; // the verified login can, on its own rule, even on a git project
    assert.equal(setRule('local/lx', 'ci', 'skip', { reason: 'mine to loosen' }).policy.ci.value, 'skip');
    io.gh = badLogin; // gh answers with no GitHub login: the OS user, as before
    assert.deepEqual(whoami('x', { user: () => 'pat' }), { by: 'pat', via: 'local' });
    io.gh = NO_GH;
    assert.throws(() => whoami('x', { user: () => { throw new Error('no passwd entry'); } }), /cannot tell who is x: no verified gh login, and there is no OS user name/);
  } finally { io.gh = gh; }
});

test('core\'s hosts are imported by name: a bad host file fails only the host picker that loads it', async () => {
  assert.deepEqual(Object.keys(builtin), ['github', 'git']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-badhost-'));
  fs.writeFileSync(path.join(dir, 'broken.mjs'), 'export const id = "broken"; this is not javascript\n');
  await assert.rejects(load(dir), /broken\.mjs/);
});
