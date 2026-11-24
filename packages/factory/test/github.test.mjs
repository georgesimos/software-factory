// @ts-nocheck
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalVote, postmerge, revert } from '../../core/src/github.ts';
import { io, record } from '../../core/src/log.ts';
import { setup } from './setup.mjs';

setup();
test('spec approval counts only a trusted comment from a later second than the wait started, compared as times', () => {
  const c = (created_at, body = '/factory approve', association = 'OWNER') => ({ author: 'acme', association, created_at, body });
  const since = '2026-11-23T10:00:00.900Z'; // F's ms stamp; GitHub's are whole seconds
  // "…:00Z" sorts after "…:00.900Z" as a string, but was posted up to 900 ms before the wait began: it never saw this spec.
  assert.deepEqual(approvalVote([c('2026-11-23T10:00:00Z')], since), { decision: 'waiting' });
  assert.deepEqual(approvalVote([c('2026-11-23T09:59:59Z')], since), { decision: 'waiting' });
  assert.deepEqual(approvalVote([c('2026-11-23T10:00:01Z')], since), { decision: 'approve', by: 'acme' });
  assert.deepEqual(approvalVote([c('2026-11-23T10:00:01Z'), c('2026-11-23T10:00:02Z', '/factory reject')], since), { decision: 'reject', by: 'acme' }); // the latest wins
  assert.deepEqual(approvalVote([c('2026-11-23T10:00:00Z')], '2026-11-23T10:00:00.000Z'), { decision: 'waiting' }); // same second, even at .000
  assert.deepEqual(approvalVote([c('2026-11-23T10:00:05Z', '/factory approve', 'NONE'), c('not a date')], since), { decision: 'waiting' });
});

test('postmerge and revert on a run with no recorded PR say so, without asking gh about "undefined"', () => {
  const gh = io.gh;
  io.gh = '/nonexistent/gh'; // any gh call would throw
  try {
    record('acme/app#9', 'intake', 'started', { title: 't' });
    assert.deepEqual(postmerge('acme/app#9'), { state: 'no-pr', reason: 'no PR recorded for this run' });
    assert.throws(() => revert('acme/app#9', 'red'), /^Error: no PR recorded for this run$/);
  } finally { io.gh = gh; }
});
