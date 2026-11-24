// @ts-nocheck
// Local-first PR 4a: GitHub's change requests moved behind hosts/github.ts. Same gh calls, same results, same scrub.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as github from '../../adapters/hosts/github.ts';
import * as issues from '../../adapters/trackers/github-issues.ts';
import { SECRET } from '../../server/src/server.ts';

const logged = (answers) => { const calls = []; return { calls, gh: (...a) => { calls.push(a); const s = a.join(' '); for (const [k, v] of answers) if (s.startsWith(k)) return typeof v === 'string' ? v : JSON.stringify(v); throw new Error(`unexpected gh ${s}`); } }; };

test('the GitHub host makes exactly the gh calls core made before the move', () => {
  const q = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){defaultBranchRef{name} pullRequests(states:OPEN,first:100){nodes{number url title headRefName headRefOid authorAssociation author{login} closingIssuesReferences(first:20){nodes{number}}}} done: pullRequests(states:[MERGED,CLOSED],last:100){nodes{headRefName}}}}';
  const pr = { number: 5, url: 'https://github.com/acme/app/pull/5', title: 'Fix #3', headRefName: 'dev/x', headRefOid: 'a'.repeat(40), authorAssociation: 'OWNER', author: { login: 'acme' }, closingIssuesReferences: { nodes: [{ number: 3 }] } };
  const l = logged([['api graphql', { data: { repository: { defaultBranchRef: { name: 'main' }, pullRequests: { nodes: [pr, { ...pr, number: 6, author: null, closingIssuesReferences: { nodes: [] } }] }, done: null } } }]]);
  assert.deepEqual(github.listChangeRequests({ gh: l.gh }, { repo: 'acme/app' }), {
    base: 'main', doneBranches: [], open: [
      { id: '5', url: pr.url, title: 'Fix #3', branch: 'dev/x', headSha: 'a'.repeat(40), closes: ['3'], author: 'acme', association: 'OWNER' },
      { id: '6', url: pr.url, title: 'Fix #3', branch: 'dev/x', headSha: 'a'.repeat(40), closes: [], author: undefined, association: 'OWNER' }] });
  assert.deepEqual(l.calls, [['api', 'graphql', '-f', `query=${q}`, '-f', 'o=acme', '-f', 'n=app']]);
  const v = logged([['pr view', { state: 'MERGED', mergedAt: '2026-11-20T00:00:00Z', mergedBy: { login: 'octo' }, mergeCommit: { oid: 'f'.repeat(40) }, headRefName: 'factory/issue-3', isCrossRepository: false }]]);
  assert.deepEqual(github.changeRequest({ gh: v.gh }, { repo: 'acme/app', id: '9' }), { state: 'merged', approval: null, branch: 'factory/issue-3', fork: false, mergedAt: '2026-11-20T00:00:00Z', mergedBy: 'octo', mergeSha: 'f'.repeat(40) });
  assert.deepEqual(v.calls, [['pr', 'view', '9', '-R', 'acme/app', '--json', 'state,mergedAt,mergedBy,mergeCommit,headRefName,isCrossRepository']]);
  assert.equal(github.changeRequest({ gh: logged([['pr view', { state: 'DRAFT?', headRefName: 'x' }]]).gh }, { repo: 'acme/app', id: '9' }).state, 'unknown');
  const m = logged([['pr ready', ''], ['pr merge', '']]);
  assert.deepEqual(github.merge({ gh: m.gh }, { repo: 'acme/app', id: pr.url, sha: 'abc123' }), { merged: true });
  assert.deepEqual(m.calls, [['pr', 'ready', pr.url, '-R', 'acme/app'], ['pr', 'merge', pr.url, '-R', 'acme/app', '--squash', '--delete-branch', '--match-head-commit', 'abc123']]);
  assert.throws(() => github.merge({ gh: () => { throw new Error('refused'); } }, { repo: 'acme/app', id: pr.url, sha: 'abc123' }), /refused/, 'a refusal still throws');
  const o = logged([['pr create', 'https://github.com/acme/app/pull/99\n']]);
  assert.deepEqual(github.openChangeRequest({ gh: o.gh }, { repo: 'acme/app', branch: 'factory/revert-3', base: 'main', title: 'Revert: x', body: 'b', labels: ['factory:needs-human'] }), { id: 'https://github.com/acme/app/pull/99', url: 'https://github.com/acme/app/pull/99' });
  assert.deepEqual(o.calls, [['pr', 'create', '-R', 'acme/app', '--base', 'main', '--head', 'factory/revert-3', '--title', 'Revert: x', '--body', 'b', '--label', 'factory:needs-human']]);
});

// Local-first PR 5a: intake's, facts()'s and approval()'s issue reads moved to trackers/github-issues.ts, same gh calls.
test('the GitHub tracker makes exactly the gh calls core made before the move', () => {
  const issue = { number: 3, pull_request: undefined, state: 'open', title: 'T', html_url: 'https://github.com/acme/app/issues/3', user: { login: 'rep' }, author_association: 'NONE', body: null };
  const g = logged([['api repos/acme/app/issues/3', issue]]);
  assert.deepEqual(issues.getItem({ gh: g.gh }, { repo: 'acme/app', id: '3' }), { id: '3', title: 'T', url: issue.html_url, author: 'rep', association: 'NONE', state: 'open', isChangeRequest: false, body: null });
  assert.equal(issues.getItem({ gh: logged([['api', { ...issue, pull_request: {} }]]).gh }, { repo: 'acme/app', id: '3' }).isChangeRequest, true);
  assert.deepEqual(g.calls, [['api', 'repos/acme/app/issues/3']]);
  const raw = [{ user: { login: 'rep' }, author_association: 'NONE', created_at: '2026-11-20T00:00:00Z', body: 'more', id: 9 }, { user: { login: 'o' }, author_association: 'OWNER', created_at: '2026-11-21T00:00:00Z', body: null }];
  const c = logged([['api --paginate', raw.map((x) => JSON.stringify(x)).join('\n') + '\n']]);
  assert.deepEqual(issues.comments({ gh: c.gh }, { repo: 'acme/app', id: '3' }), [
    { author: 'rep', association: 'NONE', created_at: '2026-11-20T00:00:00Z', body: 'more' }, { author: 'o', association: 'OWNER', created_at: '2026-11-21T00:00:00Z', body: null }]);
  assert.deepEqual(c.calls, [['api', '--paginate', 'repos/acme/app/issues/3/comments', '--jq', '.[]']]);
  const t = logged([['api', 'MEMBER\n']]);
  assert.equal(issues.trust({ gh: t.gh }, { repo: 'acme/app', id: '3' }), 'MEMBER');
  assert.deepEqual(t.calls, [['api', 'repos/acme/app/issues/3', '--jq', '.author_association']]);
});

test('server.ts\'s leak check and scrub come from the hosts, unchanged', () => {
  const before = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,}|sk-(?:ant-)?[\w-]{30,})|127\.0\.0\.1:\d+\/?\?t=[\w-]{20,}/;
  assert.deepEqual([SECRET.source, SECRET.flags], [before.source, before.flags]);
  assert.deepEqual([github.publicUrl.source, github.publicUrl.flags], [/(?:https?:\/\/)?(?:www\.)?github\.com[/:][^\s"\\,]*/gi.source, 'gi']);
});
