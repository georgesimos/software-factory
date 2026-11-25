// GitHub repo host, through the logged-in `gh`. ctx.gh / ctx.git run the CLIs without a shell (the self-test passes stubs).
import type { Ctx } from './index.ts';

export const id = 'github';

export function authStatus({ gh }: Ctx) {
  try { gh('auth', 'status'); } catch (e) { return { ok: false, detail: String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n').slice(0, 3).join(' ') }; }
  return { ok: true, login: gh('api', 'user', '--jq', '.login').trim() };
}

const urlOf = (gh: Ctx['gh'], repo: string) => { try { return gh('repo', 'view', repo, '--json', 'url', '--jq', '.url').trim(); } catch { return null; } };

// Never touches a repo that already exists: it reports created:false and the caller decides.
export function createRepo({ gh }: Ctx, { repo, visibility, description }: { repo: string; visibility: string; description?: string }) {
  const have = urlOf(gh, repo);
  if (have) return { created: false, url: have };
  if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be private|public');
  gh('repo', 'create', repo, `--${visibility}`, '--description', String(description || '').slice(0, 300));
  return { created: true, url: urlOf(gh, repo) || `https://github.com/${repo}` };
}

// Adds origin and pushes the scaffold commit to main. A plain push: it fails rather than overwrite anything.
// shortcut: an https remote needs gh's git credential helper (`gh auth setup-git`); read gh's git_protocol if ssh users hit this.
export function pushInitial({ gh, git }: Ctx, { repo, path, branch = 'main' }: { repo: string; path: string; branch?: string }) {
  const url = urlOf(gh, repo);
  if (!url) throw new Error(`${repo} does not exist`);
  const remote = url.endsWith('.git') ? url : url + '.git';
  if (!git('-C', path, 'remote').split('\n').includes('origin')) git('-C', path, 'remote', 'add', 'origin', remote);
  git('-C', path, 'push', '-q', '-u', 'origin', `HEAD:${branch}`);
  return { pushed: true, remote, branch };
}

// A verified login, or null when gh is missing or logged out. Any other failure (offline, rate-limited) throws: a logged-in
// user must never be recorded as unverified.
export function whoami({ gh }: Ctx) {
  const out = (x: unknown) => String((x as { stderr?: unknown })?.stderr ?? '') + String((x as { stdout?: unknown })?.stdout ?? '');
  let login = '';
  try { login = gh('api', 'user', '--jq', '.login').trim(); } catch (e) {
    let noLogin = (e as { code?: string })?.code === 'ENOENT'; // gh not installed
    if (!noLogin) try { gh('auth', 'status'); } catch (s) { noLogin = /not logged in/i.test(out(s)); } // exits 1 with no login, and on a failed check
    if (!noLogin) throw new Error(`gh is logged in but "gh api user" failed (${out(e).trim().split('\n')[0] || (e as Error)?.message}); try again`);
  }
  return login ? { login, verified: true } : null;
}

// GitHub's default branch; a project's own base setting does not apply here.
export const baseBranch = ({ gh }: Ctx, { repo }: { repo: string }) => gh('repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name').trim();

// ---- change requests: moved here from core's github.ts and sync.ts (local-first PR 4a), with the same gh calls ----

/** An open PR as GitHub's GraphQL gives it. */
interface GhPullRequest {
  number: number; url: string; title: string; headRefName: string; headRefOid: string; authorAssociation: string; author?: { login: string } | null;
  closingIssuesReferences: { nodes: { number: number }[] };
}
// The default branch, the open PRs, and the branches of the last 100 merged or closed ones (what sync and intake read).
export function listChangeRequests({ gh }: Ctx, { repo }: { repo: string }) {
  const [o, n] = repo.split('/');
  const q = 'query($o:String!,$n:String!){repository(owner:$o,name:$n){defaultBranchRef{name} pullRequests(states:OPEN,first:100){nodes{number url title headRefName headRefOid authorAssociation author{login} closingIssuesReferences(first:20){nodes{number}}}} done: pullRequests(states:[MERGED,CLOSED],last:100){nodes{headRefName}}}}';
  const r: { defaultBranchRef: { name: string }; pullRequests: { nodes: GhPullRequest[] }; done?: { nodes: { headRefName: string }[] } | null } = JSON.parse(gh('api', 'graphql', '-f', `query=${q}`, '-f', `o=${o}`, '-f', `n=${n}`)).data.repository;
  return {
    base: r.defaultBranchRef.name, doneBranches: (r.done?.nodes || []).map((x) => x.headRefName),
    open: r.pullRequests.nodes.map((p) => ({ id: String(p.number), url: p.url, title: p.title, branch: p.headRefName, headSha: p.headRefOid,
      closes: p.closingIssuesReferences.nodes.map((x) => String(x.number)), author: p.author?.login, association: p.authorAssociation })),
  };
}
// A recorded PR (its URL, or a number) as gh's PR number on repo. gh takes the repo from a URL over -R, so a URL is never
// passed on, and one on another repo is refused: F acts only on the run's own repo.
export function prNumber(repo: string, id: string) {
  if (/^\d+$/.test(id)) return id;
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(id);
  if (!m || m[1]!.toLowerCase() !== repo.toLowerCase()) throw new Error(`${id} is not a pull request on ${repo}: refusing to act on it`);
  return m[2]!;
}
// One PR by number, as sync's human-merge check (#21) reads it. Throws when gh fails: the caller reports it.
// shortcut: no headSha (headRefOid) yet, so the gh call is the one sync always made; add it when a caller reads it.
export function changeRequest({ gh }: Ctx, { repo, id }: { repo: string; id: string }) {
  const p: { state: string; mergedAt: string | null; mergedBy?: { login: string } | null; mergeCommit?: { oid: string } | null; headRefName: string; isCrossRepository?: boolean } =
    JSON.parse(gh('pr', 'view', prNumber(repo, id), '-R', repo, '--json', 'state,mergedAt,mergedBy,mergeCommit,headRefName,isCrossRepository'));
  const state = ({ OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' } as const)[p.state as 'OPEN'] ?? 'unknown';
  return { state, approval: null, branch: p.headRefName, fork: p.isCrossRepository, mergedAt: p.mergedAt, mergedBy: p.mergedBy?.login, mergeSha: p.mergeCommit?.oid }; // approval: GitHub merges on the gates alone (D2)
}
// Marks the PR ready, then squash-merges exactly sha (--match-head-commit). A refusal throws, as it always has.
export function merge({ gh }: Ctx, { repo, id, sha }: { repo: string; id: string; sha: string }) {
  const n = prNumber(repo, id);
  gh('pr', 'ready', n, '-R', repo);
  gh('pr', 'merge', n, '-R', repo, '--squash', '--delete-branch', '--match-head-commit', sha);
  return { merged: true };
}
// Opens a PR from an already pushed branch; labels must exist (sync creates the factory's).
export function openChangeRequest({ gh }: Ctx, { repo, branch, base, title, body, labels = [], draft = false }: { repo: string; branch: string; base: string; title: string; body: string; labels?: string[]; draft?: boolean }) {
  const url = gh('pr', 'create', '-R', repo, '--base', base, '--head', branch, '--title', title, '--body', body, ...labels.flatMap((l) => ['--label', l]), ...(draft ? ['--draft'] : [])).trim();
  return { id: url, url };
}
// A PR (id: its URL) or, with none, the issue: ready, factory:needs-human and the comment, through the REST issues endpoints
// with JSON on stdin (a Windows gh.cmd shim can't pass labels[] brackets). Each step is cosmetic: a failure is reported, never
// thrown; a PR on another repo is refused.
export function escalate({ gh, ghInput }: Ctx, { repo, id, issue, body }: { repo: string; id?: string; issue: string; body: string }) {
  const n = id ? prNumber(repo, id) : issue;
  const ok = (f: () => unknown) => { try { f(); return true; } catch { return false; } };
  if (!ghInput) throw new Error('github escalate needs ctx.ghInput (gh with stdin)');
  const api = (what: string, input: object) => ghInput(JSON.stringify(input), 'api', '-X', 'POST', `repos/${repo}/issues/${n}/${what}`, '--input', '-');
  const ready = !!id && ok(() => gh('pr', 'ready', n, '-R', repo));
  const labelled = ok(() => api('labels', { labels: ['factory:needs-human'] })), posted = ok(() => api('comments', { body }));
  return { posted, labelled, ready, ...(!(posted && labelled && (ready || !id)) && { detail: `some of ready, label and comment failed on ${repo}#${n}` }) };
}
// What the published page's scrub removes (any GitHub URL), and GitHub's token shapes for its leak check.
export const publicUrl = /(?:https?:\/\/)?(?:www\.)?github\.com[/:][^\s"\\,]*/gi; // JSON text: \n is two characters, so stop at '\' too
export const secretPatterns = [/gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_\w{30,}/];
