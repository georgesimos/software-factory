// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { HERE } from '../factory.mjs';
import { derive } from '../../core/src/derive.ts';
import { archive, io, read, readArchive, record } from '../../core/src/log.ts';
import { runsData } from '../../server/src/server.ts';
import { setup } from './setup.mjs';

// F note / F notes (#16): the user's one-shot note for a step, handed out once, never seen by the gate.
setup();
test('notes: record, hand out once, next, loop-back, refusals, races, invisible to the run', async () => {
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-note-'));
  const cli = (args, input) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args],
    { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: path.join(HERE, 'test', 'gh-stub.mjs') } });
  const cliAsync = async (args) => JSON.parse((await promisify(execFile)(process.execPath, [path.join(HERE, 'factory.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, FACTORY_DIR: io.dir } })).stdout);
  const R = 'acme/note#1', note = (step, text) => JSON.parse(cli(['note', R, step, '-'], text)), take = (...s) => JSON.parse(cli(['notes', R, ...s]));
  const strip = ({ events, notes, ...x }) => x, same = () => assert.deepEqual(strip(derive(read())[R]), strip(derive(read().filter((e) => e.stage !== 'note'))[R]));
  assert.throws(() => note('build', 'x'), /no run acme\/note#1/);
  assert.throws(() => cli(['note', '__proto__', 'build', '-'], 'x'), /no run __proto__/); // a built-in key is not a run
  assert.deepEqual(take('intake'), {}); // a new issue has no run before intake: nothing pending, nothing recorded
  assert.deepEqual(JSON.parse(cli(['notes', 'constructor', 'build'])), {});
  assert.equal(read().length, 0);
  cli(['event', R, 'intake', 'passed']);
  cli(['event', R, 'spec', 'awaiting-approval', '-'], '{"spec":"s","reasons":["sensitive"]}');
  const n = note('build', '  use the existing helper\n');
  assert.deepEqual([n.step, n.text, n.by, n.warning], ['build', 'use the existing helper', 'stub-user', undefined]); // who is gh's login, never typed
  assert.match(n.id, /^n-[0-9a-f-]{36}$/); // unique, so a CLI and an F ui write at once can't collide
  assert.deepEqual([derive(read())[R].outcome, derive(read())[R].stage], ['awaiting-approval', 'spec']); // a note never un-parks a run
  same();
  for (const [s, t, re] of [['*', 'x', /not one step/], ['deploy', 'x', /not one step/], ['review.Bad', 'x', /not one step/], ['build,spec', 'x', /not one step/],
    ['build', '  \n', /1-1000/], ['build', 'x'.repeat(1001), /1-1000/]]) assert.throws(() => note(s, t), re);
  assert.equal(note('build', 'y'.repeat(1000)).text.length, 1000); // the cap itself is allowed
  assert.throws(() => note('review.perf', 'x'), /not an axis of acme\/note/); // an extra axis must be configured
  cli(['skills', 'set', 'acme/note', 'axes.extra', JSON.stringify([{ axis: 'perf', when: ['src/**'], use: 'skill', name: 'perf-review' }])]);
  assert.throws(() => note('intake', 'reread the thread'), /intake already ran for acme\/note#1 and won't run again/); // nothing would read it
  assert.throws(() => take('review.nope'), /notes: review\.nope is not an axis/); // F notes checks axes like F note
  assert.throws(() => cli(['note', R, 'build'], 'x'), /usage: note/);
  assert.throws(() => take(), /usage: notes/);
  assert.throws(() => take('next'), /not one step/);
  assert.throws(() => cli(['event', R, 'note', 'pending', '-'], '{"step":"build","text":"x"}'), /recorded by "note"/);
  assert.throws(() => cli(['event', R, 'note', 'applied']), /recorded by "note"/);
  cli(['event', R, 'spec', 'passed', '-'], '{"approvedBy":"o"}');
  cli(['event', R, 'build', 'started']);
  assert.match(note('spec', 'only if we loop back').warning, /spec already ran: the note is handed out only if a gate loops back to it, so it may never be used/);
  note('next', 'keep it small');
  assert.deepEqual(take('build'), { build: ['use the existing helper', 'y'.repeat(1000), 'keep it small'] }); // its own notes plus "next"; spec's waits
  note('review.perf', 'profile the hot path');
  assert.deepEqual(take('build'), {}); // handed out once
  note('next', 'check the docs');
  assert.deepEqual(take('review.code', 'review.security', 'review.perf'), { 'review.code': ['check the docs'], 'review.security': ['check the docs'], 'review.perf': ['profile the hot path', 'check the docs'] }); // "next": every step starting together
  assert.deepEqual(take('spec'), { spec: ['only if we loop back'] }); // a finished step's note: only when a gate loops back to it
  assert.deepEqual(take('spec'), {});
  // Two steps starting at once (separate processes, no lock): each one-shot note goes to exactly one of them.
  for (let i = 0; i < 5; i++) note('next', `race ${i}`);
  const got = (await Promise.all(['review.code', 'review.security', 'review.docs', 'verifier'].map((s) => cliAsync(['notes', R, s])))).flatMap((o) => Object.values(o).flat());
  assert.deepEqual(got.sort(), [0, 1, 2, 3, 4].map((i) => `race ${i}`));
  const two = [{ run: R, stage: 'intake', status: 'passed' }, { run: R, stage: 'note', status: 'pending', id: 'a', step: 'build', text: 'x' },
    { run: R, stage: 'note', status: 'applied', claim: 'c1', notes: ['a'], steps: ['build'] }, { run: R, stage: 'note', status: 'applied', claim: 'c2', notes: ['a'], steps: ['build'] }];
  assert.equal(derive(two)[R].notes[0].claim, 'c1'); // the first claim in the log wins; the later one gets nothing
  const r = derive(read())[R];
  assert.deepEqual(r.notes.slice(0, 6).map((x) => [x.step, x.text.slice(0, 20), x.state, x.appliedTo]), [['build', 'use the existing hel', 'applied', ['build']],
    ['build', 'y'.repeat(20), 'applied', ['build']], ['spec', 'only if we loop back', 'applied', ['spec']],
    ['next', 'keep it small', 'applied', ['build']], ['review.perf', 'profile the hot path', 'applied', ['review.perf']], ['next', 'check the docs', 'applied', ['review.code', 'review.security', 'review.perf']]]);
  assert.equal(new Set(r.notes.map((x) => x.id)).size, r.notes.length);
  assert.ok(read().filter((e) => e.stage === 'note').every((e) => !('sessionId' in e))); // no session: measured burn never sees a note
  assert.equal(r.stage, 'build');
  assert.deepEqual(runsData(read()).find((x) => x.id === R).events.filter((e) => e.stage === 'note').map((e) => e.status), read().filter((e) => e.stage === 'note' && e.run === R).map((e) => e.status)); // the dashboard timeline's "note · pending|applied" rows
  assert.doesNotThrow(() => derive([{ run: '__proto__', stage: 'note', status: 'pending', id: 'n1', step: 'build', text: 'x' }])); // a hand-edited log line can't break derive()
  same(); // stage, clock, burn, reviews: identical without the notes, so gate and decide can't see them
  record('acme/note#2', 'intake', 'started', { imported: true });
  assert.throws(() => cli(['note', 'acme/note#2', 'build', '-'], 'x'), /imported/);
  cli(['event', R, 'approve', 'escalated']);
  assert.throws(() => note('build', 'x'), /is escalated/);
  // Archiving keeps the run's last five non-note events, so a run full of notes still shows how it ended.
  assert.equal(archive(-1).archived >= 1, true);
  const a = readArchive().find((x) => x.id === R);
  assert.ok(a.events.every((e) => e.stage !== 'note'));
  assert.equal(a.notes, undefined); // nor the note texts
  assert.deepEqual(a.events.at(-1).stage + ' ' + a.events.at(-1).status, 'approve escalated');
});

// "Already ran" is read from the events each step records: the verifier's usage record, postmerge after "approve merged".
test('notes: verifier and postmerge map to their own events', () => {
  io.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-note-'));
  const cli = (args, input) => execFileSync(process.execPath, [path.join(HERE, 'factory.mjs'), ...args],
    { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FACTORY_DIR: io.dir, FACTORY_GH: path.join(HERE, 'test', 'gh-stub.mjs') } });
  const R = 'acme/note#3', note = (step) => JSON.parse(cli(['note', R, step, '-'], 'x'));
  cli(['event', R, 'intake', 'needs-info', '-'], '{"questions":["which page?"]}');
  assert.equal(note('intake').warning, undefined); // parked on needs-info: intake will run again, so the note is kept
  assert.equal(note('verifier').warning, undefined);
  cli(['event', R, 'review', 'passed', '-'], '{"role":"verifier","tokens":10}');
  assert.match(note('verifier').warning, /verifier already ran/);
  assert.equal(note('postmerge').warning, undefined); // not merged yet
});
