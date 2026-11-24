// @ts-nocheck
// Local identity (#52, docs/plans/local-first.md PR 1): with no gh login, rules and notes save as the OS user (via 'local'),
// shown as unverified, never able to relax CI or replace a verified rule, and never published.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HERE } from '../factory.mjs';
import { derive } from '../../core/src/derive.ts';
import { io, read, record } from '../../core/src/log.ts';
import { checkRules, rules, setRule, unsetRule, whoami, audit } from '../../core/src/rules.ts';
import { readSkills, writeSkills } from '../../core/src/skills.ts';
import { note } from '../../core/src/notes.ts';
import { decide } from '../../core/src/gate.ts';
import { artifact, page } from '../../server/src/server.ts';
import { setup } from './setup.mjs';

setup();
const STUB = path.join(HERE, 'test', 'gh-stub.mjs'), NO_GH = path.join(HERE, 'test', 'no-such-gh');
const me = os.userInfo().username;

test('whoami: the gh login when there is one, else the OS user as local; DOMAIN\\user is a name', () => {
  io.gh = STUB;
  assert.deepEqual(whoami('x', { user: () => 'ignored' }), { by: 'stub-user', via: 'github' });
  io.gh = NO_GH;
  assert.deepEqual(whoami('x', { user: () => 'DOMAIN\\pat' }), { by: 'DOMAIN\\pat', via: 'local' });
  assert.deepEqual(whoami('x', { user: () => ' pat ' }), { by: 'pat', via: 'local' });
  assert.throws(() => whoami('changing the rule', { user: () => { throw new Error('no passwd entry'); } }), /cannot tell who is changing the rule/);
  assert.throws(() => whoami('x', { user: () => '' }), /there is no OS user name/);
  assert.throws(() => whoami('x', { user: () => 'a\nb' }), /there is no OS user name/);
});

test('rules: old rules (no via) load unchanged; a local setBy is any short name; via is github or local', () => {
  const at = '2026-01-01T00:00:00Z', r = (x) => ({ ci: { value: 'skip', reason: 'x', setAt: at, ...x } });
  checkRules(r({ setBy: 'acme' }), 'rules'); // every rule written before via existed
  checkRules(r({ setBy: 'acme', via: 'github' }), 'rules');
  checkRules(r({ setBy: 'DOMAIN\\pat', via: 'local' }), 'rules');
  checkRules(r({ setBy: 'pat@example.test', via: 'local' }), 'rules');
  assert.throws(() => checkRules(r({ setBy: 'DOMAIN\\pat' }), 'rules'), /setBy must be a GitHub login/); // no via: still a GitHub login
  assert.throws(() => checkRules(r({ setBy: 'DOMAIN\\pat', via: 'github' }), 'rules'), /setBy must be a GitHub login/);
  assert.throws(() => checkRules(r({ setBy: 'a\u0007b', via: 'local' }), 'rules'), /setBy must be a user name/);
  assert.throws(() => checkRules(r({ setBy: 'x'.repeat(101), via: 'local' }), 'rules'), /setBy must be a user name/);
  assert.throws(() => checkRules(r({ setBy: 'acme', via: 'bitbucket' }), 'rules'), /via must be github or local/);
});

