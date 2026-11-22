// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { TRUSTED } from './constants.ts';
import { decide } from './gate.ts';
import { derive, getRun } from './derive.ts';
import { execFileSync } from 'node:child_process';
import { git, projects } from './workspace.ts';
import { io, read, readArchive, record, runDir } from './log.ts';
import { shipTrack } from './ship.ts';
import { rules } from './rules.ts';

export const gh = (...args) => execFileSync(io.gh, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const parseRun = (run) => {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(run || '');
  if (!m) throw new Error(`run must look like owner/repo#N, got "${run}"`);
  return { repo: `${m[1]}/${m[2]}`, n: m[3] };
};
// Fetches the issue itself so title/author/association are never model-typed. Prints what intake should read.
export function intake(run) {
  const { repo, n } = parseRun(run);
  if (process.env.FACTORY_FIXTURES && repo === 'eval/golden') return intakeFixture(run, n); // offline eval: no GitHub
  // Exact links only (GitHub closing references); the factory's own branch is a resume, not a clash.
  const { prs } = openPRs(repo);
  const inProgress = prs
    .filter((p) => p.headRefName !== `factory/issue-${n}` && p.closingIssuesReferences.nodes.some((x) => String(x.number) === n))
    .map((p) => p.url);
  if (inProgress.length) return { inProgress }; // nothing recorded: someone is already on it
  const i = JSON.parse(gh('api', `repos/${repo}/issues/${n}`));
  if (i.pull_request) return { notAnIssue: `#${n} is a pull request` };
  if (i.state !== 'open') return { notAnIssue: `#${n} is ${i.state}` };
  // Advisory only: PRs naming the issue in their title without a formal closing link.
  const mentions = prs.filter((p) => p.headRefName !== `factory/issue-${n}` && new RegExp(`(^|[^\\w])#${n}(?!\\d)`).test(p.title)).map((p) => ({ url: p.url, title: p.title }));
  const comments = gh('api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[]').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = { title: i.title, url: i.html_url, author: i.user.login, association: i.author_association };
  // A split child is authored by whoever ran the split; it inherits its parent's (possibly untrusted) author.
  const parent = [...Object.values(derive(read())), ...readArchive()].find((r) => (r.children || []).includes(run));
  if (parent) Object.assign(meta, { origin: parent.id, originAssociation: parent.originAssociation || parent.association });
  record(run, 'intake', 'started', meta);
  // Only the reporter and repo insiders may shape requirements; others could steer a trusted issue into auto-merge.
  const counts = (c) => c.user.login === meta.author || TRUSTED.includes(c.author_association);
  return {
    ...meta, state: i.state, body: i.body, mentions,
    comments: comments.filter(counts).map((c) => ({ author: c.user.login, association: c.author_association, created_at: c.created_at, body: c.body })),
    ignoredComments: comments.filter((c) => !counts(c)).length,
  };
}
export function intakeFixture(run, n) {
  const fx = JSON.parse(fs.readFileSync(path.join(process.env.FACTORY_FIXTURES, `${n}.json`), 'utf8'));
  const meta = { title: fx.issue.title, url: `https://github.com/eval/golden/issues/${n}`, author: fx.issue.author, association: fx.issue.association };
  record(run, 'intake', 'started', meta);
  return { ...meta, state: 'open', body: fx.issue.body, mentions: [], comments: fx.comments || [], ignoredComments: 0, dryRun: true };
}
export const adapterCtx = () => ({ gh, git }); // what host and tracker adapters get: the same stubbable gh and git
export function openPRs(repo) {
  const [o, n] = repo.split('/');
  const q = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){defaultBranchRef{name} pullRequests(states:OPEN,first:100){nodes{number url title headRefName headRefOid authorAssociation author{login} closingIssuesReferences(first:20){nodes{number}}}} done: pullRequests(states:[MERGED,CLOSED],last:100){nodes{headRefName}}}}';
  const r = JSON.parse(gh('api', 'graphql', '-f', `query=${q}`, '-f', `o=${o}`, '-f', `n=${n}`)).data.repository;
  return { base: r.defaultBranchRef.name, prs: r.pullRequests.nodes, doneBranches: (r.done?.nodes || []).map((x) => x.headRefName) };
}
// Reads CI + diff facts from GitHub so the merge decision never depends on typed-in numbers.
export function facts(r) {
  const { repo, n } = parseRun(r.id);
  const association = gh('api', `repos/${repo}/issues/${n}`, '--jq', '.author_association').trim();
  const autoMerge = projects()[repo]?.autoMerge !== false;
  const policy = rules(repo).policy; // a broken config throws here, so decide/merge fail and the run escalates
  const pv = policy['deploy.preview']?.value, dep = {};
  if (pv && pv !== 'off') { // live, like CI: record the reviewed commit's deploy state now, then decide on what the log says
    shipTrack([{ run: r.id, repo, sha: r.reviewedSha, path: projects()[repo]?.path }]);
    dep.deploys = derive(read())[r.id]?.deploys || [];
  }
  if (!r.pr) return { association, autoMerge, checks: 'none', additions: 0, deletions: 0, files: [], rules: policy, ...dep };
  const diff = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'additions,deletions,files'));
  let checks = 'skipped'; // ci=skip: GitHub CI isn't even read
  if (policy.ci?.value !== 'skip') try {
    const b = JSON.parse(gh('pr', 'checks', r.pr, '-R', repo, '--json', 'bucket')).map((c) => c.bucket);
    checks = !b.length ? 'none' : b.some((x) => x === 'fail' || x === 'cancel') ? 'fail' : b.includes('pending') ? 'pending' : 'pass';
  } catch (e) {
    if (!/no checks reported/i.test(String(e.stderr))) throw e;
    checks = 'none';
  }
  return { association, autoMerge, checks, additions: diff.additions, deletions: diff.deletions, files: diff.files.map((f) => f.path), rules: policy, ...dep };
}
// The only merge path: re-decides from live GitHub facts and merges exactly the reviewed commit.
export function merge(run) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  const f = r.imported ? {} : facts(r);
  const d = decide(r, f);
  record(run, 'approve', 'decided', { ...d, facts: f });
  if (d.action !== 'merge') return { merged: false, ...d };
  if (!r.reviewedSha) throw new Error('no reviewed commit recorded; refusing to merge');
  gh('pr', 'ready', r.pr, '-R', repo);
  gh('pr', 'merge', r.pr, '-R', repo, '--squash', '--delete-branch', '--match-head-commit', r.reviewedSha);
  record(run, 'approve', 'merged');
  try { gh('issue', 'edit', n, '-R', repo, '--remove-label', 'factory:in-progress', '--add-label', 'factory:merged'); } catch { /* label is cosmetic */ }
  return { merged: true, ...d };
}
// Spec approval: a trusted "/factory approve" (or "/factory reject") comment after the run started waiting.
export function approval(run) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  const since = [...r.events].reverse().find((e) => e.status === 'awaiting-approval')?.ts;
  if (!since) throw new Error(`${run} is not awaiting approval`);
  const comments = gh('api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[]').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const vote = comments.filter((c) => c.created_at > since && TRUSTED.includes(c.author_association))
    .map((c) => ({ by: c.user.login, m: /^\s*\/factory\s+(approve|reject)\b/i.exec(c.body || '') })).filter((x) => x.m).pop();
  return vote ? { decision: vote.m[1].toLowerCase(), by: vote.by } : { decision: 'waiting' };
}
// After a merge: CI on the merge commit of the base branch.
export function postmerge(run) {
  const r = getRun(run);
  const { repo } = parseRun(run);
  const sha = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'mergeCommit')).mergeCommit?.oid;
  if (!sha) return { state: 'not-merged' };
  const ship = shipTrack([{ run, repo, sha, path: projects()[repo]?.path }]), deploys = ship?.recorded.length ? { deploys: ship.recorded } : {}; // production deploy of the merge commit, when a connector reports one
  const ci = rules(repo).policy.ci?.value;
  if (ci === 'skip') return { sha, state: 'skipped', reason: 'rule ci=skip: CI on the base branch is not watched, so it never triggers a revert', ...deploys };
  const runs = JSON.parse(gh('run', 'list', '-R', repo, '--commit', sha, '--json', 'status,conclusion,name,url'));
  const failed = runs.filter((x) => ['failure', 'cancelled', 'timed_out'].includes(x.conclusion)).map((x) => x.url);
  const state = !runs.length ? 'none' : failed.length ? 'fail' : runs.some((x) => x.status !== 'completed') ? 'pending' : 'pass';
  return { sha, state, failed, ...(ci === 'advisory' && { advisory: true }), ...deploys }; // advisory: report red, don't revert on it
}
// Opens (never merges) a revert PR for a merged run whose main CI went red.
export function revert(run, reason) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  const pm = postmerge(run);
  if (!pm.sha) throw new Error('run has no merge commit');
  const repoPath = projects()[repo]?.path;
  if (!repoPath) throw new Error(`no local clone registered for ${repo}`);
  const base = gh('repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name').trim();
  const branch = `factory/revert-${n}`, wt = path.join(runDir(run), 'revert');
  git('-C', repoPath, 'fetch', '-q', 'origin', base);
  git('-C', repoPath, 'worktree', 'add', '-q', '-B', branch, wt, `origin/${base}`);
  try {
    git('-C', wt, 'revert', '--no-edit', pm.sha);
    git('-C', wt, 'push', '-q', '-u', 'origin', branch);
    const url = gh('pr', 'create', '-R', repo, '--base', base, '--head', branch, '--title', `Revert: ${r.title}`,
      '--body', `Reverts ${r.pr} (#${n}): ${reason}\n\nOpened by the software factory. Needs a human to merge.`, '--label', 'factory:needs-human').trim();
    record(run, 'approve', 'reverted', { pr: url, reason });
    return { pr: url };
  } finally {
    try { git('-C', repoPath, 'worktree', 'remove', '--force', wt); git('-C', repoPath, 'branch', '-D', branch); } catch { /* best effort */ }
  }
}
