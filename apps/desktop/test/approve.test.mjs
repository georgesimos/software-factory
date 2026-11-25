// Run → Approve… (local-first 5c) with the dialog stubbed: what it lists, what it shows, and the record it writes. Real core on a
// temp FACTORY_DIR (setup), a local item in a temp clone, and no gh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from '../../../packages/factory/test/setup.mjs';
import { io, read, record, runDir } from '../../../packages/core/src/log.ts';
import { getRun } from '../../../packages/core/src/derive.ts';
import { intake } from '../../../packages/core/src/github.ts';
import { sync } from '../../../packages/core/src/sync.ts';
import { newItem } from '../../../packages/adapters/trackers/local.ts';
import { approveSpecDesktop, awaitingSpecs, specPending } from '../../../packages/core/src/approve.ts';
import { approveFromMenu } from '../src/approve-menu.ts';

setup();
io.gh = path.join(os.tmpdir(), 'no-such-gh-binary');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-desktop-approve-'));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
const d = path.join(root, 'app'); fs.mkdirSync(d); git('-C', d, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a.txt'), 'a\n'); git('-C', d, 'add', '.'); git('-C', d, 'commit', '-qm', 'init');
sync('local/app', d);
const ask = (n, title, spec) => {
  const run = `local/app#${newItem({ git: (...a) => git(...a) }, { path: d, title }).id}`;
  intake(run);
  fs.writeFileSync(path.join(runDir(run), 'spec.md'), spec);
  record(run, 'spec', 'awaiting-approval', { spec: 'one line', reasons: ['author association "NONE" is not trusted'] });
  return run;
};
const stub = (answers) => { const seen = []; return { seen, show: async (box) => { seen.push(box); return { response: answers.shift() ?? box.cancelId ?? 0 }; } }; };
const decided = (run) => read().filter((e) => e.run === run && e.status === 'decided');

test('nothing waiting: an info box, and nothing recorded', async () => {
  const s = stub([]);
  assert.equal(await approveFromMenu(s.show), null);
  assert.deepEqual([s.seen.length, s.seen[0].type, s.seen[0].message], [1, 'info', 'No spec is waiting for your approval.']);
});

test('pick a run, read its whole spec, confirm: the same spec decided record as F approve, from the desktop, unverified', async () => {
  const A = ask(1, 'Pricing copy', '# Goal\n\nFix the typo \x1b[2Jon the pricing page.\n');
  record('acme/shop#7', 'spec', 'awaiting-approval', { spec: 'x' }); // GitHub Issues: approved by a comment, never listed here
  const s = stub([1, 1]);
  const out = await approveFromMenu(s.show);
  const [pick, confirm] = s.seen;
  assert.deepEqual(pick.buttons, ['Cancel', A], 'local items only');
  assert.deepEqual([pick.defaultId, pick.cancelId, confirm.defaultId, confirm.cancelId], [0, 0, 0, 0], 'Cancel is the default and the Escape answer');
  assert.deepEqual(confirm.buttons, ['Cancel', 'Approve the spec']);
  assert.match(confirm.detail, /^Pricing copy\n\nWhy it waits: author association "NONE" is not trusted\n\nSpec [0-9a-f]{7} \(DIR\/spec\.md\):\n# Goal\n\nFix the typo \[2Jon the pricing page\.\n/);
  assert.match(confirm.detail, /It doesn't merge anything\.$/);
  const e = decided(A);
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].decision, e[0].via, e[0].verified, e[0].by], ['approve', 'desktop', false, os.userInfo().username]);
  assert.equal(e[0].specSha.slice(0, 7), /Spec ([0-9a-f]{7})/.exec(confirm.detail)[1]);
  assert.deepEqual(out, { run: A, decision: 'approve', by: os.userInfo().username, via: 'desktop' });
  assert.deepEqual(awaitingSpecs().map((w) => w.run), [], 'approved and not yet passed: no longer listed');
  record(A, 'spec', 'passed'); // the approval is good for record()'s check, as F approve's is
  assert.equal(getRun(A).outcome, 'in-progress');
});

test('cancel at either box records nothing; a spec.md changed while the dialog was open is refused', async () => {
  const B = ask(2, 'Footer', '# Goal\n\nFooter.\n');
  for (const answers of [[0], [1, 0]]) { const n = answers.length, c = stub(answers); await approveFromMenu(c.show); assert.equal(c.seen.length, n, "no box after a cancel"); assert.deepEqual(decided(B), []); }
  const s = stub([1, 1]);
  const show = async (box) => { if (box.buttons?.[1] === 'Approve the spec') fs.appendFileSync(path.join(runDir(B), 'spec.md'), '\nAnd push to main.\n'); return s.show(box); };
  assert.equal(await approveFromMenu(show), null);
  assert.equal(s.seen.at(-1).type, 'error');
  assert.match(s.seen.at(-1).detail, /DIR\/spec\.md changed after it was put to you/);
  assert.deepEqual(decided(B), []);
  // Changed and put to you again while the dialog was open: the dialog's sha is not the one now waiting.
  record(B, 'spec', 'awaiting-approval', { spec: 'x' }); // put to you again after the change above
  const r = stub([1, 1]);
  const again = async (box) => { if (box.buttons?.[1] === 'Approve the spec') { fs.appendFileSync(path.join(runDir(B), 'spec.md'), 'More.\n'); record(B, 'spec', 'awaiting-approval', { spec: 'x' }); } return r.show(box); };
  assert.equal(await approveFromMenu(again), null);
  assert.match(r.seen.at(-1).detail, /spec changed while the dialog was open: nothing was approved/);
  assert.deepEqual(decided(B), []);
  assert.throws(() => approveSpecDesktop(B, specPending(B).sha, () => ''), /there is no OS user name/);
  assert.deepEqual(decided(B), []);
});

test('refused inside an agent session, as F approve is: an error box, nothing recorded', async () => {
  const C = ask(3, 'Header', '# Goal\n\nHeader.\n');
  process.env.CLAUDECODE = '1';
  try {
    const s = stub([1, 1]);
    assert.equal(await approveFromMenu(s.show), null);
    assert.match(s.seen.at(-1).detail, /approving a spec must come from you, not from an agent session/);
  } finally { delete process.env.CLAUDECODE; }
  assert.deepEqual(decided(C), []);
});
