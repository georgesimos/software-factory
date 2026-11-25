#!/usr/bin/env node
// Stateful fake `gh` for the idea-to-app tests. Repos and issues live in $STUB_STATE/state.json (a created repo is a local
// bare git repo, so pushes are real); every call is appended to $STUB_STATE/calls.log so tests can count remote writes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2), a = args.join(' '), S = process.env.STUB_STATE, file = path.join(S, 'state.json');
fs.appendFileSync(path.join(S, 'calls.log'), JSON.stringify(args) + '\n');
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { repos: {}, issues: {} };
const save = () => fs.writeFileSync(file, JSON.stringify(st, null, 2));
const out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
const fail = (msg, code = 1) => { process.stderr.write(msg); process.exit(code); };
const opt = (f) => args[args.indexOf(f) + 1];

if (a === 'auth status') process.env.STUB_NO_AUTH ? fail('You are not logged into any GitHub hosts. To log in, run: gh auth login') : out('github.com\n  ✓ Logged in to github.com account stub-user\n');
else if (a === 'api user --jq .login') out('stub-user\n');
else if (args[0] === 'repo' && args[1] === 'view') {
  const r = st.repos[args[2]];
  if (!r) fail(`GraphQL: Could not resolve to a Repository with the name '${args[2]}'.`);
  out(a.includes('defaultBranchRef') ? 'main\n' : r.bare + '\n');
} else if (args[0] === 'repo' && args[1] === 'create') {
  if (st.repos[args[2]]) fail('Name already exists on this account');
  const bare = path.join(S, args[2].replace('/', '-') + '.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  st.repos[args[2]] = { bare, visibility: args.includes('--public') ? 'public' : 'private', description: opt('--description') };
  save();
  out(`https://github.com/${args[2]}\n`);
} else if (args[0] === 'label' && args[1] === 'create') out('');
else if (args[0] === 'issue' && args[1] === 'create') {
  const r = opt('-R'), list = (st.issues[r] ||= []), number = list.length + 1, url = `https://github.com/${r}/issues/${number}`;
  list.push({ number, title: opt('--title'), body: opt('--body'), labels: [{ name: opt('--label') }], state: 'OPEN', url, author: { login: 'stub-user' } });
  save();
  out(url + '\n');
} else if (args[0] === 'issue' && args[1] === 'list') out((st.issues[opt('-R')] || []).filter((i) => opt('--state') === 'all' || i.state === 'OPEN'));
else if (args[0] === 'api' && args[1] === 'graphql') out({ data: { repository: { defaultBranchRef: { name: 'main' }, pullRequests: { nodes: [] }, done: { nodes: [] } } } });
else fail('gh-project-stub unexpected: ' + a, 2);
