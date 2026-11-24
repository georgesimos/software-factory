import fs from 'node:fs';
import path from 'node:path';
import { TRUSTED } from './constants.ts';
import { decide, localResult } from './gate.ts';
import { ciBroken, ciChecks, ciOf } from './ci.ts';
import { derive, getRun } from './derive.ts';
import { exec } from './platform.ts';
import { baseBranch, git, projects, requireGithub } from './workspace.ts';
import { io, read, readArchive, record, runDir } from './log.ts';
import { shipTrack } from './ship.ts';
import { rules } from './rules.ts';
import type { Facts } from './gate.ts';
import type { Deploy, Run } from './types.ts';

// GitHub's JSON, as far as F reads it: gh output is parsed, never validated beyond what the code checks.
interface GhUser { login: string }
interface GhIssue { pull_request?: unknown; state: string; title: string; html_url: string; user: GhUser; author_association: string; body?: string | null }
export interface GhComment { user: GhUser; author_association: string; created_at: string; body?: string | null }
/** An open PR from openPRs()'s GraphQL query. */
export interface GhPullRequest {
  number: number; url: string; title: string; headRefName: string; headRefOid: string; authorAssociation: string; author?: GhUser | null;
  closingIssuesReferences: { nodes: { number: number }[] };
}
interface GhRepository {
  defaultBranchRef: { name: string };
  pullRequests: { nodes: GhPullRequest[] };
  done?: { nodes: { headRefName: string }[] } | null;
}
/** postmerge(): CI on the merge commit, and its production deploys. */
// SKILL.md §7 says what to do on each (test/ci.test.mjs checks it names them all).
export const POSTMERGE_STATES = ['no-pr', 'not-merged', 'skipped', 'unknown', 'pending', 'none', 'pass', 'fail'] as const;
export interface PostMerge { sha?: string; state: typeof POSTMERGE_STATES[number]; reason?: string; failed?: string[]; advisory?: boolean; deploys?: Deploy[] }

