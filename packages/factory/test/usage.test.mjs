// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archive, io, log, read, record } from '../../core/src/log.ts';
import { budget, derive, getRun } from '../../core/src/derive.ts';
import { decide } from '../../core/src/gate.ts';
import { facts } from '../../core/src/github.ts';
import { main } from '../../cli/src/main.ts';
import { usageFile } from '../../core/src/burn.ts';
import { costOf } from '../../core/src/constants.ts';
import { test } from 'node:test';
import { setup } from './setup.mjs';

// Measured burn from a fake transcript: attribution windows, dedupe, subagent axes, unknown model, cache, bad usage.
export function usageTest() {
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-usage-'));
  io.projects = path.join(io.dir, 'projects');
  const sid = 'sess-u', R = 'acme/u#1', t0 = Date.parse('2026-11-21T10:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const P = 'acme/u#0', I = 'acme/u:dev/x'; // an earlier in-progress run, and an imported run synced after R ended
  const evs = [[-80, 'intake', 'started', {}, P], [0, 'intake', 'started'], [100, 'intake', 'passed'], [200, 'spec', 'passed'], [300, 'build', 'started'], [400, 'build', 'passed'],
    [500, 'review', 'started', { axes: ['code'] }], [600, 'review', 'passed', { axis: 'code', findings: [], tokens: 5000 }], [700, 'gate', 'passed'], [800, 'approve', 'escalated'],
    [850, 'intake', 'started', { imported: true }, I], [850, 'intake', 'passed', {}, I], [850, 'build', 'started', {}, I]];
  fs.writeFileSync(log(), evs.map(([s, stage, status, p, run = R]) => JSON.stringify({ ts: at(s), ...p, harness: 'claude-code', sessionId: sid, cwd: '/w/u', run, stage, status })).join('\n') + '\n');
  const u = (input, output, read = 0, w1 = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: w1 } });
  const msg = (s, id, model, usage) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { id, model, content: [{ type: 'text', text: 'secret prompt' }], usage } }) + '\n';
  const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const main = path.join(io.projects, '-w-u', `${sid}.jsonl`), subs = path.join(io.projects, '-w-u', sid, 'subagents');
  put(main, [
    msg(-300, 'mx', 'claude-opus-5-5', u(4242, 0)), // before the session's first event: not factory work
    msg(-50, 'm0', 'claude-opus-5-5', u(1000, 0)), // after P's "intake started": P
    msg(50, 'm1', 'claude-opus-5-5', u(1_000_000, 0)), // after "intake started": intake, $4
    msg(150, 'm2', 'claude-opus-5-5', u(0, 100_000)), // intake passed -> spec passed: spec, $2
    msg(250, 'm3', 'claude-opus-5-5', u(0, 0, 1_000_000, 1_000_000)), // spec passed -> build started: build, $0.20 + $8
    msg(350, 'm4', 'claude-mystery-9', u(500, 500)), // unknown model: tokens, no cost
    msg(350, 'm4', 'claude-mystery-9', u(500, 500)), // streamed duplicate
    msg(360, 'm5', 'claude-opus-5-5', { ...u(0, 0), iterations: [{ type: 'message' }, { type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 100_000 }] }), // $0.80 of Fable
    msg(900, 'm6', 'claude-opus-5-5', u(7777, 0)), // after the imported run's "build started": not factory work
    '{"type":"user","message":{"content":"secret prompt","usage":1}}\n',
    '{"type":"assistant","usage":', // half-written line
  ].join(''));
  put(path.join(subs, 'agent-a.meta.json'), '{"description":"Code review acme/u#1"}');
  put(path.join(subs, 'agent-a.jsonl'), msg(520, 's1', 'claude-sonnet-5-5', u(0, 100_000)) + msg(650, 's2', 'claude-sonnet-5-5', u(100_000, 0))); // whole file: review
  put(path.join(subs, 'agent-b.meta.json'), '{"description":"Verify blocking findings"}');
  put(path.join(subs, 'agent-b.jsonl'), msg(560, 'v1', 'claude-sonnet-5-5', u(0, 10_000)));
  put(path.join(subs, 'agent-c.jsonl'), msg(570, 'o1', 'claude-sonnet-5-5', u(10_000, 0))); // no meta: "other"
  const b = getRun(R).burn;
  assert.equal(b.measured, true);
  assert.deepEqual(Object.fromEntries(Object.entries(b.byStage).map(([k, c]) => [k, [c.tokens, c.costUsd]])),
    { intake: [1_000_000, 4], spec: [100_000, 2], build: [2_101_000, 9], review: [220_000, 1.32] });
  assert.deepEqual([b.total.tokens, b.total.costUsd, b.total.cacheRead, b.total.unpriced], [3_421_000, 16.32, 1_000_000, 1000]);
  assert.deepEqual(Object.fromEntries(Object.entries(b.byIteration).map(([k, c]) => [k, c.tokens])), { 0: 1_100_000, 1: 2_321_000 });
  assert.deepEqual(Object.fromEntries(Object.entries(b.byAxis).map(([k, c]) => [k, c.tokens])), { code: 200_000, verifier: 10_000, other: 10_000 });
  assert.equal(b.reported.tokens, 5000);
  // What served each step, per model id: the dashboard shows the top one next to the configured model.
  assert.deepEqual(b.byStage.build.models, { 'claude-opus-5-5': 2_000_000, 'claude-mystery-9': 1000, 'claude-fable-5-2': 100_000 });
  assert.deepEqual([b.byAxis.code.models, b.byAxis.verifier.models], [{ 'claude-sonnet-5-5': 200_000 }, { 'claude-sonnet-5-5': 10_000 }]);
  assert.equal(getRun(P).burn.total.tokens, 1000);
  assert.equal(getRun(I).burn, undefined);
  assert.ok(!fs.readFileSync(usageFile(), 'utf8').includes('secret prompt'));
  const facts = { checks: 'pass', additions: 1, deletions: 0, files: ['a.md'] };
  assert.match(decide({ ...getRun(R), association: 'OWNER', pr: 'x' }, facts).reasons.join(), /budget exceeded \(\$16\.32, .* measured\)/);
  // Appended lines are read incrementally; a deleted transcript keeps its measured rows.
  fs.appendFileSync(main, '{"type":"assistant","usage":1}\n' + msg(380, 'm7', 'claude-opus-5-5', u(0, 50_000)));
  assert.equal(getRun(R).burn.byStage.build.costUsd, 10);
  assert.equal(costOf('claude-fable-5-2', [0, 0, 1e6, 0, 0]), 0.2); // Fable cache reads list at $0.20/MTok (#15)
  assert.equal(costOf('claude-fable-5-2', [1e6, 1e6, 1e6, 1e6, 1e6]).toFixed(2), '74.20'); // 8 + 40 + 0.2 + 10 + 16
  fs.rmSync(main);
  assert.equal(getRun(R).burn.total.tokens, 3_471_000);
  // Caps: measured dollars win over tokens; without a price, cache reads don't count toward the token cap.
  const m = (tokens, cacheRead, costUsd) => budget({ burn: { measured: true, total: { tokens, cacheRead, costUsd } } }).over;
  assert.equal(m(9e6, 8.9e6, 1), false);
  assert.equal(m(5e6, 1e6, null), true);
  assert.equal(m(5e6, 4.5e6, null), false);
  // Usage payloads are validated; tokens becomes their sum.
  assert.equal(record(R, 'build', 'passed', { usage: { input: 10, output: 5 }, model: 'claude-opus-5-5' }).tokens, 15);
  for (const [p, re] of [[{ usage: { input: -1 } }, /non-negative integer/], [{ usage: { input: 1.5 } }, /non-negative integer/], [{ usage: { prompt: 'x' } }, /unknown fields: prompt/],
    [{ usage: [1] }, /must be an object/], [{ model: 'x'.repeat(65) }, /short model id/], [{ model: 'a b' }, /short model id/], [{ tokens: '9' }, /tokens must be/]]) assert.throws(() => record(R, 'build', 'passed', p), re);
  record(R, 'review', 'passed', { role: 'verifier', tokens: 10, model: 'claude-sonnet-5-5' });
  assert.deepEqual(derive(read())[R].burn.byAxis.verifier.models, { 'claude-sonnet-5-5': 10 }); // reported usage: the payload's model
  assert.throws(() => record(R, 'review', 'passed', { role: 'judge' }), /role must be/);
  assert.throws(() => record(R, 'review', 'passed', { role: 'verifier', findings: [] }), /unknown fields: findings/);
  assert.equal(derive(read())[R].burn.byAxis.verifier.tokens, 10);
  // Archiving R drops its events; its stubs keep its messages from falling to P, the session's earlier run.
  assert.equal(archive(0).archived, 1);
  assert.equal(getRun(P).burn.total.tokens, 1000);
  assert.equal(getRun(R).burn.total.tokens, 3_471_000); // from the archive summary
  io.projects = null;
}

setup();
test('measured burn from transcripts', usageTest);
