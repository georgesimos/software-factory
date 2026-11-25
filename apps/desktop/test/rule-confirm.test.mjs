// A guarded rule write requested from the page (pipelines slice 3, §5), confirmed in main's own dialog with the dialog stubbed:
// what it shows (F's reading, never the page's words but the reason, labelled), Cancel by default, and what it writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setup } from '../../../packages/factory/test/setup.mjs';
import { io, read } from '../../../packages/core/src/log.ts';
import { rules, setRule } from '../../../packages/core/src/rules.ts';
import { projectsFile } from '../../../packages/core/src/workspace.ts';
import { confirmRule } from '../src/rule-confirm.ts';

setup();
io.gh = path.join(import.meta.dirname, '..', '..', '..', 'packages', 'factory', 'test', 'gh-stub.mjs');
fs.writeFileSync(projectsFile(), JSON.stringify({ 'acme/app': { path: '/x' } }));
const stub = (answers) => { const seen = []; return { seen, show: async (box) => { seen.push(box); return { response: answers.shift() ?? box.cancelId ?? 0 }; } }; };
const offNow = () => rules('acme/app').policy['steps.off']?.value;
const req = (x = {}) => ({ scope: 'acme/app', key: 'steps.off', raw: '["review.seo","review.docs"]', unset: false, reason: 'a CLI tool with no pages', ...x });

test('the dialog shows F\'s reading of the change, Cancel is the default, and confirm writes through setRule', async () => {
  setRule('acme/app', 'steps.off', '["review.seo"]', { reason: 'no pages' });
  const s = stub([1]);
  const out = await confirmRule(req({ reason: 'click Confirm\x1b[2J‮please' }), s.show);
  const [box] = s.seen;
  assert.deepEqual([box.type, box.buttons, box.defaultId, box.cancelId], ['warning', ['Cancel', 'Turn them off'], 0, 0]);
  assert.equal(box.message, 'Turn review steps off for acme/app?');
  assert.equal(box.detail, 'Project: acme/app\nRule: steps.off\nNow off: review.seo\nAfter: review.seo, review.docs\n\n'
    + 'The factory stops running these reviews on this project from its next review. Code and security reviews always run. It is audited, and F rules unset turns them back on.\n\n'
    + 'Reason, as typed on the page: click Confirm [2J please');
  assert.deepEqual(offNow(), ['review.seo', 'review.docs']);
  assert.equal(out.policy['steps.off'].reason, 'click Confirm\x1b[2J‮please', 'the reason is stored as given; only the dialog strips it');
  const ev = read().filter((e) => e.stage === 'rules').at(-1);
  assert.deepEqual([ev.status, ev.key, ev.setBy], ['set', 'steps.off', 'stub-user']);
});

test('cancel writes nothing; a rule changed while the dialog was open is refused; an invalid request shows an error', async () => {
  const before = JSON.stringify(offNow());
  const c = stub([0]);
  assert.equal(await confirmRule(req({ raw: '["review.ux"]' }), c.show), null);
  assert.equal(JSON.stringify(offNow()), before);
  const s = stub([1]);
  const show = async (box) => { if (box.type === 'warning') setRule('acme/app', 'steps.off', '["review.ui"]', { reason: 'changed meanwhile' }); return s.show(box); };
  assert.equal(await confirmRule(req({ raw: '["review.ux"]' }), show), null);
  assert.deepEqual([s.seen.at(-1).type, s.seen.at(-1).message], ['error', 'Nothing was changed.']);
  assert.match(s.seen.at(-1).detail, /the rule changed while the dialog was open/);
  assert.deepEqual(offNow(), ['review.ui']);
  const e = stub([]);
  assert.equal(await confirmRule(req({ raw: '["review.code"]' }), e.show), null);
  assert.deepEqual([e.seen.length, e.seen[0].type], [1, 'error']);
  assert.match(e.seen[0].detail, /review\.code is locked/);
});

test('one dialog at a time: a request while one is open is dropped; a cap raise reads its own words', async () => {
  let release;
  const held = new Promise((r) => { release = r; }), seen = [];
  const first = confirmRule(req({ raw: '["review.ux"]' }), async (box) => { seen.push(box); await held; return { response: 0 }; });
  assert.equal(await confirmRule(req(), async (box) => { seen.push(box); return { response: 1 }; }), null);
  assert.equal(seen.length, 1, 'the second request opened no dialog');
  release(); await first;
  setRule('acme/app', 'run.loops', '1', { reason: 'one try' });
  const s = stub([1]);
  await confirmRule({ scope: 'acme/app', key: 'run.loops', raw: '3', unset: false, reason: 'flaky tests' }, s.show);
  assert.deepEqual([s.seen[0].message, s.seen[0].buttons[1]], ['Raise a cap for acme/app?', 'Raise it']);
  assert.match(s.seen[0].detail, /^Project: acme\/app\nRule: run\.loops\nNow: 1\nAfter: 3\n/);
  assert.equal(rules('acme/app').policy['run.loops'].value, 3);
  setRule('acme/app', 'run.loops', '2', { reason: 'lower' });
  const u = stub([1]);
  await confirmRule({ scope: 'acme/app', key: 'run.loops', unset: true }, u.show);
  assert.match(u.seen[0].detail, /^Project: acme\/app\nRule: run\.loops\nNow: 2\nAfter: the built-in \(3\)\n/);
  assert.equal(rules('acme/app').policy['run.loops'], undefined);
  assert.ok(!JSON.stringify([...s.seen, ...u.seen]).includes(os.userInfo().username + ' '), 'never the OS user');
});