export const gh = (...args: string[]): string => exec(io.gh, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const parseRun = (run: string) => {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(run || '');
  if (!m) throw new Error(`run must look like owner/repo#N, got "${run}"`);
  return { repo: `${m[1]}/${m[2]}`, n: m[3] as string }; // matched: every group is set
};
// Fetches the issue itself so title/author/association are never model-typed. Prints what intake should read.
export function intake(run: string) {
  const { repo, n } = parseRun(run);
  if (process.env.FACTORY_FIXTURES && repo === 'eval/golden') return intakeFixture(run, n); // offline eval: no GitHub
  requireGithub(repo, 'intake (reading the issue)');
  const done = derive(read())[run] || readArchive().find((a) => a.id === run);
  if (done?.humanMerge && !done.reverted) throw new Error(`${run} was escalated, then merged by ${done.humanMerge.by || 'a human'}: it needs a human, not a new run`);
  // Exact links only (GitHub closing references); the factory's own branch is a resume, not a clash.
  const { prs } = openPRs(repo);
  const inProgress = prs
    .filter((p) => p.headRefName !== `factory/issue-${n}` && p.closingIssuesReferences.nodes.some((x) => String(x.number) === n))
    .map((p) => p.url);
  if (inProgress.length) return { inProgress }; // nothing recorded: someone is already on it
  const i: GhIssue = JSON.parse(gh('api', `repos/${repo}/issues/${n}`));
  if (i.pull_request) return { notAnIssue: `#${n} is a pull request` };
  if (i.state !== 'open') return { notAnIssue: `#${n} is ${i.state}` };
  // Advisory only: PRs naming the issue in their title without a formal closing link.
  const mentions = prs.filter((p) => p.headRefName !== `factory/issue-${n}` && new RegExp(`(^|[^\\w])#${n}(?!\\d)`).test(p.title)).map((p) => ({ url: p.url, title: p.title }));
  const comments: GhComment[] = gh('api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[]').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta: { title: string; url: string; author: string; association: string; origin?: string; originAssociation?: string | undefined } = { title: i.title, url: i.html_url, author: i.user.login, association: i.author_association };
  // A split child is authored by whoever ran the split; it inherits its parent's (possibly untrusted) author.
  const parent = [...Object.values(derive(read())), ...readArchive()].find((r) => (r.children || []).includes(run));
  if (parent) Object.assign(meta, { origin: parent.id, originAssociation: parent.originAssociation || parent.association });
  record(run, 'intake', 'started', meta);
  // Only the reporter and repo insiders may shape requirements; others could steer a trusted issue into auto-merge.
  const counts = (c: GhComment) => c.user.login === meta.author || TRUSTED.includes(c.author_association);
  return {
    ...meta, state: i.state, body: i.body, mentions,
    comments: comments.filter(counts).map((c) => ({ author: c.user.login, association: c.author_association, created_at: c.created_at, body: c.body })),
    ignoredComments: comments.filter((c) => !counts(c)).length,
  };
}
export function intakeFixture(run: string, n: string) {
  const fx: { issue: { title: string; author: string; association: string; body?: string }; comments?: unknown[] } = JSON.parse(fs.readFileSync(path.join(process.env.FACTORY_FIXTURES as string, `${n}.json`), 'utf8')); // intake() calls it only when set
  const meta = { title: fx.issue.title, url: `https://github.com/eval/golden/issues/${n}`, author: fx.issue.author, association: fx.issue.association };
  record(run, 'intake', 'started', meta);
  return { ...meta, state: 'open', body: fx.issue.body, mentions: [], comments: fx.comments || [], ignoredComments: 0, dryRun: true };
}
export const adapterCtx = () => ({ gh, git }); // what host and tracker adapters get: the same stubbable gh and git
export function openPRs(repo: string): { base: string; prs: GhPullRequest[]; doneBranches: string[] } {
  requireGithub(repo, 'listing open pull requests');
  const [o, n] = repo.split('/');
  const q = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){defaultBranchRef{name} pullRequests(states:OPEN,first:100){nodes{number url title headRefName headRefOid authorAssociation author{login} closingIssuesReferences(first:20){nodes{number}}}} done: pullRequests(states:[MERGED,CLOSED],last:100){nodes{headRefName}}}}';
  const r: GhRepository = JSON.parse(gh('api', 'graphql', '-f', `query=${q}`, '-f', `o=${o}`, '-f', `n=${n}`)).data.repository;
  return { base: r.defaultBranchRef.name, prs: r.pullRequests.nodes, doneBranches: (r.done?.nodes || []).map((x) => x.headRefName) };
}
// Reads CI + diff facts from GitHub so the merge decision never depends on typed-in numbers.
export function facts(r: Run): Facts {
  const { repo, n } = parseRun(r.id);
  requireGithub(repo, 'reading CI and the diff');
  const association = gh('api', `repos/${repo}/issues/${n}`, '--jq', '.author_association').trim();
  const autoMerge = projects()[repo]?.autoMerge !== false;
  const policy = rules(repo).policy; // a broken config throws here, so decide/merge fail and the run escalates
  const pv = policy['deploy.preview']?.value, dep: { deploys?: Deploy[] } = {};
  if (pv && pv !== 'off') { // live, like CI: record the reviewed commit's deploy state now, then decide on what the log says
    shipTrack([{ run: r.id, repo, sha: r.reviewedSha, path: projects()[repo]?.path }]);
    dep.deploys = derive(read())[r.id]?.deploys || [];
  }
  if (!r.pr) return { association, autoMerge, checks: 'none', additions: 0, deletions: 0, files: [], rules: policy, ...dep };
  const diff: { additions: number; deletions: number; files: { path: string }[] } = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'additions,deletions,files'));
  // the project's CI provider on the reviewed commit; ci=skip doesn't read it, but a provider that can't answer still escalates
  const local = (sha?: string) => localResult(r.localChecks, policy['checks.commands']?.value, sha);
  const c = policy.ci?.value === 'skip' ? { ci: undefined, state: 'skipped', broken: ciBroken(repo) } : ciChecks(repo, { path: projects()[repo]?.path, sha: r.reviewedSha, changeRequest: r.pr }, local);
  const ci = { ...(c.ci && c.ci !== 'github-actions' && { ci: c.ci }), ...('detail' in c && c.detail && { ciDetail: c.detail }), ...(c.broken && { ciBroken: c.broken }) }; // GitHub's, as before: no extra keys
  return { association, autoMerge, checks: c.state, ...ci, additions: diff.additions, deletions: diff.deletions, files: diff.files.map((f) => f.path), rules: policy, ...dep };
}
// The only merge path: re-decides from live GitHub facts and merges exactly the reviewed commit.
export function merge(run: string) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  requireGithub(repo, 'merging');
  const f = r.imported ? {} : facts(r);
  const d = decide(r, f);
  record(run, 'approve', 'decided', { ...d, facts: f });
  if (d.action !== 'merge') return { merged: false, ...d };
  if (!r.reviewedSha) throw new Error('no reviewed commit recorded; refusing to merge');
  gh('pr', 'ready', r.pr as string, '-R', repo); // decide() escalates a run with no PR
  gh('pr', 'merge', r.pr as string, '-R', repo, '--squash', '--delete-branch', '--match-head-commit', r.reviewedSha);
  record(run, 'approve', 'merged');
  relabelMerged(run);
  return { merged: true, ...d };
}
// After a merge the issue gets factory:merged and loses factory:in-progress, through the REST labels endpoint with the body on stdin:
// `gh issue edit --add-label` fails on current gh (Projects classic), and `-f labels[]=…` has brackets a Windows gh.cmd shim can't pass.
// Labels are cosmetic: warn, never throw.
export function relabelMerged(run: string) {
  const { repo, n } = parseRun(run);
  requireGithub(repo, 'relabelling the issue');
  const warn = (e: any) => console.error(`factory: label update on ${run} failed: ${String(e?.stderr || e?.message || e).trim().split('\n')[0]}`); // any: whatever was thrown
  try { exec(io.gh, ['api', '-X', 'POST', `repos/${repo}/issues/${n}/labels`, '--input', '-'], { encoding: 'utf8', input: JSON.stringify({ labels: ['factory:merged'] }), stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { warn(e); }
  try { gh('api', '-X', 'DELETE', `repos/${repo}/issues/${n}/labels/factory:in-progress`); } catch (e: any) { if (!/Label does not exist/.test(`${e?.stderr}${e?.stdout}`)) warn(e); } // the only silent 404: it wasn't on the issue
}
// Spec approval: a trusted "/factory approve" (or "/factory reject") comment after the run started waiting.
export function approval(run: string) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  requireGithub(repo, 'reading spec approval');
  const since = [...r.events].reverse().find((e) => e.status === 'awaiting-approval')?.ts;
  if (!since) throw new Error(`${run} is not awaiting approval`);
  const comments: GhComment[] = gh('api', '--paginate', `repos/${repo}/issues/${n}/comments`, '--jq', '.[]').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return approvalVote(comments, since);
}
// The latest trusted "/factory approve|reject" posted after `since`. GitHub stamps comments to the whole second and F to the
// millisecond, so only a comment from a later second counts: one in the same second may predate the spec it would approve.
// Compared as times, never strings ("…:00Z" sorts after "…:00.900Z"). An unparsable created_at never counts.
export function approvalVote(comments: GhComment[], since: string) {
  const from = Math.floor(Date.parse(since) / 1000) * 1000 + 1000;
  const vote = comments.filter((c) => Date.parse(c.created_at) >= from && TRUSTED.includes(c.author_association))
    .map((c) => ({ by: c.user.login, m: /^\s*\/factory\s+(approve|reject)\b/i.exec(c.body || '') })).filter((x) => x.m).pop();
  return vote ? { decision: ((vote.m as RegExpExecArray)[1] as string).toLowerCase(), by: vote.by } : { decision: 'waiting' }; // filtered on m; group 1 always matches
}
// After a merge: CI on the merge commit of the base branch.
export function postmerge(run: string): PostMerge {
  const r = getRun(run);
  const { repo } = parseRun(run);
  requireGithub(repo, 'post-merge CI');
  if (!r.pr) return { state: 'no-pr', reason: 'no PR recorded for this run' }; // never `gh pr view undefined`
  const sha: string | undefined = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'mergeCommit')).mergeCommit?.oid;
  if (!sha) return { state: 'not-merged' };
  const ship = shipTrack([{ run, repo, sha, path: projects()[repo]?.path }]), deploys = ship?.recorded.length ? { deploys: ship.recorded } : {}; // production deploy of the merge commit, when a connector reports one
  const policy = rules(repo).policy, ci = policy.ci?.value, broken = ciBroken(repo);
  if (broken) return { sha, state: 'unknown', reason: broken, ...deploys }; // fail closed: never "skipped" or "pass"
  if (ci === 'skip') return { sha, state: 'skipped', reason: 'rule ci=skip: CI on the base branch is not watched, so it never triggers a revert', ...deploys };
  // shortcut: F checks runs only in a run's worktree, never on the merge commit, so local CI can't watch the base after a merge;
  // run checks.commands in a fresh worktree of the merge commit here once that is wanted. Until then a definite skipped, never a state that can't change.
  if (ciOf(repo) === 'local') {
    let base = 'the base branch';
    try { base = baseBranch(repo, projects()[repo]?.path ?? ''); } catch { /* the reason still says what to do */ }
    return { sha, state: 'skipped', reason: `CI provider local: ${base} after the merge is not checked, so it never triggers a revert; run the checks.commands on ${base} yourself`, ...deploys };
  }
  const c = ciChecks(repo, { path: projects()[repo]?.path, sha }, (s) => localResult(r.localChecks, policy['checks.commands']?.value, s));
  const why = c.broken ?? (c.state !== 'pass' && c.ci !== 'github-actions' ? c.detail : undefined);
  return { sha, state: c.state, failed: c.failed ?? [], ...(why && { reason: why }), ...(ci === 'advisory' && { advisory: true }), ...deploys }; // advisory: report red, don't revert on it
}
// Opens (never merges) a revert PR for a merged run whose main CI went red.
export function revert(run: string, reason: string) {
  const r = getRun(run);
  const { repo, n } = parseRun(run);
  requireGithub(repo, 'opening a revert PR');
  const pm = postmerge(run);
  if (!pm.sha) throw new Error(pm.reason || 'run has no merge commit');
  const repoPath = projects()[repo]?.path;
  if (!repoPath) throw new Error(`no local clone registered for ${repo}`);
  const base = baseBranch(repo, repoPath);
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
