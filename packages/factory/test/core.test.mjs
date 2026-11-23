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
import { artifact, page, render } from '../../server/src/server.ts';
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
  const ok = { association: 'OWNER', iteration: 1, pr: 'x', axes: { 1: ['code'] }, reviews: { 1: { code: { verdict: 'passed' } } } };
  const facts = { checks: 'pass', additions: 10, deletions: 0, files: ['src/a.ts', 'src/a.test.ts'] };
  assert.equal(decide(ok, facts).action, 'merge');
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
  assert.equal(page.split('__FACTORY_DATA__').length, 1);
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

// The claude.ai Artifact page (#18): no skeleton, no reload timer, no local path, nothing dashboard.html doesn't carry, never a token.
// It runs on a copy of the demo state, so the paths it plants never reach the other tests.
export function artifactTest() {
  const prev = io.dir;
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-artifact-'));
  fs.cpSync(prev, io.dir, { recursive: true });
  try {
    const dataOf = (h) => JSON.parse(h.match(/<script type="application\/json" id="data">([^<]*)<\/script>/)[1]);
    const home = os.homedir();
    fs.mkdirSync(runDir('evil/x#1'), { recursive: true });
    fs.writeFileSync(wtFile('evil/x#1'), JSON.stringify({ path: path.join(home, 'wt', 'x-1'), branch: 'factory/issue-1' }));
    // Paths in and outside $HOME, with spaces, in URLs and env strings, in free text and in onboard and skills config.
    const planted = [`see ${path.join(home, 'notes.md')}`, 'cd /Volumes/Data/secret && x', '(C:/Users/bob/app)', 'C:\\Users\\Bob Smith\\app', 'C:\\Users\\Bob Smith',
      'D:\\work\\app', '/srv/alice: done', '/Users/george/Library/Application Support/x', 'at file:///Users/al/x.mjs:3:9', 'vscode://file/home/al/x.ts',
      'cwd:/Users/al/x', 'PATH=/a:/home/al/bin', '/factory approve', 'https://github.com/evil/x/pull/2'];
    record('evil/x#1', 'intake', 'passed', { summary: planted.join('\n'), sessionId: 's1', cwd: path.join(home, 'src', 'x') });
    fs.writeFileSync(path.join(io.dir, 'skills.json'), JSON.stringify({ 'evil/x': { spec: { use: 'brief', path: '/Volumes/Data/briefs/spec.md' } } }));
    fs.writeFileSync(path.join(io.dir, 'onboard.json'), JSON.stringify({ default: { ship: ['web'] }, 'evil/x': { ship: ['web'], path: '/Volumes/Data/clones/x' } }));
    const before = fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8'), out = path.join(io.dir, 'artifact.html');
    const line = execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), 'render', '--artifact', out], { env: { ...process.env, FACTORY_DIR: io.dir }, encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(io.dir, 'dashboard.html'), 'utf8'), before); // the local dashboard is left alone
    const art = fs.readFileSync(out, 'utf8'), a = dataOf(art), full = dataOf(page());
    assert.match(line, new RegExp(`artifact\\.html: ${Buffer.byteLength(art)} bytes, ${full.runs.length} runs`));
    assert.ok(!/<!doctype|<html|<head>|<\/head>|<body|<\/body>|<\/html>|<meta charset|<meta name="viewport"|setTimeout\(tick, 10000\);/i.test(art));
    assert.match(art, /<script type="application\/json" id="data">/);
    assert.ok(!art.includes('</script><script>alert')); // a kept run's title still can't break out of the JSON tag
    assert.deepEqual(Object.keys(a), Object.keys(full)); // nothing beyond what the dashboard shows
    assert.deepEqual(a.runs.map((r) => r.id), full.runs.map((r) => r.id)); // every project the dashboard shows
    assert.deepEqual(a.runs.map((r) => r.pr), full.runs.map((r) => r.pr)); // URLs survive
    const loc = JSON.stringify(full), pub = JSON.stringify(a);
    for (const p of [JSON.stringify(home).slice(1, -1), '/Volumes/Data/briefs/spec.md', '/Volumes/Data/clones/x']) assert.ok(loc.includes(p), p); // the local dashboard has them...
    const leak = new RegExp(`${JSON.stringify(home).slice(1, -1).replace(/[\\.]/g, '\\$&')}|\\/(Users|home|Volumes|srv)\\b|(?<![A-Za-z])[A-Za-z]:(\\\\\\\\|\\/)|file:\\/\\/|Smith|Support|secret|\\/a:`);
    assert.match(loc, leak); // the check itself can see a leak
    assert.doesNotMatch(pub, leak); // ...the published page has none, not even a fragment after a space
    const x = a.runs.find((r) => r.id === 'evil/x#1');
    assert.equal(x.worktree, undefined);
    assert.ok(x.sessions.every((s) => !('cwd' in s)));
    assert.match(pub, /\/factory approve/); // one segment, not a path
    assert.match(pub, /https:\/\/github\.com\/evil\/x\/pull\/2/);
    assert.deepEqual(a.skills.catalog, { global: [], projects: {} });
    assert.deepEqual(a.onboard.default, { ship: ['web'] });
    assert.throws(() => artifact(page({ ui: { token: 'secret' } })), /built for F ui|carries a token/);
    assert.throws(() => artifact(page({ auth: { accessToken: 'x' } })), /carries a token/); // any key ending in token
    assert.throws(() => artifact('<p>no skeleton</p>'), /no longer has/);
    assert.throws(() => artifact(page().replace('setTimeout(tick, 10000);', '')), /exactly once/);
  } finally {
    fs.rmSync(io.dir, { recursive: true, force: true });
    io.dir = prev;
  }
}

setup();
test('demo: derive, gate, decide, risk, metrics and the dashboard', coreTest);
test('artifact: the claude.ai page built from the demo state', artifactTest); // runs after coreTest, on its state
