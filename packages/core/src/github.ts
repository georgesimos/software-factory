import fs from 'node:fs';
import path from 'node:path';
import { TRUSTED } from './constants.ts';
import { decide, localResult } from './gate.ts';
import { ciBroken, ciChecks, ciOf } from './ci.ts';
import { derive, getRun } from './derive.ts';
import { exec } from './platform.ts';
import { autoMergeOn, baseBranch, baseRef, fetchBase, git, hostFn, hostOf, projects, requireGithub, trackerFn, trackerOf } from './workspace.ts';
import { io, read, readArchive, record, runDir } from './log.ts';
import { shipTrack } from './ship.ts';
import { gitTooOld } from '../../adapters/hosts/git.ts';
import { prNumber } from '../../adapters/hosts/github.ts';
import { current, pending } from './approve.ts';
import { createHash } from 'node:crypto';
import { rules } from './rules.ts';
import { runCapsOf } from './route.ts';
import type { Facts } from './gate.ts';
import type { Comment } from '../../adapters/trackers/index.ts';
import type { Host } from '../../adapters/hosts/index.ts';
import type { Deploy, Run } from './types.ts';

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
// Reads the item from the project's tracker so title/author/association are never model-typed. Prints what intake should read.
export function intake(run: string) {
  const { repo, n } = parseRun(run);
  if (process.env.FACTORY_FIXTURES && repo === 'eval/golden') return intakeFixture(run, n); // offline eval: no GitHub
  const t = trackerOf(repo), ctx = adapterCtx(), at = projects()[repo]?.path, where = { repo, id: n, ...(at && { path: at }) };
  if (t === 'github-issues') requireGithub(repo, 'intake (reading the issue)');
  const done = derive(read())[run] || readArchive().find((a) => a.id === run);
  if (done?.humanMerge && !done.reverted) throw new Error(`${run} was escalated, then merged by ${done.humanMerge.by || 'a human'}: it needs a human, not a new run`);
  // Exact links only (GitHub closing references); the factory's own branch is a resume, not a clash.
  const prs = openPRs(repo).open;
  const inProgress = prs
    .filter((p) => p.branch !== `factory/issue-${n}` && p.closes.includes(n))
    .map((p) => p.url);
  if (inProgress.length) return { inProgress }; // nothing recorded: someone is already on it
  const i = trackerFn(t, 'getItem', 'read an item')(ctx, where);
  if (i.isChangeRequest) return { notAnIssue: `#${n} is a pull request` };
  if (i.state !== 'open') return { notAnIssue: `#${n} is ${i.state}` };
  // Advisory only: PRs naming the issue in their title without a formal closing link.
  const mentions = prs.filter((p) => p.branch !== `factory/issue-${n}` && new RegExp(`(^|[^\\w])#${n}(?!\\d)`).test(p.title)).map((p) => ({ url: p.url, title: p.title }));
  const comments = trackerFn(t, 'comments', 'read comments')(ctx, where);
  const meta: { title: string; url?: string | undefined; author: string; association: string; labels: string[]; origin?: string; originAssociation?: string | undefined; itemSha?: string } = { title: i.title, url: i.url, author: i.author, association: i.association, labels: (i.labels ?? []).slice(0, 50).map((l) => String(l).slice(0, 100)) }; // labels: what a pipeline matches on (§7.2)
  if (t !== 'github-issues') { // D3: a record of what intake read, for the user; informational only: nothing reads item.md or itemSha back, and a re-intake overwrites them
    const snap = `# ${i.title}\n\n${i.body ?? ''}\n`;
    fs.mkdirSync(runDir(run), { recursive: true });
    fs.writeFileSync(path.join(runDir(run), 'item.md'), snap);
    meta.itemSha = createHash('sha256').update(snap).digest('hex');
  }
  // A split child is authored by whoever ran the split; it inherits its parent's (possibly untrusted) author.
  // Listed by more than one parent (live or archived): the least trusted wins, and a missing association is NONE, never unchecked.
  const trust = (p: Run) => [p.association || 'NONE', ...(p.origin ? [p.originAssociation || 'NONE'] : [])];
  const parents = [...Object.values(derive(read())), ...readArchive()].filter((r) => (r.children || []).includes(run));
  const worst = parents.find((p) => trust(p).some((a) => !TRUSTED.includes(a))) || parents[0];
  if (worst) Object.assign(meta, { origin: worst.id, originAssociation: trust(worst).find((a) => !TRUSTED.includes(a)) || trust(worst).at(-1) });
  record(run, 'intake', 'started', meta);
  // Only the reporter and repo insiders may shape requirements; others could steer a trusted issue into auto-merge.
  const counts = (c: Comment) => (!!c.author && c.author === meta.author) || TRUSTED.includes(c.association); // a deleted account ('') is nobody's
  return {
    ...meta, state: i.state, body: i.body, mentions,
    comments: comments.filter(counts).map((c) => ({ author: c.author, association: c.association, created_at: c.created_at, body: c.body })),
    ignoredComments: comments.filter((c) => !counts(c)).length,
  };
}
export function intakeFixture(run: string, n: string) {
  const fx: { issue: { title: string; author: string; association: string; body?: string; labels?: string[] }; comments?: unknown[] } = JSON.parse(fs.readFileSync(path.join(process.env.FACTORY_FIXTURES as string, `${n}.json`), 'utf8')); // intake() calls it only when set
  const meta = { title: fx.issue.title, url: `https://github.com/eval/golden/issues/${n}`, author: fx.issue.author, association: fx.issue.association, labels: fx.issue.labels ?? [] };
  record(run, 'intake', 'started', meta);
  return { ...meta, state: 'open', body: fx.issue.body, mentions: [], comments: fx.comments || [], ignoredComments: 0, dryRun: true };
}
export const ghInput = (input: string, ...args: string[]): string => exec(io.gh, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
export const adapterCtx = () => ({ gh, git, ghInput }); // what host and tracker adapters get: the same stubbable gh and git
/** The project's open change requests, from its host (a git host reads the clone at path). */
export function openPRs(repo: string, path = projects()[repo]?.path) {
  const base = projects()[repo]?.base;
  return hostFn(hostOf(repo), 'listChangeRequests', 'list change requests')(adapterCtx(), { repo, ...(path && { path }), ...(base && { base }) });
}
// Reads trust, CI and diff facts live (tracker, CI provider, host) so the merge decision never depends on typed-in numbers.
/** The change's size for a pick (pipelines §7.2): additions + deletions of the run's PR, from the same gh call facts() makes.
 *  null when there is no PR yet, the project isn't on GitHub, or gh can't say: then maxDiffLines never holds. */
export function prDiffLines(r: Run): number | null {
  const { repo } = parseRun(r.id);
  if (!r.pr || hostOf(repo) !== 'github') return null;
  try { const d = JSON.parse(gh('pr', 'view', prNumber(repo, r.pr), '-R', repo, '--json', 'additions,deletions')) as { additions?: unknown; deletions?: unknown }; return Number.isInteger(d.additions) && Number.isInteger(d.deletions) ? (d.additions as number) + (d.deletions as number) : null; }
  catch { return null; }
}
export function facts(r: Run): Facts {
  const { repo, n } = parseRun(r.id);
  const host = hostOf(repo), onGit = host !== 'github', on = onGit ? { host } : {}; // GitHub's facts keep their keys
  const t = (() => { try { return trackerOf(repo); } catch (e) { return { why: (e as Error).message }; } })();
  const ask = typeof t !== 'string' ? t.why : (() => { try { return trackerFn(t, 'trust', 'tell who wrote an item'); } catch (e) { return (e as Error).message; } })();
  const said = typeof ask === 'string' ? undefined : ask(adapterCtx(), { repo, id: n }) as unknown;
  const who = typeof ask === 'string' ? { trustBroken: `${ask}, so ${r.id}'s author is unknown and not trusted`, ...(t === 'local' && onGit && { unverifiable: true }) } // D4: a file has no author to verify
    : typeof said === 'string' && said && said !== 'null' ? { association: said } // no answer is never trusted, and never intake's recorded association instead
    : { trustBroken: `tracker "${t as string}" gave no author association for ${r.id}, so its author is unknown and not trusted` };
  const autoMerge = autoMergeOn(repo); // D1: only when the project turned it on; never on the git host (D4)
  const policy = rules(repo).policy; // a broken config throws here, so decide/merge fail and the run escalates
  const pv = policy['deploy.preview']?.value, dep: { deploys?: Deploy[] } = {};
  if (pv && pv !== 'off') { // live, like CI: record the reviewed commit's deploy state now, then decide on what the log says
    shipTrack([{ run: r.id, repo, sha: r.reviewedSha, path: projects()[repo]?.path }]);
    dep.deploys = derive(read())[r.id]?.deploys || [];
  }
  if (!(onGit ? r.reviewedSha : r.pr)) return { ...who, autoMerge, checks: 'none', additions: 0, deletions: 0, files: [], rules: policy, ...(r.route && { pipelineCaps: runCapsOf(r) }), ...dep, ...on };
  const diff = onGit ? gitDiff(repo, r.reviewedSha as string) : JSON.parse(gh('pr', 'view', prNumber(repo, r.pr as string), '-R', repo, '--json', 'additions,deletions,files')) as ReturnType<typeof gitDiff>;
  // the project's CI provider on the reviewed commit; ci=skip doesn't read it, but a provider that can't answer still escalates
  const local = (sha?: string) => localResult(r.localChecks, policy['checks.commands']?.value, sha);
  const c = policy.ci?.value === 'skip' ? { ci: undefined, state: 'skipped', broken: ciBroken(repo) } : ciChecks(repo, { path: projects()[repo]?.path, sha: r.reviewedSha, changeRequest: r.pr }, local);
  const ci = { ...(c.ci && c.ci !== 'github-actions' && { ci: c.ci }), ...('detail' in c && c.detail && { ciDetail: c.detail }), ...(c.broken && { ciBroken: c.broken }) }; // GitHub's, as before: no extra keys
  return { ...who, autoMerge, checks: c.state, ...ci, additions: diff.additions, deletions: diff.deletions, files: diff.files.map((f) => f.path), rules: policy, ...(r.route && { pipelineCaps: runCapsOf(r) }), ...dep, ...on }; // a routed run: its pipeline's live caps
}
// A git project's diff: the reviewed commit against its fork point from the base (three dots), as GitHub counts a PR's.
// numstat -z: "added<TAB>deleted<TAB>path<NUL>"; a binary file's "-" counts 0 lines, as on GitHub.
// --attr-source=<empty tree>: the branch's own .gitattributes can't mark files -diff to count as binary (git 2.40, GIT_MIN).
const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };
function gitDiff(repo: string, sha: string) {
  const at = projects()[repo]?.path;
  if (!at) throw new Error(`no local clone registered for ${repo}`);
  const old = gitTooOld(git);
  if (old) throw new Error(old);
  const empty = git('-C', at, 'rev-parse', '--show-object-format').trim() === 'sha256' ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1, ref = baseRef(at, baseBranch(repo, at));
  const rows = git('-C', at, `--attr-source=${empty}`, 'diff', '--numstat', '-z', '--no-renames', `${ref}...${sha}`).split('\0').filter(Boolean).map((l) => l.split('\t'));
  // .git/info/attributes (a run's worktree shares it; --attr-source doesn't replace it, and --text doesn't beat its -diff) can make
  // any file "-". So a "-" file with no NUL in its first 8000 bytes (git's own binary test) counts every line of both versions.
  let fork: string | undefined;
  const count = (c: string, p: string) => { // fails closed: a blob git can't read throws, never counts 0
    if (!git('-C', at, '--literal-pathspecs', 'ls-tree', c, '--', p).trim()) return 0; // added or deleted: no blob on this side. Literal: a name like ":(top)x" is no pathspec magic
    const b = exec(io.git, ['-C', at, 'cat-file', 'blob', `${c}:${p}`], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: Infinity }) as Buffer; // any size: the default 1 MB threw
    return b.subarray(0, 8000).includes(0) ? 0 : b.reduce((n, x) => n + (x === 10 ? 1 : 0), 0) + (b.length && b[b.length - 1] !== 10 ? 1 : 0);
  };
  for (const x of rows) if (x[0] === '-') { const p = x.slice(2).join('\t'); fork ??= git('-C', at, 'merge-base', ref, sha).trim(); [x[0], x[1]] = [String(count(sha, p)), String(count(fork, p))]; }
  const lines = (i: number) => rows.reduce((t, x) => t + (Number(x[i]) || 0), 0);
  return { additions: lines(0), deletions: lines(1), files: rows.map((x) => ({ path: x.slice(2).join('\t') })) };
}
const firstLine = (e: unknown) => String((e as { stderr?: unknown })?.stderr || (e as Error)?.message || e).trim().split('\n')[0];
// The change request as its host sees it now: open, from the run's own branch (never a fork's, which a legacy log's typed PR can
// be), its head the reviewed commit. Anything else, or a host that can't say, escalates: F merges only what was reviewed.
function headCheck(r: Run, repo: string, n: string, host: string, path?: string, base?: string): Pick<Facts, 'headBroken'> {
  if (!r.pr || !r.reviewedSha) return {}; // decide() escalates on either
  let p: ReturnType<NonNullable<Host['changeRequest']>>;
  try { p = hostFn(host, 'changeRequest', 'look up a change request')(adapterCtx(), { repo, id: r.pr, ...(path && { path }), ...(base && { base }), sha: r.reviewedSha }); }
  catch (e) { return { headBroken: `cannot read change request ${r.pr}: ${firstLine(e)}` }; }
  const want = `factory/issue-${n}`;
  const why = p.state !== 'open' ? `change request ${r.pr} is ${p.state}${p.detail ? ` (${p.detail})` : ''}, not open`
    : p.fork ?? host === 'github' ? `change request ${r.pr} is from a fork` // GitHub always says; no answer counts as one
    : p.branch !== want ? `change request ${r.pr} is from ${p.branch}, not the run's branch ${want}`
    : p.headSha !== r.reviewedSha ? `change request head is ${String(p.headSha ?? 'unknown').slice(0, 7)}, not the reviewed commit ${r.reviewedSha.slice(0, 7)}` : '';
  return why ? { headBroken: why } : {};
}
// The only merge path: re-decides from live facts, checks the change request, and merges exactly the reviewed commit into the
// project's base. The host's answer decides what is recorded: merged:false escalates with its detail, never retried.
export function merge(run: string) {
  const r = getRun(run);
  const { repo, n } = parseRun(run), host = hostOf(repo), at = projects()[repo]?.path;
  const base = host !== 'github' && !r.imported && at ? baseBranch(repo, at) : undefined; // the project's own (F project set base), as worktree() used
  const f: Facts = r.imported ? {} : { ...facts(r), ...headCheck(r, repo, n, host, at, base) };
  const d = decide(r, f);
  record(run, 'approve', 'decided', { ...d, facts: f });
  if (d.action !== 'merge') return { merged: false, ...d };
  if (!r.reviewedSha) throw new Error('no reviewed commit recorded; refusing to merge');
  const m = hostFn(host, 'merge', 'merge')(adapterCtx(), { repo, id: r.pr as string, sha: r.reviewedSha, ...(base && { path: at, base }) }); // decide() escalates a run with no PR
  if (m?.merged !== true) { // fail closed: only an explicit true is a merge
    const no = { action: 'escalate', reasons: [`the host refused the merge: ${m?.detail || 'it gave no reason'}`] };
    record(run, 'approve', 'decided', { ...no, facts: f });
    return { merged: false, ...no };
  }
  record(run, 'approve', 'merged', { ...(m.sha && { sha: m.sha }) }); // the git host's squash; GitHub's comes from the PR (postmerge)
  if (host === 'github') relabelMerged(run);
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
  const { repo, n } = parseRun(run), t = trackerOf(repo);
  if (t !== 'github-issues') { // F approve's record, after the spec it approved (approve.ts)
    const { asked, said } = pending(r);
    if (!asked) throw new Error(`${run} is not awaiting approval`);
    return said ? { decision: said.decision, by: said.by } : { decision: 'waiting', next: `the user runs F approve ${run} in their own terminal` };
  }
  requireGithub(repo, 'reading spec approval');
  const asked = r.events.findLast((e) => e.status === 'awaiting-approval');
  if (!asked) throw new Error(`${run} is not awaiting approval`);
  if (!asked.postedSha) throw new Error(`${run}'s spec was never posted: F comment ${run} posts it, and a maintainer answers there`); // a vote is for the spec on the issue
  if (current(run) !== asked.postedSha) throw new Error(`${run}'s spec.md changed after it was posted: post it again (F comment ${run})`);
  return approvalVote(trackerFn(t, 'comments', 'read comments')(adapterCtx(), { repo, id: n }), asked.ts);
}
// The latest trusted "/factory approve|reject" posted after `since`. GitHub stamps comments to the whole second and F to the
// millisecond, so only a comment from a later second counts: one in the same second may predate the spec it would approve.
// Compared as times, never strings ("…:00Z" sorts after "…:00.900Z"). An unparsable created_at never counts.
export function approvalVote(comments: Comment[], since: string) {
  const from = Math.floor(Date.parse(since) / 1000) * 1000 + 1000;
  const vote = comments.filter((c) => Date.parse(c.created_at) >= from && TRUSTED.includes(c.association))
    .map((c) => ({ by: c.author, m: /^\s*\/factory\s+(approve|reject)\b/i.exec(c.body || '') })).filter((x) => x.m).pop();
  return vote ? { decision: ((vote.m as RegExpExecArray)[1] as string).toLowerCase(), by: vote.by } : { decision: 'waiting' }; // filtered on m; group 1 always matches
}
// After a merge: CI on the merge commit of the base branch.
export function postmerge(run: string): PostMerge {
  const r = getRun(run);
  const { repo } = parseRun(run), onGithub = hostOf(repo) === 'github';
  if (onGithub && !r.pr) return { state: 'no-pr', reason: 'no PR recorded for this run' }; // never `gh pr view undefined`
  const sha: string | undefined = onGithub ? JSON.parse(gh('pr', 'view', prNumber(repo, r.pr as string), '-R', repo, '--json', 'mergeCommit')).mergeCommit?.oid
    : r.events.findLast((e) => e.stage === 'approve' && e.status === 'merged')?.sha as string | undefined; // the git host's squash, as F merge recorded it
  if (!sha) return { state: 'not-merged' };
  const ship = shipTrack([{ run, repo, sha, path: projects()[repo]?.path }]), deploys = ship?.recorded.length ? { deploys: ship.recorded } : {}; // production deploy of the merge commit, when a connector reports one
  const policy = rules(repo).policy, ci = policy.ci?.value, broken = ciBroken(repo);
  if (broken) return { sha, state: 'unknown', reason: broken, ...deploys }; // fail closed: never "skipped" or "pass"
  if (ci === 'skip') return { sha, state: 'skipped', reason: 'rule ci=skip: CI on the base branch is not watched, so it never triggers a revert', ...deploys };
  // shortcut: F checks runs only in a run's worktree, never on the merge commit, so local CI can't watch the base after a merge;
  // run checks.commands in a fresh worktree of the merge commit here once that is wanted. Until then a definite skipped, never a state that can't change.
  if (['local', 'none'].includes(ciOf(repo))) {
    let base = 'the base branch';
    try { base = baseBranch(repo, projects()[repo]?.path ?? ''); } catch { /* the reason still says what to do */ }
    return { sha, state: 'skipped', reason: ciOf(repo) === 'none' ? `CI provider none: ${base} after the merge is not watched, so it never triggers a revert` : `CI provider local: ${base} after the merge is not checked, so it never triggers a revert; run the checks.commands on ${base} yourself`, ...deploys };
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
  fetchBase(repoPath, base);
  git('-C', repoPath, 'worktree', 'add', '-q', '-B', branch, wt, `refs/remotes/origin/${base}`); // a full ref: see baseRef
  try {
    git('-C', wt, 'revert', '--no-edit', pm.sha);
    git('-C', wt, 'push', '-q', '-u', 'origin', branch);
    const url = hostFn(hostOf(repo), 'openChangeRequest', 'open a change request')(adapterCtx(), { repo, branch, base, title: `Revert: ${r.title}`,
      body: `Reverts ${r.pr} (#${n}): ${reason}\n\nOpened by the software factory. Needs a human to merge.`, labels: ['factory:needs-human'] }).id;
    record(run, 'approve', 'reverted', { pr: url, reason });
    return { pr: url };
  } finally {
    try { git('-C', repoPath, 'worktree', 'remove', '--force', wt); git('-C', repoPath, 'branch', '-D', branch); } catch { /* best effort */ }
  }
}
