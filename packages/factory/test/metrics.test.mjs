// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { io, log } from '../../core/src/log.ts';
import { logMetrics } from '../../core/src/metrics.ts';
import { artifact, page, sheetMetrics, uiHandle } from '../../server/src/server.ts';
import { setup } from './setup.mjs';

setup();
const SID = 'sess-secret-1', CWD = '/Users/secret/work';
const ev = (ts, run, stage, status, p = {}) => ({ ts, run, stage, status, ...p });
// acme/a#1: measured (transcript rows below), merged, then reverted; its reported 5000 tokens must not count twice.
// acme/a#2: reported only, from Codex: an unpriced model, a priced one, one loop-back and the loop cap; escalated.
// acme/b#1: in progress, reported dollars with no token split.
const events = [
  ev('2026-11-20T10:00:00.000Z', 'acme/a#1', 'intake', 'started', { harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-20T10:10:00.000Z', 'acme/a#1', 'intake', 'passed', { harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-20T10:30:00.000Z', 'acme/a#1', 'build', 'started', { harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-20T11:00:00.000Z', 'acme/a#1', 'build', 'passed', { harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-20T11:10:00.000Z', 'acme/a#1', 'review', 'started', { axes: ['code'], harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-20T11:20:00.000Z', 'acme/a#1', 'review', 'passed', { axis: 'code', findings: [], tokens: 5000, harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-20T11:30:00.000Z', 'acme/a#1', 'gate', 'passed', { harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-21T09:00:00.000Z', 'acme/a#1', 'approve', 'merged', { pr: 'https://github.com/acme/a/pull/7', harness: 'claude-code', sessionId: SID, cwd: CWD }),
  ev('2026-11-22T08:00:00.000Z', 'acme/a#1', 'approve', 'reverted', { pr: 'x', reason: 'broke prod' }),
  ev('2026-11-21T10:00:00.000Z', 'acme/a#2', 'intake', 'started', { harness: 'codex' }),
  ev('2026-11-21T10:10:00.000Z', 'acme/a#2', 'build', 'started', { harness: 'codex' }),
  ev('2026-11-21T10:15:00.000Z', 'acme/a#2', 'build', 'passed', { harness: 'codex', tokens: 4000, usage: { input: 2000, cacheRead: 2000 }, model: 'claude-sonnet-5-5' }),
  ev('2026-11-21T10:20:00.000Z', 'acme/a#2', 'review', 'started', { axes: ['code'], harness: 'codex' }),
  ev('2026-11-21T10:30:00.000Z', 'acme/a#2', 'review', 'failed', { axis: 'code', findings: [{ severity: 'high', issue: 'x', route: 'build' }], tokens: 2000, usage: { input: 1000, output: 1000 }, model: 'claude-mystery-9', harness: 'codex' }),
  ev('2026-11-21T10:40:00.000Z', 'acme/a#2', 'gate', 'failed', { next: 'build', harness: 'codex' }),
  ev('2026-11-21T10:50:00.000Z', 'acme/a#2', 'build', 'started', { harness: 'codex' }),
  ev('2026-11-21T11:00:00.000Z', 'acme/a#2', 'build', 'started', { harness: 'codex' }),
  ev('2026-11-21T11:10:00.000Z', 'acme/a#2', 'gate', 'failed', { next: 'approve', harness: 'codex' }),
  ev('2026-11-21T11:20:00.000Z', 'acme/a#2', 'approve', 'escalated', { harness: 'codex' }),
  ev('2026-11-21T12:00:00.000Z', 'acme/b#1', 'intake', 'started', { harness: 'claude-code' }),
  ev('2026-11-21T12:10:00.000Z', 'acme/b#1', 'spec', 'passed', { harness: 'claude-code', tokens: 500, costUsd: 0.01 }),
];
// measure()'s shape: sessionId -> transcript files; a row is [ts, message id, model, input, output, cacheRead, write5m, write1h, fast].
const measured = { [SID]: [
  { sub: false, rows: [['2026-11-20T10:05:00.000Z', 'm1', 'claude-opus-5-5', 1_000_000, 0, 0, 0, 0, 0], // intake: $4
    ['2026-11-20T10:35:00.000Z', 'm2', 'claude-opus-5-5', 0, 100_000, 3_000_000, 0, 0, 0]] }, // build: $2 + $0.60 of cache reads
  { sub: true, axis: 'code', rows: [['2026-11-20T11:15:00.000Z', 's1', 'claude-sonnet-5-5', 1_000_000, 0, 0, 0, 0, 0]] }, // review: $2
] };
// An archived merged run: run-level burn only, counted on its last day.
const archive = [{ id: 'acme/a#0', outcome: 'merged', started: '2026-11-01T00:00:00.000Z', updated: '2026-11-02T00:00:00.000Z', iteration: 1, loopbacks: [],
  events: [{ ts: '2026-11-02T00:00:00.000Z', status: 'merged' }], burn: { measured: true, total: { tokens: 1000, costUsd: 0.5, cacheRead: 0, unpriced: 0 }, byStage: { build: { tokens: 1000, costUsd: 0.5, unpriced: 0 } }, byAxis: {} } }];
const tok = (m) => Object.fromEntries(Object.entries(m).map(([k, c]) => [k, c.tokens]));

test('metrics: burn, cache hits, outcomes and timing from fixture events', () => {
  const m = logMetrics(events, { measured, archive });
  assert.deepEqual(m.total, { tokens: 5_107_500, input: 2_003_000, output: 101_000, cacheRead: 3_002_000, cacheWrite: 0, costUsd: 9.1142, unpriced: 2000, reported: 6500, source: 'mixed' });
  assert.equal(m.cacheHitRatio, 0.6); // 3,002,000 read of 5,005,000 split prompt tokens
  assert.deepEqual(tok(m.byDay), { '2026-11-02': 1000, '2026-11-20': 5_100_000, '2026-11-21': 6500 });
  assert.deepEqual(Object.keys(m.byDay), ['2026-11-02', '2026-11-20', '2026-11-21']);
  assert.deepEqual(tok(m.byProject), { 'acme/a': 5_107_000, 'acme/b': 500 });
  assert.deepEqual(tok(m.byStage), { intake: 1_000_000, build: 3_105_000, review: 1_002_000, spec: 500 });
  assert.deepEqual(tok(m.byAxis), { code: 1_002_000 });
  assert.deepEqual(tok(m.byHarness), { 'claude-code': 5_100_500, codex: 6000 });
  assert.deepEqual(Object.fromEntries(Object.entries(m.byModel).map(([k, c]) => [k, [c.tokens, c.costUsd, c.source]])),
    { 'claude-opus-5-5': [4_100_000, 6.6, 'measured'], 'claude-sonnet-5-5': [1_004_000, 2.0042, 'mixed'], 'claude-mystery-9': [2000, null, 'reported'] });
  assert.deepEqual(m.outcomes, { merged: 2, humanMerged: 0, escalated: 1, rejected: 0, closed: 0, split: 0, reverted: 1 });
  assert.equal(m.costPerMergedPrUsd, 4.56);
  assert.equal(m.loopsPerRun, 0.333); // one gate loop-back over three finished builds
  assert.equal(m.capHitShare, 0.333); // a#2, sent to approve at the loop cap; a#1 is over today's $5 budget but merged, so not a hit
  assert.equal(m.medianIntakeToMergeMs, 84_600_000); // mean of a#1's 23h (to the merge, not the later revert) and a#0's 24h
  assert.equal(m.measuredRuns, 2); // a#1 from its rows, a#0 from its archive summary
  // since: rows and outcomes by their own time; a#1's merge (11-21 09:00) counts, its 11-20 burn does not.
  const s = logMetrics(events, { measured, archive, since: '2026-11-21' });
  assert.deepEqual([s.total.tokens, s.total.source, Object.keys(s.byDay)], [6500, 'reported', ['2026-11-21']]);
  assert.deepEqual(s.outcomes, { merged: 1, humanMerged: 0, escalated: 1, rejected: 0, closed: 0, split: 0, reverted: 1 });
  assert.equal(s.measuredRuns, 0); // a#1's rows are all before the window
  const b = logMetrics(events, { measured, archive, project: 'acme/b' });
  assert.deepEqual([b.total.tokens, b.total.costUsd, b.cacheHitRatio, b.outcomes.merged, b.costPerMergedPrUsd, b.medianIntakeToMergeMs], [500, 0.01, null, 0, null, null]);
  assert.throws(() => logMetrics(events, { since: 'yesterday' }), RangeError);
  // Passing on the last allowed iteration is not a cap hit. A measured run with no subagent axes keeps its reported axis (as
  // F usage shows it); a provider runner's harness gets its reported burn.
  const c = (ts, stage, status, p) => ev(`2026-11-23T0${ts}:00:00.000Z`, 'acme/c#1', stage, status, { harness: 'claude-code', sessionId: 'sc', ...p });
  const last = [c(1, 'intake', 'started'), c(2, 'build', 'started'), c(3, 'build', 'started'), c(4, 'build', 'started'),
    c(5, 'review', 'passed', { axis: 'code', findings: [], tokens: 70, runner: { use: 'provider', harness: 'codex' } }), c(6, 'gate', 'passed'), c(7, 'approve', 'merged')];
  const lm = logMetrics(last, { measured: { sc: [{ sub: false, rows: [['2026-11-23T01:30:00.000Z', 'x', 'claude-opus-5-5', 10, 0, 0, 0, 0, 0]] }] } });
  assert.deepEqual([lm.capHitShare, lm.total.tokens, tok(lm.byAxis), tok(lm.byHarness)], [0, 10, { code: 70 }, { 'claude-code': 10 }]);
  const rp = logMetrics(last);
  assert.deepEqual([rp.total.tokens, tok(rp.byHarness)], [70, { codex: 70 }]);
  // Archived runs: spend falls back to the summary's own tokens and dollars (as gate's metrics() does), and counts when the
  // run ended, not at a later revert's `updated`. An unmerged run whose approve decision named the budget is a cap hit.
  const old = { id: 'acme/d#1', outcome: 'merged', started: '2026-11-01T00:00:00.000Z', updated: '2026-11-22T00:00:00.000Z', reverted: { pr: 'x' },
    iteration: 1, loopbacks: [], events: [{ ts: '2026-11-02T00:00:00.000Z', status: 'merged' }], tokens: 300, costUsd: 0.3 };
  const esc = { id: 'acme/d#2', outcome: 'escalated', started: '2026-11-03T00:00:00.000Z', updated: '2026-11-03T01:00:00.000Z', iteration: 1, loopbacks: [],
    decision: { action: 'escalate', reasons: ['run budget exceeded ($6, 0 tokens, measured)'] }, events: [{ ts: '2026-11-03T01:00:00.000Z', status: 'escalated' }] };
  // #96: a run the gate stopped at the loop cap, escalated, then merged and reverted by a human: a human merge (escalated, no
  // revert, not in cost per merge or time to merge) and still a cap hit.
  const human = { id: 'acme/d#3', outcome: 'merged', humanMerge: { by: 'octo', ts: '2026-11-04T05:00:00.000Z' }, reverted: { pr: 'y' }, started: '2026-11-04T00:00:00.000Z',
    updated: '2026-11-04T06:00:00.000Z', iteration: 3, loopbacks: [], tokens: 100, costUsd: 0.1, events: [
      { ts: '2026-11-04T03:00:00.000Z', stage: 'gate', status: 'failed', next: 'approve', reasons: ['code: 1 blocking finding(s)', 'loop cap 3 reached'] },
      { ts: '2026-11-04T04:00:00.000Z', stage: 'approve', status: 'escalated' }, { ts: '2026-11-04T05:00:00.000Z', stage: 'approve', status: 'merged', by: 'human' }] };
  const ar = logMetrics([], { archive: [old, esc, human] });
  assert.deepEqual([ar.total.tokens, ar.total.costUsd, ar.total.source, ar.costPerMergedPrUsd, Object.keys(ar.byDay), ar.capHitShare], [400, 0.4, 'reported', 0.4, ['2026-11-02', '2026-11-04'], 0.667]);
  assert.deepEqual(ar.outcomes, { merged: 1, humanMerged: 1, escalated: 2, rejected: 0, closed: 0, split: 0, reverted: 1 });
  assert.equal(ar.medianIntakeToMergeMs, 86_400_000); // old's alone
  // A cap named only in the reasons (the gate event's next lost to the archive's last-five cut) still counts.
  assert.equal(logMetrics([], { archive: [{ ...esc, decision: undefined, events: [{ ts: '2026-11-03T00:30:00.000Z', stage: 'gate', status: 'failed', reasons: ['loop cap 3 reached'] }, ...esc.events] }] }).capHitShare, 1);
  assert.deepEqual([logMetrics([], { archive: [old], since: '2026-11-21' }).total.tokens, logMetrics([], { archive: [old], since: '2026-11-21' }).outcomes.merged], [0, 0]);
  assert.equal(logMetrics([]).total.costUsd, 0);
});

test('GET /api/metrics: token-gated, filtered, no paths or session ids', (t) => {
  io.projects = path.join(io.dir, 'projects'); // measure() looks for transcripts here: none, so the burn is reported
  t.after(() => { io.projects = null; });
  fs.writeFileSync(log(), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const ctx = { token: 'tok-metrics', port: 4242 }, H = { host: '127.0.0.1:4242', 'x-factory-token': ctx.token };
  const get = (url, h = H) => uiHandle({ method: 'GET', url, headers: h }, ctx);
  assert.equal(get('/api/metrics', { host: H.host }).status, 403);
  assert.equal(get('/api/metrics', { ...H, origin: 'http://evil.test' }).status, 403);
  assert.equal(get('/api/metrics?since=nope').status, 400);
  const all = get('/api/metrics');
  assert.equal(all.status, 200);
  assert.doesNotMatch(all.body, /secret|\/Users\//); // neither the session id nor the cwd
  const r = JSON.parse(all.body);
  assert.deepEqual([r.total.tokens, r.measuredRuns, r.outcomes.merged], [11_500, 0, 1]); // a#1's reported 5000 stands in for its missing transcript
  const b = JSON.parse(get('/api/metrics?project=acme%2Fb&since=2026-11-21T00:00:00Z').body);
  assert.deepEqual([b.project, b.since, b.total.tokens], ['acme/b', '2026-11-21T00:00:00Z', 500]);
  fs.appendFileSync(log(), '{"run": broken\n'); // an internal failure: a 500 that echoes nothing from it
  const bad = get('/api/metrics');
  assert.deepEqual([bad.status, /broken|JSON/.test(bad.body)], [500, false]);
});

// #82 PR C: the Artifact has no API, so its page embeds the sheet's numbers, for all projects and each, per range.
test('the published Artifact embeds the Metrics sheet: aggregates only, no paths, hosts, logins or session ids', (t) => {
  io.projects = path.join(io.dir, 'projects');
  t.after(() => { io.projects = null; });
  const me = os.userInfo().username, mine = `${me}/${me}#1`; // a profile repo: the owner is the login, which only a known id excuses
  const all = [...events, ev('2026-11-22T09:00:00.000Z', mine, 'intake', 'started', { harness: 'claude-code', sessionId: SID, cwd: `${os.homedir()}/x` }),
    ev('2026-11-22T09:10:00.000Z', mine, 'spec', 'passed', { harness: 'claude-code', tokens: 300, by: me, host: os.hostname(), sessionId: SID, cwd: CWD })];
  fs.writeFileSync(log(), all.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const pub = artifact(), data = JSON.parse(pub.match(/<script type="application\/json" id="data">([^<]*)<\/script>/)[1]), m = data.metricsLog;
  assert.deepEqual(Object.keys(m).sort(), ['', 'acme/a', 'acme/b', `${me}/${me}`]);
  for (const p of Object.keys(m)) assert.deepEqual(Object.keys(m[p]).sort(), ['', '30', '7', '90'], p);
  assert.deepEqual([m[''][''].total.tokens, m['acme/b'][''].total.tokens, m[`${me}/${me}`][''].total.tokens, m[''][''].outcomes.merged], [11_800, 500, 300, 1]);
  assert.deepEqual(Object.keys(m[''][''].byProject).sort(), ['acme/a', 'acme/b', `${me}/${me}`]);
  assert.ok(m[''][''].byDay['2026-11-21'] && !('byDay' in m['']['30']) && !('byProject' in m['acme/a']['']), 'byDay on all-time entries only, byProject on all-projects only');
  assert.ok(!('input' in m['acme/b'][''].total) && 'costUsd' in m['acme/b'][''].total, 'zero counts dropped, costUsd kept');
  const keys = new Set(), walk = (x) => { if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { keys.add(k); walk(v); } };
  walk(Object.values(m).flatMap((p) => Object.values(p)).map(({ byDay, byProject, byStage, byAxis, byModel, byHarness, ...x }) => x));
  for (const k of ['run', 'runs', 'id', 'sessionId', 'session', 'cwd', 'by', 'host', 'author']) assert.ok(!keys.has(k), `no ${k} in the sheet`);
  const sheet = JSON.stringify(m);
  for (const x of [SID, 'secret', CWD, os.homedir(), os.hostname()]) assert.ok(!sheet.includes(x), x);
  assert.ok(!new RegExp(`"by":|[/\\\\]${me}(?![\\w/.-])`).test(sheet.replaceAll(`${me}/${me}`, '')), 'no login outside the project id');
  assert.equal(JSON.parse(page().match(/id="data">([^<]*)</)[1]).metricsLog, undefined, 'F render\'s file, after every record(): no sheet');
  const ctx = { token: 'tok-metrics', port: 4242 };
  assert.equal(JSON.parse(uiHandle({ method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:4242', 'x-factory-token': ctx.token } }, ctx).body).metricsLog, undefined, 'F ui asks GET /api/metrics');
  // A range's days are the all-time byDay from its since on, cut at the same UTC midnight.
  const at = Date.parse('2026-11-22T12:00:00Z'), x = sheetMetrics(all, ['acme/a'], at, []);
  assert.deepEqual([x['']['7'].total.tokens, x['']['']['total'].tokens], [11_800, 11_800]);
  assert.equal(x['acme/a']['7'].total.tokens, 11_000); // since 2026-11-16
  assert.deepEqual(Object.keys(x[''][''].byDay), ['2026-11-20', '2026-11-21', '2026-11-22']);
});

// #116 R1: breakdown keys are raw event fields, and scrub() rewrites values only.
test('the Artifact\'s Metrics sheet cleans breakdown keys: no local path or token-shaped key ships, and their cells add up', (t) => {
  io.projects = path.join(io.dir, 'projects');
  t.after(() => { io.projects = null; });
  const home = os.homedir(), R = 'acme/k#1', at = (m) => `2026-11-22T09:${String(m).padStart(2, '0')}:00.000Z`;
  const keys = [
    ev(at(0), R, 'intake', 'started', { harness: 'claude-code' }),
    ev(at(1), R, 'build', 'passed', { tokens: 100, model: '/opt/models/qwen.gguf', harness: 'claude-code' }),
    ev(at(2), R, 'build', 'passed', { tokens: 200, model: `${home}/models/llama.gguf`, harness: 'claude-code' }),
    ev(at(3), R, 'build', 'passed', { tokens: 50, model: 'qwen/qwen3-coder', harness: 'claude-code' }),
    ev(at(4), R, 'review', 'passed', { axis: 'leaktoken', findings: [], tokens: 70, harness: 'claude-code' }),
    ev(at(5), R, 'review', 'passed', { axis: 'code', findings: [], tokens: 30, harness: 'claude-code' }),
  ];
  fs.writeFileSync(log(), keys.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const pub = artifact(), m = JSON.parse(pub.match(/<script type="application\/json" id="data">([^<]*)<\/script>/)[1]).metricsLog[''][''];
  for (const raw of ['/opt/models', home]) assert.ok(!pub.includes(raw), raw); // the runs' own burn maps too
  assert.doesNotMatch(pub, /"leaktoken"\s*:/); // as a key; the axis name stays as a value (an event's axis)
  assert.deepEqual(Object.fromEntries(Object.entries(m.byModel).map(([k, c]) => [k, c.tokens])), { '[local path]': 300, 'qwen/qwen3-coder': 50 });
  assert.deepEqual(Object.fromEntries(Object.entries(m.byAxis).map(([k, c]) => [k, c.tokens])), { '[redacted]': 70, code: 30 });
});
