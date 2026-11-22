// Shared contract test: runs against every registered connector, each with its own fixture (test/fixtures/<id>.json).
// It also drops a fake second provider into a temp dir as one file, to prove a new provider needs no core change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { load, BUILTIN } from '../connectors/index.mjs';
import { KINDS, validateConnector, normalizeRows } from '../contract.mjs';
import { lookup, track } from '../ship.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-test-'));
const extra = path.join(tmp, 'connectors'), fixtures = [path.join(HERE, 'fixtures'), path.join(tmp, 'fixtures')];
fs.mkdirSync(extra); fs.mkdirSync(fixtures[1]);
process.env.FACTORY_DIR = path.join(tmp, 'factory'); // before factory.mjs loads: never the real log
delete process.env.CLAUDE_CODE_SESSION_ID;

const SHA = 'f'.repeat(40);
// The whole "new provider": one file, plus its fixture. Nothing else in the repo is touched.
fs.writeFileSync(path.join(extra, 'fake-host.mjs'), `export default {
  id: 'fake-host', kind: 'web-deploy',
  detect: (project, ctx) => JSON.parse(ctx.exec('fakehost', ['projects'])).includes(project.repo),
  auth: (ctx) => ({ ok: true, how: 'fakehost login' }),
  status: (project, sha, ctx) => JSON.parse(ctx.exec('fakehost', ['ls', project.repo, sha || 'latest'])).map((d) => ({ env: d.target, state: d.s, url: d.u, sha: d.sha, at: d.t })),
  actions: { logs: { tag: 'read', run: (project, ctx, id) => ctx.exec('fakehost', ['logs', id]) } },
};\n`);
fs.writeFileSync(path.join(extra, '_draft.mjs'), 'export default { id: "draft" };\n'); // "_" files are never loaded
fs.writeFileSync(path.join(extra, 'broken.mjs'), 'export default { id: "broken", kind: "web-deploy" };\n'); // breaks the contract: skipped
fs.writeFileSync(path.join(fixtures[1], 'fake-host.json'), JSON.stringify({
  project: { repo: 'acme/app' }, detect: true,
  exec: { 'fakehost projects': ['acme/app'], [`fakehost ls acme/app ${SHA}`]: [{ target: 'preview', s: 'ready', u: 'https://pr-1.fake.host', sha: SHA, t: '2026-11-22T10:00:00Z' }],
    'fakehost ls acme/app latest': [{ target: 'production', s: 'building', sha: SHA }] },
  cases: [{ sha: SHA, expect: [{ connector: 'fake-host', kind: 'web-deploy', env: 'preview', state: 'ready', url: 'https://pr-1.fake.host', sha: SHA, at: '2026-11-22T10:00:00.000Z' }] },
    { expect: [{ connector: 'fake-host', kind: 'web-deploy', env: 'production', state: 'building', sha: SHA }] }],
}));

