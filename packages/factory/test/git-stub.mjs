#!/usr/bin/env node
// Fake `git` for factory.mjs self-tests: `branch --no-merged` lists unmerged local branches.
const a = process.argv.slice(2).join(' ');
if (a.includes('branch --no-merged refs/remotes/origin/main')) process.stdout.write('dev/feat-a\ndev/wip-9\nclaude/stacked\ndev/squashed\nfactory/issue-9\n');
else { process.stderr.write('git-stub unexpected: ' + a); process.exit(2); }
