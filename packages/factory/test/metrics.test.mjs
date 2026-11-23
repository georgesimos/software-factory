// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { io, log } from '../../core/src/log.ts';
import { logMetrics } from '../../core/src/metrics.ts';
import { uiHandle } from '../../server/src/server.ts';
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
  assert.deepEqual(m.outcomes, { merged: 2, escalated: 1, rejected: 0, reverted: 1 });
  assert.equal(m.costPerMergedPrUsd, 4.56);
  assert.equal(m.loopsPerRun, 0.333); // one gate loop-back over three finished builds
  assert.equal(m.capHitShare, 0.667); // a#2 at the loop cap, a#1 over the $5 run budget
  assert.equal(m.medianIntakeToMergeMs, 86_400_000); // a#0's day; a#1's 23h ends at the merge, not the later revert
  assert.equal(m.measuredRuns, 1);
  // since: rows and outcomes by their own time; a#1's merge (11-21 09:00) counts, its 11-20 burn does not.
  const s = logMetrics(events, { measured, archive, since: '2026-11-21' });
  assert.deepEqual([s.total.tokens, s.total.source, Object.keys(s.byDay)], [6500, 'reported', ['2026-11-21']]);
  assert.deepEqual(s.outcomes, { merged: 1, escalated: 1, rejected: 0, reverted: 1 });
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
  assert.equal(logMetrics([]).total.costUsd, 0);
});

test('GET /api/metrics: token-gated, filtered, no paths or session ids', () => {
  io.projects = path.join(io.dir, 'projects'); // measure() looks for transcripts here: none, so the burn is reported
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
  io.projects = null;
});
