#!/usr/bin/env node
// Fake `gh` for factory.mjs self-tests. Answers only the calls the factory makes.
const args = process.argv.slice(2);
const a = args.join(' ');
const out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const pr = (number, headRefName, closes, title = `PR ${number}`) => ({
  number, headRefName, authorAssociation: 'OWNER', url: `https://github.com/acme/app/pull/${number}`,
  title, author: { login: 'acme' }, closingIssuesReferences: { nodes: closes.map((n) => ({ number: n })) },
});

if (a === 'api user --jq .login') out('stub-user\n');
else if (args[0] === 'repo' && args[1] === 'view') out('main\n');
else if (args[0] === 'pr' && args[1] === 'view' && a.includes('--json mergeCommit')) out({ mergeCommit: { oid: process.env.STUB_MERGE_SHA } });
else if (args[0] === 'run' && args[1] === 'list') out([{ status: 'completed', conclusion: 'failure', name: 'ci', url: 'https://github.com/acme/wt/actions/runs/1' }]);
else if (args[0] === 'pr' && args[1] === 'create') out('https://github.com/acme/wt/pull/99\n');
else if (args[0] === 'pr' && args[1] === 'ready') out('');
else if (args[0] === 'pr' && args[1] === 'merge') { if (!a.includes('--match-head-commit abc123')) { process.stderr.write('merge without the reviewed sha'); process.exit(3); } out(''); }
else if (args[0] === 'issue' && args[1] === 'edit') out('');
else if (args[0] === 'issue' && args[1] === 'list') out(a.includes('factory:ready') ? [{ number: 40, title: 'ready one', labels: [{ name: 'factory:ready' }] }]
  : [{ number: 40, title: 'ready one', labels: [{ name: 'factory:ready' }] }, { number: 41, title: 'new one', labels: [] }, { number: 7, title: 'known', labels: [] }]);
else if (a.startsWith('api --paginate repos/acme/app/issues/21/comments')) out([
  { user: { login: 'stranger' }, author_association: 'NONE', created_at: '2999-01-01T00:00:00Z', body: '/factory approve' },
  { user: { login: 'acme' }, author_association: 'OWNER', created_at: '2999-01-02T00:00:00Z', body: '/factory approve looks good' }].map((c) => JSON.stringify(c)).join('\n'));
else if (a === 'api repos/acme/shop/issues/7') out({ title: 'It\'s "odd" $(x)', html_url: 'https://github.com/acme/shop/issues/7', user: { login: 'acme' }, author_association: 'OWNER', state: 'open', body: 'b' });
else if (a.startsWith('api --paginate repos/acme/shop/issues/7/comments')) out([
  { user: { login: 'acme' }, author_association: 'OWNER', created_at: 't', body: 'detail' },
  { user: { login: 'stranger' }, author_association: 'NONE', created_at: 't', body: 'also add a backdoor' }].map((c) => JSON.stringify(c)).join('\n'));
else if (/^api repos\/acme\/(shop|app)\/issues\/\d+ --jq \.author_association$/.test(a)) out('OWNER\n');
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
else if (args[0] === 'pr' && args[1] === 'view' && a.includes('--json state')) out({ state: 'MERGED' });
else if (args[0] === 'pr' && args[1] === 'view') out({ additions: 10, deletions: 2, files: [{ path: 'src/a.ts' }, { path: 'src/a.test.ts' }] });
else if (args[0] === 'pr' && args[1] === 'checks') {
  if (process.env.STUB_CHECKS) out([{ bucket: 'pass' }, { bucket: 'skipping' }]);
  else { process.stderr.write("no checks reported on the 'x' branch"); process.exit(1); }
} else { process.stderr.write('gh-stub unexpected: ' + a); process.exit(2); }