// A fixture's exec: command line -> canned stdout. An unexpected call fails the test instead of reaching a real CLI.
const fakeExec = (fx) => (cmd, args) => {
  const k = [cmd, ...args].join(' ');
  if (!(k in fx.exec)) throw new Error(`unexpected call: ${k}`);
  return typeof fx.exec[k] === 'string' ? fx.exec[k] : JSON.stringify(fx.exec[k]);
};
const fixtureOf = (id) => {
  const f = fixtures.map((d) => path.join(d, `${id}.json`)).find((f) => fs.existsSync(f));
  assert.ok(f, `connector ${id} has no fixture (test/fixtures/${id}.json)`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};
const strip = (rows) => JSON.parse(JSON.stringify(rows)); // drop undefined fields, as the event log does

const { connectors, warnings } = await load([BUILTIN, extra]);

test('the registry auto-loads providers, skipping _ files and contract breakers', () => {
  assert.deepEqual(connectors.map((c) => c.id), ['github-deployments', 'fake-host']);
  assert.ok(!connectors.some((c) => c.id === 'draft'));
  assert.match(warnings.join(), /broken\.mjs: detect must be a function/);
  assert.equal((fs.readdirSync(BUILTIN).filter((f) => f.startsWith('_'))).length, 1); // _template.mjs ships, never loads
});

for (const c of connectors) {
  test(`contract: ${c.id}`, () => {
    const fx = fixtureOf(c.id), ctx = { exec: fakeExec(fx) };
    assert.deepEqual(validateConnector(c), []);
    assert.ok(KINDS[c.kind]);
    for (const [name, a] of Object.entries(c.actions)) assert.equal(a.tag, 'read', `${c.id}.${name}: phase 0 ships read actions only`);
    const auth = c.auth(ctx);
    assert.equal(typeof auth.ok, 'boolean');
    assert.equal(typeof auth.how, 'string');
    assert.equal(c.detect(fx.project, ctx), fx.detect);
    for (const k of fx.cases) {
      const rows = normalizeRows(c, c.status(fx.project, k.sha, ctx));
      assert.deepEqual(strip(rows), k.expect);
      for (const r of rows) {
        assert.ok(KINDS[c.kind].states.includes(r.state));
        assert.ok(r.url === undefined || r.url.startsWith('https://'));
        if (k.sha) assert.equal(r.sha, k.sha);
      }
    }
  });
}

test('contract violations are caught', () => {
  assert.match(validateConnector({ id: 'X', kind: 'cdn', detect() {}, auth() {}, status() {}, actions: { go: { tag: 'admin', run() {} } } }).join(), /id must be.*kind must be.*action go needs tag/);
  const c = { id: 'x', kind: 'web-deploy' };
  assert.throws(() => normalizeRows(c, [{ env: 'preview', state: 'finished' }]), /not a web-deploy state/);
  assert.throws(() => normalizeRows(c, [{ state: 'ready' }]), /needs an env/);
  const [r] = normalizeRows(c, [{ env: ' preview ', state: 'ready', url: 'javascript:alert(1)', sha: 'nothex', detail: 'x'.repeat(500), extra: 'dropped' }]);
  assert.deepEqual([r.env, r.url, r.sha, r.detail.length, 'extra' in r], ['preview', undefined, undefined, 200, false]);
});

test('a failing provider becomes an error entry, never a throw', () => {
  const { rows, errors } = lookup(connectors, { repo: 'acme/app' }, SHA, { exec: () => { const e = new Error('boom'); e.stderr = 'HTTP 502: bad gateway\nmore'; throw e; } });
  assert.deepEqual(rows, []);
  assert.deepEqual(errors.map((e) => [e.connector, e.error]), [['github-deployments', 'HTTP 502: bad gateway'], ['fake-host', 'HTTP 502: bad gateway']]);
});

test('track records through factory record(): typed fields, deduped, cached per sha; decide() gates on any web-deploy provider', async () => {
  const F = await import('../../factory/factory.mjs');
  const RUN = 'acme/app#1', fx = { exec: { ...fixtureOf('github-deployments').exec, ...fixtureOf('fake-host').exec } };
  for (const k of Object.keys(fx.exec)) if (k.includes(`deployments?sha=${'a'.repeat(40)}`)) fx.exec[k.replace('a'.repeat(40), SHA)] = []; // github has nothing at this sha
  F.record(RUN, 'intake', 'started', { title: 't', url: 'https://github.com/acme/app/issues/1', association: 'OWNER' });
  F.record(RUN, 'spec', 'awaiting-approval');
  let calls = 0;
  const ex = (cmd, args) => { calls++; return fakeExec(fx)(cmd, args); };
  const go = () => track([{ run: RUN, repo: 'acme/app', sha: SHA }], { runs: F.derive(F.read()), record: F.record, connectors, exec: ex });
  const first = go();
  assert.deepEqual(first.recorded.map((x) => [x.connector, x.env, x.state]), [['fake-host', 'preview', 'ready']]);
  const ev = F.read().filter((e) => e.stage === 'ship');
  assert.deepEqual([ev.length, ev[0].status, ev[0].connector, ev[0].kind, ev[0].sha], [1, 'passed', 'fake-host', 'web-deploy', SHA]);
  const r = F.derive(F.read())[RUN];
  assert.equal(r.url, 'https://github.com/acme/app/issues/1'); // a deploy url never replaces the issue url
  assert.deepEqual([r.stage, r.outcome], ['spec', 'awaiting-approval']); // nor moves the run or approves its spec
  assert.deepEqual(r.deploys.map((d) => [d.connector, d.env, d.state, d.url]), [['fake-host', 'preview', 'ready', 'https://pr-1.fake.host']]);
  const before = calls;
  assert.deepEqual(go().recorded, []); // final state at this sha: not even looked up again
  assert.equal(calls, before);
  // Not final yet: looked up on every call, but the same state for the same sha is recorded once.
  const S2 = '2'.repeat(40), R2 = 'acme/app#2';
  F.record(R2, 'intake', 'started', { title: 't2' });
  fx.exec[`gh api repos/acme/app/deployments?sha=${S2}&per_page=30`] = [];
  fx.exec[`fakehost ls acme/app ${S2}`] = [{ target: 'preview', s: 'building', sha: S2 }];
  const go2 = () => track([{ run: R2, repo: 'acme/app', sha: S2 }], { runs: F.derive(F.read()), record: F.record, connectors, exec: ex }).recorded.length;
  assert.deepEqual([go2(), go2()], [1, 0]);
  fx.exec[`fakehost ls acme/app ${S2}`] = [{ target: 'preview', s: 'error', sha: S2 }];
  assert.equal(go2(), 1);
  assert.deepEqual(F.derive(F.read())[R2].deploys.map((d) => [d.state, d.status]), [['error', 'failed']]);
  // decide(): deploy.preview=required is met by the fake provider, because only kind/env/state/sha count.
  const ok = { ...r, association: 'OWNER', iteration: 1, pr: 'x', reviewedSha: SHA, axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'passed' } } } };
  const rules = { 'deploy.preview': { value: 'required', reason: 'r', setBy: 'acme', setAt: '2026-11-22T00:00:00Z' } };
  const facts = { checks: 'pass', additions: 1, deletions: 0, files: ['README.md'], rules };
  assert.equal(F.decide(ok, facts).action, 'merge');
  assert.match(F.decide(ok, facts).reasons.join(), /preview ready: https:\/\/pr-1\.fake\.host \(fake-host\)/);
  assert.equal(F.decide({ ...ok, reviewedSha: 'e'.repeat(40) }, facts).action, 'escalate');
});

test('CLI: ship.mjs and the F ship alias both list connectors read-only', () => {
  const env = { ...process.env, FACTORY_DIR: path.join(tmp, 'cli') };
  const run = (file, args) => JSON.parse(execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', env }));
  assert.deepEqual(run(path.join(HERE, '..', 'ship.mjs'), ['connectors']).map((c) => c.id), ['github-deployments']);
  assert.deepEqual(run(path.join(HERE, '..', '..', 'factory', 'factory.mjs'), ['ship', 'connectors']).map((c) => c.id), ['github-deployments']);
  assert.ok(!fs.existsSync(path.join(tmp, 'cli', 'events.jsonl'))); // reads never write the log
  assert.throws(() => execFileSync(process.execPath, [path.join(HERE, '..', 'ship.mjs'), 'status', 'not a repo'], { stdio: 'pipe', env }), /usage/);
});
