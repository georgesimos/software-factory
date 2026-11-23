// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { HERE } from '../factory.mjs';
import { derive } from '../../core/src/derive.ts';
import { io, read, record } from '../../core/src/log.ts';
import { setup } from './setup.mjs';

// F note / F notes (#16): the user's one-shot note for a step, handed out once, never seen by the gate.
setup();
test('notes: record, hand out once, next, loop-back, refusals, invisible to the run', () => {
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-note-'));
  const cli = (args, input) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args],
    { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: path.join(HERE, 'test', 'gh-stub.mjs') } });
  const R = 'acme/note#1', note = (step, text) => JSON.parse(cli(['note', R, step, '-'], text)), take = (...s) => JSON.parse(cli(['notes', R, ...s]));
  const strip = ({ events, notes, ...x }) => x, same = () => assert.deepEqual(strip(derive(read())[R]), strip(derive(read().filter((e) => e.stage !== 'note'))[R]));
  assert.throws(() => note('build', 'x'), /no run acme\/note#1/);
  assert.throws(() => cli(['note', '__proto__', 'build', '-'], 'x'), /no run __proto__/); // a built-in key is not a run
  assert.throws(() => cli(['notes', 'constructor', 'build']), /no run constructor/);
  cli(['event', R, 'intake', 'passed']);
  cli(['event', R, 'spec', 'awaiting-approval', '-'], '{"spec":"s","reasons":["sensitive"]}');
  const n = note('build', '  use the existing helper\n');
  assert.deepEqual([n.id, n.step, n.text, n.by], ['n1', 'build', 'use the existing helper', 'stub-user']); // who is gh's login, never typed
  assert.deepEqual([derive(read())[R].outcome, derive(read())[R].stage], ['awaiting-approval', 'spec']); // a note never un-parks a run
  same();
  for (const [s, t, re] of [['*', 'x', /not one step/], ['deploy', 'x', /not one step/], ['review.Bad', 'x', /not one step/], ['build,spec', 'x', /not one step/],
    ['build', '  \n', /1-1000/], ['build', 'x'.repeat(1001), /1-1000/]]) assert.throws(() => note(s, t), re);
  assert.equal(note('build', 'y'.repeat(1000)).text.length, 1000); // the cap itself is allowed
  assert.throws(() => cli(['note', R, 'build'], 'x'), /usage: note/);
  assert.throws(() => take(), /usage: notes/);
  assert.throws(() => take('next'), /not one step/);
  assert.throws(() => cli(['event', R, 'note', 'pending', '-'], '{"step":"build","text":"x"}'), /recorded by "note"/);
  assert.throws(() => cli(['event', R, 'note', 'applied']), /recorded by "note"/);
  cli(['event', R, 'spec', 'passed', '-'], '{"approvedBy":"o"}');
  cli(['event', R, 'build', 'started']);
  note('spec', 'tighter criteria');
  note('next', 'keep it small');
  assert.deepEqual(take('build'), { build: ['use the existing helper', 'y'.repeat(1000), 'keep it small'] }); // its own notes plus "next"; spec's waits
  assert.deepEqual(take('build'), {}); // handed out once
  note('next', 'check the docs');
  assert.deepEqual(take('review.code', 'review.security'), { 'review.code': ['check the docs'], 'review.security': ['check the docs'] }); // "next": every step starting together
  assert.deepEqual(take('spec'), { spec: ['tighter criteria'] }); // a finished step's note: only when a gate loops back to it
  assert.deepEqual(take('spec'), {});
  const r = derive(read())[R];
  assert.deepEqual(r.notes.map((x) => [x.id, x.step, x.state, x.appliedTo]), [['n1', 'build', 'applied', ['build']], ['n2', 'build', 'applied', ['build']],
    ['n3', 'spec', 'applied', ['spec']], ['n4', 'next', 'applied', ['build']], ['n5', 'next', 'applied', ['review.code', 'review.security']]]);
  assert.deepEqual(r.events.filter((e) => e.stage === 'note').map((e) => e.status), ['pending', 'pending', 'pending', 'pending', 'applied', 'pending', 'applied', 'applied']); // the timeline rows
  assert.ok(read().filter((e) => e.stage === 'note').every((e) => !('sessionId' in e))); // no session: measured burn never sees a note
  assert.equal(r.stage, 'build');
  same(); // stage, clock, burn, reviews: identical without the notes, so gate and decide can't see them
  record('acme/note#2', 'intake', 'started', { imported: true });
  assert.throws(() => cli(['note', 'acme/note#2', 'build', '-'], 'x'), /imported/);
  cli(['event', R, 'approve', 'escalated']);
  assert.throws(() => note('build', 'x'), /is escalated/);
});
