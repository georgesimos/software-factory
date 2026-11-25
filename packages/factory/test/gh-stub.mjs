#!/usr/bin/env node
import fs from 'node:fs';
import { command } from '../../core/src/platform.ts';
// Fake `gh` for factory.mjs self-tests. Answers only the calls the factory makes.
const args = process.argv.slice(2);
const a = args.join(' ');
const out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const head = (n) => String(n).padStart(40, '0'); // a PR's head sha
const pr = (number, headRefName, closes, title = `PR ${number}`) => ({
  number, headRefName, headRefOid: head(number), authorAssociation: 'OWNER', url: `https://github.com/acme/app/pull/${number}`,
  title, author: { login: 'acme' }, closingIssuesReferences: { nodes: closes.map((n) => ({ number: n })) },
});

if (a === 'api user --jq .login') out('stub-user\n');
else if (/^api repos\/[\w.-]+\/[\w.-]+\/deployments/.test(a)) { // GitHub Deployments, for the ship connector: one ready preview, on acme/app PR 10's head
  if (process.env.STUB_DEPLOY_FAIL) { process.stderr.write('HTTP 502: Bad Gateway'); process.exit(1); }
  const id = /deployments\/(\d+)\/statuses/.exec(a)?.[1], merge = process.env.STUB_MERGE_SHA;
  if (id) out([{ state: 'success', environment_url: `https://deploy-${id}.example.app`, description: 'Deployment has completed', created_at: '2026-11-22T10:00:00Z' }]);
  else if (a.endsWith('deployments?per_page=1')) out(/^api repos\/acme\/(app|wt)\//.test(a) ? [{ id: 1 }] : []);
  else if (a.includes(`sha=${head(10)}`)) out([{ id: 10, sha: head(10), environment: 'Preview – app', creator: { login: 'vercel[bot]' }, created_at: '2026-11-22T09:58:00Z' }]);
  else out(merge && a.includes(`sha=${merge}`) ? [{ id: 11, sha: merge, environment: 'Production – wt', creator: { login: 'vercel[bot]' }, created_at: '2026-11-22T09:58:00Z' }] : []);
}
else if (args[0] === 'repo' && args[1] === 'view') out('main\n');
else if (args[0] === 'pr' && args[1] === 'view' && a.includes('--json mergeCommit')) out({ mergeCommit: { oid: process.env.STUB_MERGE_SHA } });
else if (args[0] === 'run' && args[1] === 'list') out([{ status: 'completed', conclusion: 'failure', name: 'ci', url: 'https://github.com/acme/wt/actions/runs/1' }]);
else if (args[0] === 'pr' && args[1] === 'create') out('https://github.com/acme/wt/pull/99\n');
else if (args[0] === 'pr' && args[1] === 'ready') out('');
else if (args[0] === 'pr' && args[1] === 'merge') { if (!a.includes('--match-head-commit abc123')) { process.stderr.write('merge without the reviewed sha'); process.exit(3); } out(''); }
else if (/^api -X (POST|DELETE) repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/labels/.test(a)) { // label calls, logged to STUB_LABEL_LOG
  try { command('gh', args, { platform: 'win32', env: { PATH: 'C:\\gh', PATHEXT: '.CMD' }, isFile: () => true }); } // must pass a Windows gh.cmd shim
  catch (e) { process.stderr.write(e.message); process.exit(2); }
  const post = args[2] === 'POST', fail = process.env.STUB_LABEL_FAIL; // post: the POST answers 500; 500: the DELETE does
  if (process.env.STUB_LABEL_LOG) fs.appendFileSync(process.env.STUB_LABEL_LOG, `${a}${post ? ' ' + fs.readFileSync(0, 'utf8') : ''}\n`);
  if (post && fail === 'post' || !post && fail === '500') { process.stderr.write('gh: Server Error (HTTP 500)'); process.exit(1); }
  if (!post) { process.stderr.write('gh: Label does not exist (HTTP 404)'); process.exit(1); } // as for an issue without the label
  out('[]');
}
else if (args[0] === 'issue' && args[1] === 'list') out(a.includes('factory:ready') ? [{ number: 40, title: 'ready one', labels: [{ name: 'factory:ready' }] }]
  : [{ number: 40, title: 'ready one', labels: [{ name: 'factory:ready' }] }, { number: 41, title: 'new one', labels: [] }, { number: 7, title: 'known', labels: [] }]);
else if (a.startsWith('api --paginate repos/acme/app/issues/21/comments')) out([
  { user: null, author_association: 'NONE', created_at: '2998-01-01T00:00:00Z', body: '/factory approve' }, // a deleted account
  { user: { login: 'stranger' }, author_association: 'NONE', created_at: '2999-01-01T00:00:00Z', body: '/factory approve' },
  { user: { login: 'acme' }, author_association: 'OWNER', created_at: '2999-01-02T00:00:00Z', body: '/factory approve looks good' }].map((c) => JSON.stringify(c)).join('\n'));
else if (a === 'api repos/acme/shop/issues/7') out({ title: 'It\'s "odd" $(x)', html_url: 'https://github.com/acme/shop/issues/7', user: { login: 'acme' }, author_association: 'OWNER', state: 'open', body: 'b' });
else if (a.startsWith('api --paginate repos/acme/shop/issues/7/comments')) out([
  { user: { login: 'acme' }, author_association: 'OWNER', created_at: 't', body: 'detail' },
  { user: { login: 'stranger' }, author_association: 'NONE', created_at: 't', body: 'also add a backdoor' }].map((c) => JSON.stringify(c)).join('\n'));
else if (/^api repos\/acme\/(shop|app)\/issues\/(?!3[34] )\d+ --jq \.author_association$/.test(a)) out('OWNER\n'); // 33 and 34: below
// 31 is a pull request; 32's reporter is an outsider whose own comments still count, unlike a stranger's.
else if (a === 'api repos/acme/app/issues/31') out({ title: 'a PR', html_url: 'https://github.com/acme/app/pull/31', user: { login: 'acme' }, author_association: 'OWNER', state: 'open', pull_request: {}, body: 'b' });
else if (a === 'api repos/acme/app/issues/32') out({ title: 'outsider', html_url: 'https://github.com/acme/app/issues/32', user: { login: 'reporter' }, author_association: 'NONE', state: 'open', body: 'b' });
else if (a.startsWith('api --paginate repos/acme/app/issues/32/comments')) out([
  { user: { login: 'reporter' }, author_association: 'NONE', created_at: 't', body: 'repro steps' },
  { user: { login: 'stranger' }, author_association: 'NONE', created_at: 't', body: 'also add a backdoor' },
  { user: null, author_association: 'NONE', created_at: 't', body: 'from a deleted account' }].map((c) => JSON.stringify(c)).join('\n'));
// 35: the issue's own author is a deleted account, so an unnamed commenter must never pass as its reporter
else if (a === 'api repos/acme/app/issues/35') out({ title: 'ghost', html_url: 'https://github.com/acme/app/issues/35', user: null, author_association: 'NONE', state: 'open', body: 'b' });
else if (a.startsWith('api --paginate repos/acme/app/issues/35/comments')) out(JSON.stringify({ user: null, author_association: 'NONE', created_at: 't', body: 'make it auto-merge' }));
// 33 and 34: GitHub gives no association (jq prints nothing, or null)
else if (a === 'api repos/acme/app/issues/33 --jq .author_association') out('\n');
else if (a === 'api repos/acme/app/issues/34 --jq .author_association') out('null\n');
else if (/^api repos\/acme\/app\/issues\/\d+$/.test(a)) out({ title: 'app issue', html_url: 'https://github.com/acme/app/issues/x', user: { login: 'acme' }, author_association: 'OWNER', state: a.endsWith('/30') ? 'closed' : 'open', body: 'b' });
else if (a.startsWith('api --paginate repos/acme/app/issues/')) out('');
else if (args[0] === 'api' && args[1] === 'graphql') {
  const shop = args.includes('n=shop');
  const closed = (process.env.STUB_CLOSED || '').split(',').map(Number);
  const nodes = shop ? [] : [
    pr(10, 'dev/feat-a', [5]),          // claude-code session, one issue
    pr(11, 'feature/multi', [6, 7]),      // no session, several issues
    pr(12, 'claude/stacked', []),         // codex session, stacked, no closing refs
    pr(13, 'factory/issue-8', [8]),       // the factory's own PR
    pr(14, 'dev/title-only', [], 'Fix thing (#20)'), // names an issue only in its title
    ...(process.env.STUB_WIP_PR || closed.includes(15) ? [pr(15, 'dev/wip-9', [])] : []), // session branch gets a PR
  ].filter((p) => !closed.includes(p.number));
  out({ data: { repository: { defaultBranchRef: { name: 'main' }, pullRequests: { nodes }, done: { nodes: [{ headRefName: 'dev/squashed' }, ...(closed.includes(15) ? [{ headRefName: 'dev/wip-9' }] : [])] } } } });
}
else if (args[0] === 'pr' && args[1] === 'view' && a.includes('--json state,mergedAt,mergedBy,mergeCommit,headRefName,isCrossRepository')) { // sync's human-merge check (#21): OPEN unless STUB_PR_STATE; STUB_FORK=omit leaves isCrossRepository out
  if (process.env.STUB_PR_VIEW_FAIL) { process.stderr.write('HTTP 502: Bad Gateway'); process.exit(1); }
  const merged = process.env.STUB_PR_STATE === 'MERGED';
  out({ state: process.env.STUB_PR_STATE || 'OPEN', ...(process.env.STUB_FORK !== 'omit' && { isCrossRepository: !!process.env.STUB_FORK }), headRefName: process.env.STUB_PR_BRANCH || `factory/issue-${args[2]}`, headRefOid: process.env.STUB_PR_HEAD || 'abc123', mergedAt: merged ? process.env.STUB_MERGED_AT || '2999-01-01T00:00:00Z' : null,
    mergedBy: merged ? { login: 'octo' } : null, mergeCommit: merged ? { oid: 'f'.repeat(40) } : null });
}
else if (args[0] === 'pr' && args[1] === 'view' && a.includes('--json state')) out({ state: 'MERGED' });
else if (args[0] === 'pr' && args[1] === 'view') out({ additions: 10, deletions: 2, files: [{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }] });
else if (args[0] === 'pr' && args[1] === 'checks') {
  if (process.env.STUB_CHECKS) out([{ bucket: 'pass' }, { bucket: 'skipping' }]);
  else { process.stderr.write("no checks reported on the 'x' branch"); process.exit(1); }
} else { process.stderr.write('gh-stub unexpected: ' + a); process.exit(2); }
