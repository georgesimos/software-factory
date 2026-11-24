// @ts-nocheck
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { HERE } from '../factory.mjs';
import { io, read } from '../../core/src/log.ts';
import { RULES, checkRules, isDay, setRule, unsetRule } from '../../core/src/rules.ts';
import { setup } from './setup.mjs';

setup();
// #52: typing rules.ts showed RULES[k] and `k in` reach Object.prototype, and isDay() take a one-string array.
test('rule names are own keys only, and until is a YYYY-MM-DD string', () => {
  io.gh = path.join(HERE, 'test', 'gh-stub.mjs');
  const ok = { value: 'skip', reason: 'x', setBy: 'me', setAt: '2026-01-01T00:00:00Z' };
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.throws(() => checkRules(JSON.parse(`{"${k}":${JSON.stringify(ok)}}`), 'rules'), new RegExp(`unknown rule "${k}"`), k); // was a TypeError
    assert.throws(() => setRule('acme/own', k, 'x', { reason: 'x' }), /unknown rule/, k);
  }
  assert.ok(Object.hasOwn(RULES, 'ci'));
  assert.throws(() => unsetRule('acme/own', 'constructor', { reason: 'x' }), /no rule "constructor" set for acme\/own/); // was an audited no-op
  assert.throws(() => unsetRule('acme/own', 'guide.toString'), /no guidance "guide.toString"/);
  assert.equal(read().filter((e) => e.stage === 'rules').length, 0);
  assert.equal(isDay('2999-01-01'), true);
  for (const d of [['2999-01-01'], { toString: () => '2999-01-01' }, 29990101, '', undefined]) assert.equal(isDay(d), false, JSON.stringify(d));
  assert.throws(() => checkRules({ ci: { ...ok, until: ['2999-01-01'] } }, 'rules'), /until must be YYYY-MM-DD/);
  assert.throws(() => setRule('acme/own', 'ci', 'skip', { reason: 'x', until: ['2999-01-01'] }), /--until must be YYYY-MM-DD/);
});
