// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAP } from '../../core/src/constants.ts';
import { execFileSync } from 'node:child_process';
import { HERE } from '../factory.mjs';
import { archive, io, read, readArchive, record, runDir } from '../../core/src/log.ts';
import { axesFor, decide, gate, risk } from '../../core/src/gate.ts';
import { demo } from '../../core/src/demo.ts';
import { derive, getRun } from '../../core/src/derive.ts';
import { facts, intake } from '../../core/src/github.ts';
import { headlessArgs } from '../../core/src/review.ts';
import { loop } from '../../core/src/project.ts';
import { SECRET, artifact, page, render, residue } from '../../server/src/server.ts';
import { rules } from '../../core/src/rules.ts';
import { wtFile } from '../../core/src/workspace.ts';
import { test } from 'node:test';
import { setup } from './setup.mjs';

// The demo runs through derive, gate, decide, risk, metrics and the dashboard, in process.
export function coreTest() {
  demo();
  const runs = derive(read());
  assert.equal(runs['acme/shop#41'].outcome, 'rejected');
  assert.equal(runs['acme/shop#42'].outcome, 'needs-info');
  const loop = runs['acme/shop#43'];
  assert.equal(loop.outcome, 'merged');
  assert.equal(loop.iteration, 3);
  assert.deepEqual(loop.loopbacks.map((l) => l.route), ['spec', 'build']);
  assert.equal(loop.decision.action, 'merge');
  assert.equal(runs['acme/shop#44'].decision.action, 'escalate');
  assert.match(runs['acme/shop#44'].decision.reasons.join(), /sensitive paths/);
  assert.equal(runs['acme/shop#45'].outcome, 'in-progress');
  assert.throws(() => gate(runs['acme/shop#45']), /missing review verdicts: ux, ui, seo/);
  // Cap: a failing review at the cap goes to approve, never another loop.
  const capped = { iteration: CAP, axes: { [CAP]: ['code'] }, reviews: { [CAP]: { code: { verdict: 'failed', findings: [{ route: 'build' }] } } } };
  assert.equal(gate(capped).next, 'approve');
  // Untrusted author, red CI, big diff each force escalation.
  const ok = { association: 'OWNER', iteration: 1, pr: 'x', reviewedSha: 's1', axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'passed' } } } };
  const facts = { autoMerge: true, checks: 'pass', additions: 10, deletions: 0, files: ['src/a.ts', 'src/a.test.ts'] };
  assert.equal(decide(ok, facts).action, 'merge');
  assert.deepEqual(decide({ ...ok, reviewedSha: undefined }, facts), { action: 'escalate', reasons: ['no reviewed commit recorded'] }); // never a merge decision merge() would then refuse
  assert.equal(decide({ ...ok, association: 'CONTRIBUTOR' }, facts).action, 'escalate');
  assert.equal(decide(ok, { ...facts, checks: 'none' }).action, 'escalate');
  assert.equal(decide(ok, { ...facts, additions: 400 }).action, 'escalate');
  assert.equal(decide(ok, { ...facts, files: ['.github/workflows/ci.yml'] }).action, 'escalate');
  assert.match(decide(ok, { ...facts, files: ['src/a.ts'] }).reasons.join(), /no test change/);
  assert.equal(decide(ok, { ...facts, files: ['README.md'] }).action, 'merge'); // docs-only needs no test
  assert.match(decide({ ...ok, costUsd: 9 }, facts).reasons.join(), /budget/);
  assert.match(decide({ ...ok, tokens: 4e6 }, facts).reasons.join(), /budget/);
  assert.match(decide({ ...ok, origin: 'x#1', originAssociation: 'NONE' }, facts).reasons.join(), /split from x#1/);
  assert.match(decide(ok, { ...facts, association: 'NONE' }).reasons.join(), /not trusted/); // live value wins
  assert.match(decide(ok, { ...facts, autoMerge: false }).reasons.join(), /auto-merge is turned off/);
  assert.match(decide(ok, { ...facts, files: ['.claude/skills/review/SKILL.md', 'src/a.test.ts'] }).reasons.join(), /sensitive paths/); // a branch's own agent config
  for (const f of ['.mcp.json', 'pkg/.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/pre.sh', '.claude/agents/x.md']) // claude -p runs these untrusted
    assert.equal(decide(ok, { ...facts, files: [f, 'src/a.test.ts'] }).action, 'escalate', f);
  assert.equal(decide(ok, { ...facts, files: ['docs/mcp.json.md', 'src/a.test.ts'] }).action, 'merge');
  // Headless runner flags: pinned, never --bare, read-only for reviews, budget in whole cents, a spent budget refuses.
  const ha = headlessArgs({ budget: 3.456, write: true });
  assert.deepEqual(ha.slice(ha.indexOf('--permission-mode'), ha.indexOf('--permission-mode') + 4), ['--permission-mode', 'auto', '--permission-prompts', 'none']);
  for (const f of [['--output-format', 'json'], ['--max-budget-usd', '3.45'], ['--setting-sources', 'user']]) assert.equal(ha[ha.indexOf(f[0]) + 1], f[1]);
  assert.ok(ha.includes('--strict-mcp-config') && !ha.includes('--bare') && !ha.includes('--json-schema') && !ha.includes('--allowedTools'));
  const ro = headlessArgs(); // verifier, intake, spec: read-only by default
  assert.equal(ro[ro.indexOf('--permission-mode') + 1], 'manual');
  assert.deepEqual(ro.slice(ro.indexOf('--allowedTools')), ['--allowedTools', 'Bash(git diff:*)', 'Bash(git log:*)', 'Read', 'Grep', 'Glob']);
  assert.ok(!headlessArgs().includes('--max-budget-usd')); // unknown budget: no flag
  const hr = headlessArgs({ schema: { type: 'object' } });
  assert.equal(hr[hr.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.equal(hr[hr.indexOf('--permission-mode') + 1], 'manual');
  for (const b of [0, -1, 0.004, NaN, 'x']) assert.throws(() => headlessArgs({ budget: b }), /no run budget left/);
  // Parallel reviewers split the remaining budget, whole cents rounded down; a share under the minimum refuses.
  const usdOf = (o) => { const x = headlessArgs(o); return x[x.indexOf('--max-budget-usd') + 1]; };
  assert.equal(usdOf({ budget: 5, share: 6 }), '0.83');
  assert.deepEqual(headlessArgs({ budget: 3.456, share: 1 }), headlessArgs({ budget: 3.456 }));
  assert.equal(usdOf({ budget: 0.58, share: 2 }), '0.29'); // no float drift (0.29 * 100 is 28.999…)
  assert.equal(usdOf({ budget: 0.3, share: 6 }), '0.05'); // exactly the minimum still runs
  assert.throws(() => headlessArgs({ budget: 0.29, share: 6 }), /budget share \$0\.04 per reviewer is below \$0\.05/);
  for (const n of [0, -2, 1.5, NaN, '3']) assert.throws(() => headlessArgs({ budget: 5, share: n }), /share must be a positive integer/);
  assert.ok(!headlessArgs({ share: 6 }).includes('--max-budget-usd')); // unknown budget: still no flag
  assert.throws(() => headlessArgs({ budget: 0, share: 6 }), /no run budget left/);
  // Demo run 50: custom/provider runners are stamped, and prose from a custom reviewer fails the axis instead of passing.
  const r50 = runs['acme/shop#50'];
  assert.equal(r50.outcome, 'merged');
  assert.deepEqual(r50.runners, { spec: { use: 'skill', name: 'my-planner' }, build: { use: 'provider', harness: 'codex' }, gate: { use: 'provider', harness: 'claude-code', name: 'pr-review-toolkit:code-reviewer' } });
  assert.match(r50.reviews[1].a11y.findings[0].issue, /^reviewer output invalid/);
  assert.equal(r50.reviews[1].a11y.verdict, 'failed');
  assert.equal(r50.reviews[2].ui.runner.name, 'brand-review');
  // Demo run 51: merged under ci=skip because F's local checks passed on the reviewed commit; the reason names the rule.
  assert.equal(runs['acme/shop#51'].decision.action, 'merge');
  assert.match(runs['acme/shop#51'].decision.reasons.join(' | '), /CI not required by rule ci=skip, set by acme on 2026-11-20: GitHub Actions billing is failing\. Local checks: pass \(pnpm test, pnpm lint\)/);
  assert.equal(runs['acme/shop'], undefined); // rule events are not runs
  assert.deepEqual(runs['acme/shop#51'].deploys.map((d) => [d.env, d.state]), [['preview', 'ready'], ['production', 'ready']]); // latest per connector and env
  assert.deepEqual([runs['acme/shop#44'].outcome, runs['acme/shop#44'].stage, runs['acme/shop#44'].url], ['escalated', 'approve', 'https://github.com/acme/shop/issues/44']); // deploys move nothing
  assert.deepEqual(rules('acme/shop').expired.map((x) => x.key), ['diffCap']);
  // Verifier-dismissed findings don't block; the cost cap stops looping.
  const dis = { iteration: 1, axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'passed', findings: [{ severity: 'high', route: 'build', dismissed: 'not reachable' }] } } } };
  assert.equal(gate(dis).next, 'approve');
  const pricey = { iteration: 1, costUsd: 6, axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'failed', findings: [{ severity: 'high', route: 'build' }] } } } };
  assert.equal(gate(pricey).next, 'approve');
  assert.deepEqual(risk({ association: 'OWNER' }, ['src/a.ts']), { risky: false, reasons: [] });
  assert.ok(risk({ association: 'NONE' }, ['lib/auth/x.ts']).reasons.length === 2);
  assert.deepEqual(axesFor(['app/api/x/route.ts']), ['code', 'security', 'docs']);
  // Eval fixtures are served offline, without GitHub.
  process.env.FACTORY_FIXTURES = path.join(HERE, 'evals', 'golden');
  assert.equal(intake('eval/golden#4').association, 'NONE');
  delete process.env.FACTORY_FIXTURES;
  // Archive moves finished runs out of the live log; the dashboard and metrics still include them.
  // Before archiving: the new states derive correctly.
  const pre = derive(read());
  assert.deepEqual(pre['acme/shop#47'].parent, 'acme/shop#46');
  assert.equal(pre['acme/shop#49'].outcome, 'awaiting-approval');
  assert.equal(pre['acme/shop#43'].reverted.pr, 'https://github.com/acme/shop/pull/93');
  assert.equal(pre['acme/shop#43'].pr, 'https://github.com/acme/shop/pull/90');
  assert.equal(pre['acme/shop#43'].tokens, 93000);
  assert.equal(pre['acme/shop#44'].burn.byAxis.security.tokens, 49710); // reported per axis
  assert.equal(getRun('acme/shop#43').burn.measured, true);
  assert.equal(getRun('acme/shop#44').burn.measured, false);
  assert.deepEqual(archive(0), { archived: 6 }); // 41 rejected, 43 merged, 44 escalated, 46 split, 50 + 51 merged
  assert.equal(readArchive().find((a) => a.id === 'acme/shop#43').burn.measured, true); // survives losing its events
  assert.deepEqual(Object.keys(derive(read())).sort(), ['acme/shop#42', 'acme/shop#45', 'acme/shop#47', 'acme/shop#48', 'acme/shop#49', 'eval/golden#4']);
  assert.equal(read().filter((e) => e.stage === 'rules').length, 5); // the rule audit trail survives archiving
  const page = fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8');
  assert.match(page, /"merged":3,/); // metrics.all counts the archived merges
  assert.ok(!page.includes('id="data">__FACTORY_DATA__'));
  assert.match(page, /"reload":10000/); // the file re-reads itself
  assert.match(page, /"ruleHistory":\[\{[^\]]*"key":"ci","value":"skip"/);
  assert.match(page, /"id":"acme\/shop#47"[^]*?"parent":"acme\/shop#46"/); // parent survives archiving
  fs.mkdirSync(runDir('acme/shop#45'), { recursive: true });
  fs.writeFileSync(wtFile('acme/shop#45'), JSON.stringify({ path: '/w/shop-45', branch: 'factory/issue-45' }));
  assert.match(fs.readFileSync(render(), 'utf8'), /"id":"acme\/shop#45"[^]*?"worktree":"\/w\/shop-45"/); // the "Open in Claude" cwd
  assert.deepEqual(axesFor(['lib/x.ts']), ['code', 'security']);
  assert.deepEqual(axesFor(['app/blog/page.tsx']), ['code', 'security', 'ux', 'ui', 'seo']);
  // Dashboard must not break out of its JSON script tag.
  record('evil/x#1', 'intake', 'started', { title: '</script><script>alert(1)</script>' });
  const html = fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8');
  assert.ok(!html.includes('</script><script>alert'));
}

