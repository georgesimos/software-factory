// A project whose clone is not on GitHub (docs/plans/local-first.md §1.2): plain git, the remote only when there is one.
// It has no server, so it never creates a repo (F new needs github), and no login: whoever acts is the OS user, unverified.
import type { Ctx } from './index.ts';

export const id = 'git';

// F new checks this first and records nothing when it fails: the git host never starts a new project.
const NO_SERVER = 'host "git" cannot create a repo: it has no server; start the project on github, or attach an existing clone with F sync';
export const authStatus = () => ({ ok: false, detail: NO_SERVER });
export function createRepo(): never { throw new Error(NO_SERVER); }
export function pushInitial(): never { throw new Error('host "git" cannot push a first commit: it creates no repo'); }

export const whoami = (_ctx: Ctx, { user }: { user: () => string }) => ({ login: String(user()).trim(), verified: false });

// The project's own base (F project set <repo> base), else origin's HEAD, else main or master: on origin when the clone has one, else locally. It
// refuses when none exists, rather than guess. A set base must be a branch on origin when the clone has one (runs fetch it
// from there, and reviewers see it there), else a local branch: never a tag, a sha or @{-1}.
export function baseBranch({ git }: Ctx, { path, base }: { repo: string; path: string; base?: string }) {
  const has = (ref: string) => { try { git('-C', path, 'rev-parse', '--verify', '-q', `${ref}^{commit}`); return true; } catch { return false; } };
  let origin = false;
  try { origin = !!git('-C', path, 'remote', 'get-url', 'origin').trim(); } catch { /* none */ }
  if (base) {
    if (has(origin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`)) return base;
    throw new Error(origin ? `the project's base branch ${base} is not on origin in ${path} (push it, then git fetch origin)` : `the project's base branch ${base} is not a branch in ${path}`);
  }
  // a clone with an origin takes the base from origin only: runs fetch it from there (a local-only main would fail that fetch)
  if (origin) try {
    const ref = git('-C', path, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD').trim();
    if (ref.startsWith('origin/') && has(`refs/remotes/${ref}`)) return ref.slice('origin/'.length);
  } catch { /* no origin/HEAD */ }
  for (const b of ['main', 'master']) if (has(origin ? `refs/remotes/origin/${b}` : `refs/heads/${b}`)) return b;
  throw new Error(`cannot tell the base branch of ${path}: it has no main or master branch${origin ? ' on origin, and no origin/HEAD (git fetch origin; git remote set-head origin -a)' : ''}`);
}

// ---- change requests (local-first PR 4b): a change request is the branch factory/issue-N at a sha ----
// Rule: no force flag ever touches a base branch. The base moves only by a plain push (the remote refuses a non-fast-forward)
// or `update-ref <ref> <new> <seen>` (refused unless the ref still holds what was seen). test/githost.test.mjs greps this file.
const branchOf = (id: string) => id.split('@')[0]!;
const tryGit = (git: Ctx['git'], ...a: string[]) => { try { return git(...a).trim(); } catch { return null; } };
const hasOrigin = (git: Ctx['git'], path: string) => !!tryGit(git, '-C', path, 'remote', 'get-url', 'origin');
const firstLine = (e: unknown) => String((e as { stderr?: unknown })?.stderr || (e as Error)?.message || e).trim().split('\n').filter((l) => !/^(hint|To) /.test(l))[0] || 'refused';

// Pushes the branch (a plain push) when the project has a remote; with none it stays local. The id pins the sha.
export function openChangeRequest({ git }: Ctx, { path, branch }: { repo: string; path: string; branch: string; base: string; title: string; body: string }) {
  const sha = git('-C', path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`).trim();
  if (hasOrigin(git, path)) git('-C', path, 'push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  return { id: `${branch}@${sha.slice(0, 7)}` };
}

// The branch's head now, and merged once the base contains it (a human's merge or fast-forward). A squash merged elsewhere
// isn't visible to git: F close RUN --merged <sha> records it. approval: F approve RUN --merge (local-first PR 7).
export function changeRequest({ git }: Ctx, { path, id, base }: { repo: string; path: string; id: string; base?: string }) {
  const branch = branchOf(id), origin = hasOrigin(git, path);
  if (origin) tryGit(git, '-C', path, 'fetch', '-q', 'origin');
  const headSha = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) ?? tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`);
  const at = base && (origin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`);
  // the factory's own squash names the head it merged; a human's merge or fast-forward puts the head itself on the base
  const mergeSha = headSha && at ? tryGit(git, '-C', path, 'log', '-1', '--format=%H', '--fixed-strings', `--grep=Squash of ${headSha}, merged by the software factory.`, at) || undefined : undefined;
  const merged = !!mergeSha || !!(headSha && at && tryGit(git, '-C', path, 'merge-base', '--is-ancestor', headSha, at) !== null);
  return { state: merged ? 'merged' as const : headSha ? 'open' as const : 'unknown' as const, headSha, approval: null, branch, ...(mergeSha && { mergeSha }) };
}

// Squashes exactly sha onto the base as it is now, then moves the base only if nobody moved it since (see the rule above).
// merged:false with a detail on every refusal (a moved base, a conflict, a protected base): never retried, never forced.
export function merge({ git }: Ctx, { path, id, sha, base }: { repo: string; path: string; id: string; sha: string; base: string }) {
  const branch = branchOf(id), no = (detail: string) => ({ merged: false, detail });
  if (tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) !== sha) return no(`${branch} is not at the reviewed commit ${sha.slice(0, 7)}`);
  const origin = hasOrigin(git, path), ref = origin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
  if (origin) try { git('-C', path, 'fetch', '-q', 'origin', `refs/heads/${base}:${ref}`); } catch (e) { return no(`cannot fetch ${base} from origin: ${firstLine(e)}`); }
  const seen = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
  if (!seen) return no(`no ${base} branch${origin ? ' on origin' : ''}`);
  let tree: string; // a merge with no checkout: the index and files of the user's clone are never touched
  try { tree = git('-C', path, 'merge-tree', '--write-tree', '--no-messages', seen, sha).trim().split('\n')[0]!; } catch (e) { // exit 1 is a conflict; anything else (an old git, a bad object) is not
    // merge base into the branch, never rebase: a rebased branch's plain push would be refused as a non-fast-forward
    return no((e as { status?: number })?.status === 1 ? `${branch} conflicts with ${base}: merge ${base} into it, then review it again` : `cannot merge ${branch}: ${firstLine(e)}`);
  }
  let mergeSha: string; // its parent is the base seen: a moved base makes it a non-fast-forward
  try {
    const msg = `${git('-C', path, 'log', '-1', '--format=%s', sha).trim()} (${branch})\n\nSquash of ${sha}, merged by the software factory.`;
    mergeSha = git('-C', path, 'commit-tree', tree, '-p', seen, '-m', msg).trim();
  } catch (e) { return no(`cannot commit the squash of ${branch}: ${firstLine(e)}`); }
  if (origin) {
    try { git('-C', path, 'push', '-q', 'origin', `${mergeSha}:refs/heads/${base}`); } catch (e) {
      return no(`push to ${base} refused (${firstLine(e)}): merge ${branch} at your host, then F close RUN --merged <sha>`);
    }
    tryGit(git, '-C', path, 'update-ref', ref, mergeSha, seen); // the tracking ref, as a fetch would set it
    return { merged: true, sha: mergeSha };
  }
  // no remote: where base is checked out, a clean worktree fast-forwards (so its files follow); otherwise compare-and-swap the ref
  const wts = git('-C', path, 'worktree', 'list', '--porcelain').split('\n\n').map((b) => ({ dir: /^worktree (.+)$/m.exec(b)?.[1], on: /^branch (.+)$/m.exec(b)?.[1] }));
  const out = wts.find((w) => w.on === `refs/heads/${base}`)?.dir;
  if (out) {
    if (tryGit(git, '-C', out, 'status', '--porcelain', '--untracked-files=no')) return no(`${base} is checked out with uncommitted changes in ${out}: commit or stash them, then merge again`);
    try { git('-C', out, 'merge', '-q', '--ff-only', mergeSha); } catch (e) { return no(`${base} moved while merging (${firstLine(e)}): review again`); }
  } else try { git('-C', path, 'update-ref', `refs/heads/${base}`, mergeSha, seen); } catch (e) { return no(`${base} moved while merging (${firstLine(e)}): review again`); }
  return { merged: true, sha: mergeSha };
}