test('rules and notes save without gh, as the local user; a local user cannot replace or remove a verified rule', () => {
  io.gh = NO_GH;
  const local = setRule('acme/id', 'ci', 'skip', { reason: 'no CI here' }).policy.ci;
  assert.deepEqual([local.setBy, local.via], [me, 'local']);
  assert.deepEqual(readSkills()['acme/id'].rules.ci.via, 'local');
  const ev = read().filter((e) => e.stage === 'rules').at(-1);
  assert.deepEqual([ev.setBy, ev.via], [me, 'local']);
  unsetRule('acme/id', 'ci', { reason: 'mine to remove' }); // its own rule: fine
  io.gh = STUB;
  const gh = setRule('acme/id', 'diffCap', '100', { reason: 'small PRs' }).policy.diffCap;
  assert.deepEqual([gh.setBy, gh.via], ['stub-user', undefined]); // a GitHub login is stored as before: no via
  assert.equal(read().filter((e) => e.stage === 'rules').at(-1).via, undefined);
  io.gh = NO_GH;
  assert.throws(() => setRule('acme/id', 'diffCap', '400', { reason: 'looser' }), /set by stub-user \(GitHub\): changing it needs that verified login/);
  assert.throws(() => unsetRule('acme/id', 'diffCap', { reason: 'gone' }), /needs that verified login/);
  assert.equal(rules('acme/id').policy.diffCap.value, 100);
  // A note, too: saved as the local user.
  record('acme/id#1', 'intake', 'passed');
  const n = note('acme/id#1', 'next', 'keep it small');
  assert.deepEqual([n.by, n.via], [me, 'local']);
  assert.deepEqual(derive(read())['acme/id#1'].notes.map((x) => [x.by, x.via]), [[me, 'local']]);
  io.gh = STUB;
});

test('decide: a local rule that relaxes CI is shown as unverified and escalates; the same rule from GitHub merges', () => {
  const ok = { association: 'OWNER', iteration: 1, pr: 'x', reviewedSha: 's1', axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'passed' } } },
    localChecks: { state: 'pass', sha: 's1', commands: [{ cmd: 'pnpm test', exit: 0, ms: 1 }] } };
  const rule = (value, via) => ({ value, reason: 'no CI', setBy: via ? 'DOMAIN\\pat' : 'acme', setAt: '2026-11-20T10:00:00Z', ...(via && { via }) });
  const D = (ci, cmds) => decide(ok, { checks: 'skipped', additions: 10, deletions: 0, files: ['src/a.ts', 'src/a.test.ts'], rules: { ci, 'checks.commands': cmds } });
  assert.equal(D(rule('skip'), rule(['pnpm test'])).action, 'merge');
  for (const [ci, cmds, k] of [[rule('skip', 'local'), rule(['pnpm test']), 'ci=skip'], [rule('advisory', 'local'), rule(['pnpm test']), 'ci=advisory'], [rule('skip'), rule(['pnpm test'], 'local'), 'checks.commands']]) {
    const d = D(ci, cmds);
    assert.equal(d.action, 'escalate', k);
    assert.ok(d.reasons.some((x) => x.startsWith(`rule ${k} was set by DOMAIN\\pat (local, unverified): a rule that relaxes CI needs a verified login`)), d.reasons.join(' | '));
  }
  // Tightening applies whoever set it: a local checks.commands while CI is still required adds a check, it relaxes nothing.
  assert.equal(decide(ok, { checks: 'pass', additions: 10, deletions: 0, files: ['src/a.ts', 'src/a.test.ts'], rules: { 'checks.commands': rule(['pnpm test'], 'local') } }).action, 'merge');
});

test('privacy: a local user name (DOMAIN\\user) never reaches the published page', () => {
  const prev = io.dir;
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-id-'));
  io.gh = STUB;
  try {
    const who = 'DOMAIN\\pat-private', at = '2026-11-20T10:00:00Z';
    writeSkills({ ...readSkills(), 'acme/pv': { rules: { ci: { value: 'skip', reason: 'no CI here', setBy: who, via: 'local', setAt: at } } } });
    audit('acme/pv', 'set', { key: 'ci', value: 'skip', reason: 'no CI here', setBy: who, via: 'local' });
    record('acme/pv#2', 'intake', 'passed');
    record('acme/pv#2', 'approve', 'decided', { action: 'escalate', reasons: [`rule ci=skip was set by ${who} (local, unverified): a rule that relaxes CI needs a verified login`] });
    const pub = artifact(page());
    assert.ok(!/pat-private/.test(pub), 'the local name is scrubbed everywhere');
    assert.match(pub, /set by a local user \(local, unverified\)/);
  } finally { io.dir = prev; }
});