// The claude.ai Artifact page (#18): no skeleton, no reload, no local path, nothing the local dashboard doesn't carry, never a token.
// It runs on a copy of the demo state, so the paths it plants never reach the other tests.
export function artifactTest() {
  const prev = io.dir;
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-artifact-'));
  fs.cpSync(prev, io.dir, { recursive: true });
  try {
    const dataOf = (h) => JSON.parse(h.match(/<script type="application\/json" id="data">([^<]*)<\/script>/)[1]);
    const home = os.homedir(), user = os.userInfo().username;
    fs.mkdirSync(runDir('evil/x#1'), { recursive: true });
    fs.writeFileSync(wtFile('evil/x#1'), JSON.stringify({ path: path.join(home, 'wt', 'x-1'), branch: 'factory/issue-1' }));
    // Paths in and outside $HOME, with spaces, in URLs and env strings, in free text and in onboard and skills config.
    const planted = [`see ${path.join(home, 'notes.md')}`, 'cd /Volumes/Data/secret && x', '(C:/Users/bob/app)', 'C:\\Users\\Bob Smith\\app', 'C:\\Users\\Bob Smith',
      'D:\\work\\app', '/srv/alice: done', '/Users/george/Library/Application Support/x', 'at file:///Users/al/x.mjs:3:9', 'vscode://file/home/al/x.ts',
      'cwd:/Users/al/x', 'PATH=/a:/home/al/bin', '/factory approve', 'https://github.com/evil/x/pull/2', `\\\\wsl.localhost\\Ubuntu\\home\\${user}\\app`,
      '\\\\fs01\\users\\bob', 'vscode-remote://ssh-remote+box/home/al/x', 'cwd:/data/proj/x', 'src:/code/acme/x', 'see /srv/a/b.md https://github.com/evil/x/pull/3 ok', 'GET /api/runs'];
    record('evil/x#1', 'intake', 'passed', { summary: planted.join('\n'), sessionId: 's1', cwd: path.join(home, 'src', 'x') });
    Object.assign(process.env, { CLAUDE_CODE_SESSION_ID: 's2', CLAUDE_CODE_HOST_SESSION_ID: 'local_0123abcd-0123-4567-89ab-0123456789ab' }); // driven from the desktop app
    try { record('evil/x#1', 'spec', 'started'); } finally { delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CLAUDE_CODE_HOST_SESSION_ID; }
    fs.writeFileSync(path.join(io.dir, 'skills.json'), JSON.stringify({ 'evil/x': { spec: { use: 'brief', path: '/Volumes/Data/briefs/spec.md' } } }));
    fs.writeFileSync(path.join(io.dir, 'onboard.json'), JSON.stringify({ default: { ship: ['web'] }, 'evil/x': { ship: ['web'], path: '/Volumes/Data/clones/x' } }));
    const before = fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8'), out = path.join(io.dir, 'artifact.html');
    const line = execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'render', '--artifact', out], { env: { ...process.env, FACTORY_DIR: io.dir }, encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8'), before); // the local dashboard is left alone
    const art = fs.readFileSync(out, 'utf8'), a = dataOf(art), full = dataOf(page({}, { sheet: true })); // the Artifact adds the Metrics sheet (#82)
    assert.match(line, new RegExp(`artifact\\.html: ${Buffer.byteLength(art)} bytes, ${full.runs.length} runs`));
    assert.ok(!/<!doctype|<html|<head>|<\/head>|<body|<meta charset|<meta name="viewport"/i.test(art.slice(0, art.indexOf('<script type="module">'))), 'no skeleton before the script');
    assert.ok(!/<\/body>|<\/html>/i.test(art.slice(art.lastIndexOf('</script>'))), 'nor after it');
    assert.match(art, /^<title>[^]*<style>[^]*<div id="root"><\/div>[^]*<script type="module">[^]*<\/script>\s*$/); // the app, inlined: nothing to load
    assert.ok(!/\s(?:src|href)="(?!data:)/.test(art.replace(/<script type="module">[^]*<\/script>/, '')), 'no external file');
    assert.match(art, /<script type="application\/json" id="data">/);
    assert.ok(!art.includes('</script><script>alert')); // a kept run's title still can't break out of the JSON tag
    assert.deepEqual(Object.keys(a), Object.keys(full).filter((k) => k !== 'fCmd')); // nothing beyond what the dashboard shows; F's local path stays home
    assert.deepEqual(a.runs.map((r) => r.id), full.runs.map((r) => r.id)); // every project the dashboard shows
    assert.deepEqual(a.runs.map((r) => r.pr), full.runs.map((r) => r.pr)); // URLs survive
    const loc = JSON.stringify(full), pub = JSON.stringify(a);
    for (const p of [JSON.stringify(home).slice(1, -1), '/Volumes/Data/briefs/spec.md', '/Volumes/Data/clones/x']) assert.ok(loc.includes(p), p); // the local dashboard has them...
    const leak = new RegExp(`${JSON.stringify(home).slice(1, -1).replace(/[\\.]/g, '\\$&')}|\\/(Users|home|Volumes|srv)\\b|(?<![A-Za-z])[A-Za-z]:(\\\\\\\\|\\/)|file:\\/\\/|Smith|Support|secret|\\/a:|wsl\\.localhost|fs01|ssh-remote|\\/data\\/|\\/code\\/`);
    assert.match(loc, leak); // the check itself can see a leak
    const hit = pub.match(leak);
    assert.equal(hit, null, hit && pub.slice(Math.max(0, hit.index - 80), hit.index + 80)); // ...the published page has none, not even a fragment after a space
    const x = a.runs.find((r) => r.id === 'evil/x#1');
    assert.equal(x.worktree, undefined);
    assert.ok(x.sessions.every((s) => !('cwd' in s) && !('hostId' in s)), 'no local path or desktop session link');
    assert.ok(loc.includes('local_0123abcd') && !pub.includes('local_0123abcd'));
    assert.match(pub, /\/factory approve/); // one segment, not a path
    assert.match(pub, /GET \/api\/runs/); // a route, not a path
    assert.match(pub, /\[local path\] https:\/\/github\.com\/evil\/x\/pull\/3 ok/); // a path stops at the URL after it
    // The backstop: whatever the patterns miss, the login (as a path segment), the host name or a known path is refused.
    for (const note of [`built in x\\${user}\\y`, `dev server http://${os.hostname()}:5173/x`]) assert.throws(() => artifact(page({ note })), /still carries/, note);
    assert.match(pub, /https:\/\/github\.com\/evil\/x\/pull\/2/);
    assert.deepEqual(a.skills.catalog, { global: [], projects: {} });
    assert.deepEqual(a.onboard.default, { ship: ['web'] });
    assert.throws(() => artifact(page({ ui: { token: 'secret' } })), /built for F ui|carries a token/);
    assert.throws(() => artifact(page({ auth: { accessToken: 'x' } })), /carries a token/); // any key ending in token
    assert.throws(() => artifact('<p>no skeleton</p>'), /no longer has/);
    assert.equal(dataOf(artifact(page({ reload: 10_000 }))).reload, undefined, 'updates arrive by republish');
    const inApp = (x) => page().replace('<script type="module">', () => `${x}<script type="module">`); // in the bundle, outside the data
    assert.throws(() => artifact(inApp(`<p>${os.homedir()}/notes</p>`)), /the app itself carries a home/);
    for (const t of ['ghp_' + 'a'.repeat(36), 'sk-ant-' + 'b'.repeat(40), 'http://127.0.0.1:4173/?t=' + 'c'.repeat(32)]) {
      assert.throws(() => artifact(inApp(`<i>${t}</i>`)), /carries a token/, t);
      assert.throws(() => artifact(page({ note: t })), /carries a token/, t);
    }
    const tail = page().replace(/<\/body>\s*<\/html>\s*$/, '');
    assert.throws(() => artifact(tail), /no longer has/, 'a missing </body> is not taken from inside the script');
  } finally {
    fs.rmSync(io.dir, { recursive: true, force: true });
    io.dir = prev;
  }
}

// The backstop with a made-up machine: login X (whose profile repo is X/X), host build or Georges-MacBook-Pro.local.
export function residueTest() {
  const me = (host = 'build', projects = { 'X/X': { path: '/srv/clones/xx' } }) => ({ user: 'X1x', host, home: '/home/X1x', projects });
  const raw = { runs: [{ id: 'X1x/X1x#3', worktree: '/srv/wt/x3', sessions: [{ cwd: '/srv/s/1' }] }] };
  const check = (data, m = me()) => residue(JSON.stringify(data), raw, m);
  // The owner/repo id, its project key and its GitHub URLs are not the login in a path, nor is prose that says "build".
  const ok = { runs: [{ id: 'X1x/X1x#3', url: 'https://github.com/X1x/X1x/issues/3', pr: 'https://github.com/X1x/X1x/pull/4', remote: 'git@github.com:X1x/X1x.git',
    note: 'X1x/X1x#3: build passed; see packages/build/x and src/app; npm run build' }], projects: ['X1x/X1x'] };
  assert.deepEqual(check(ok, me('build', { 'X1x/X1x': { path: '/srv/clones/xx' } })), []);
  assert.deepEqual(residue(JSON.stringify(ok), raw, me('app')), []);
  assert.deepEqual(check({ note: 'uses ＠app/ui and @app/ui; step app:1' }, me('app')), []); // a scoped package and a step label, not the host
  for (const [note, what, m] of [
    ['C:\\work\\X1x\\proj', /login/], ['under /mnt/X1x/app', /login/], ['http://localhost:3000/home/X1x/proj', /home, clone or worktree/],
    ['at /srv/clones/xx/src', /home, clone or worktree/, me('build', { 'X1x/X1x': { path: '/srv/clones/xx' } })], ['cd /srv/wt/x3', /worktree/], ['cwd /srv/s/1', /worktree/],
    ['PR https://github.com/acme/app/pull/2\nhttp://localhost:3000/mnt/X1x/x', /login/], ['PR https://github.com/acme/app/pull/2,/mnt/X1x/x', /login/], // the GitHub exemption ends with its URL
    ['open http://build.local:5173/x', /host/], ['http://build:5173/', /host/], ['me@build', /host/], ['\\\\build\\share', /host/], ['smb://build/share', /host/],
    ['http://Georges-MacBook-Pro.local:5173/x', /host/, me('Georges-MacBook-Pro.local')], ['ran on Georges-MacBook-Pro.local', /host/, me('Georges-MacBook-Pro.local')],
  ]) assert.match(check({ note }, m).join(), what, note);
}

setup();
test('demo: derive, gate, decide, risk, metrics and the dashboard', coreTest);
test('artifact backstop: refuses this machine\'s names and paths, not owner/repo ids or prose', residueTest);
test('artifact: the claude.ai page built from the demo state', artifactTest);
test('the committed app.html carries nothing from the machine that built it', () => { // but the install hint names the project's own GitHub repo
  const html = fs.readFileSync(path.join(HERE, 'app.html'), 'utf8').replaceAll('georgesimos/software-factory', ''), host = os.hostname().split('.')[0];
  for (const re of [/\/Users\//, /\/home\//, /[A-Z]:\\{1,2}Users/i, /~\/(?!\.claude\/|\s)/]) assert.doesNotMatch(html, re); // ~/.claude/… is the documented generic path
  const user = os.userInfo().username;
  if (user.length >= 3) assert.ok(!html.toLowerCase().includes(user.toLowerCase()), 'the login');
  if (host.length >= 3) assert.ok(!html.toLowerCase().includes(host.toLowerCase()), 'the host name');
  assert.doesNotMatch(html, SECRET);
}); // runs after coreTest, on its state

// pnpm -r build doesn't rebuild app.html (the web package's dashboard script does), so a page change can ship with a stale one.
const web = path.join(HERE, '..', '..', 'apps', 'web'), vite = path.join(web, 'node_modules', 'vite', 'bin', 'vite.js');
test('the committed app.html is a fresh web build (else: pnpm --filter @software-factory/web dashboard, and commit it)', { skip: !fs.existsSync(vite) && 'apps/web is not installed' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-app-'));
  execFileSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: web, stdio: ['ignore', 'ignore', 'pipe'] });
  const lf = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout may turn the committed copy's line ends
  assert.ok(lf(path.join(out, 'index.html')) === lf(path.join(HERE, 'app.html')), 'packages/factory/app.html differs from a fresh build of apps/web: run pnpm --filter @software-factory/web dashboard and commit it');
});
