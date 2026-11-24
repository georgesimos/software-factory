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
// or `update-ref <ref> <new> <old>` (refused unless the ref still holds old). test/githost.test.mjs greps this file.
type Git = Ctx['git'];
const branchOf = (id: string) => id.split('@')[0]!;
const tryGit = (git: Git, ...a: string[]) => { try { return git(...a).trim(); } catch { return null; } };
const hasOrigin = (git: Git, path: string) => !!tryGit(git, '-C', path, 'remote', 'get-url', 'origin');
const firstLine = (e: unknown) => String((e as { stderr?: unknown })?.stderr || (e as Error)?.message || e).trim().split('\n').filter((l) => !/^(hint|To) /.test(l))[0] || 'refused';
const treeOf = (git: Git, path: string, c: string) => git('-C', path, 'rev-parse', `${c}^{tree}`).trim();

// merge-tree --write-tree needs git 2.38: checked once per git, so an old git says so instead of failing as a conflict.
// A failed `git version` isn't remembered: it says so, and the next call asks again.
const versions = new WeakMap<Git, string | null>();
export function mergeTreeMissing(git: Git): string | null {
  if (versions.has(git)) return versions.get(git)!;
  const out = tryGit(git, 'version');
  if (out === null) return 'cannot run git version: is git installed?';
  const v = /(\d+)\.(\d+)/.exec(out);
  const missing = v && (+v[1]! > 2 || (+v[1]! === 2 && +v[2]! >= 38)) ? null : `git ${v ? `${v[1]}.${v[2]}` : `"${out}"`} is too old: merging needs git 2.38 or later (merge-tree --write-tree)`;
  versions.set(git, missing);
  return missing;
}
// The tree of merging theirs into ours with no checkout, or null on a conflict: exit 1 with the conflicted tree on stdout.
// git also exits 1 for an unknown commit, with nothing on stdout; that and anything else throws its first line.
export function mergeTree(git: Git, path: string, ours: string, theirs: string): string | null {
  const old = mergeTreeMissing(git);
  if (old) throw new Error(old);
  try { return git('-C', path, 'merge-tree', '--write-tree', '--no-messages', ours, theirs).trim().split('\n')[0]!; }
  catch (e) {
    const x = e as { status?: number; stdout?: unknown };
    if (x?.status === 1 && /^[0-9a-f]{40,64}$/.test(String(x.stdout ?? '').trim().split('\n')[0]!)) return null;
    throw new Error(firstLine(e));
  }
}
// sha brought every change of reviewed onto its line: merging reviewed into sha changes nothing, and into sha's first
// parent it would. So a squash of exactly it, a merge commit or a fast-forward to it; never a later commit or a revert.
export function introduces(git: Git, path: string, sha: string, reviewed: string) {
  if (mergeTree(git, path, sha, reviewed) !== treeOf(git, path, sha)) return false;
  const parent = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `${sha}^1`);
  return !parent || mergeTree(git, path, parent, reviewed) !== treeOf(git, path, parent);
}

// Pushes the branch (a plain push) when the project has a remote; with none it stays local. The id pins the sha.
export function openChangeRequest({ git }: Ctx, { path, branch }: { repo: string; path: string; branch: string; base: string; title: string; body: string }) {
  const sha = git('-C', path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`).trim();
  if (hasOrigin(git, path)) git('-C', path, 'push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  return { id: `${branch}@${sha.slice(0, 7)}` };
}

// The branch's head now, and merged once the reviewed commit (sha) is on the base, or the base has the factory's own squash
// of it. Being on the base proves nothing without sha: a branch just cut from the base is on it too. The squash is
// confirmed by its tree, never by its message alone. A squash merged elsewhere: F close RUN --merged <sha>.
// approval: F approve RUN --merge (local-first PR 7).
export function changeRequest(ctx: Ctx, { repo, path, id, base, sha }: { repo: string; path: string; id: string; base?: string; sha?: string }) {
  const { git } = ctx, branch = branchOf(id), origin = hasOrigin(git, path);
  if (origin) tryGit(git, '-C', path, 'fetch', '-q', 'origin');
  const headSha = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) ?? tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`);
  const b = base ?? baseBranch(ctx, { repo, path }), at = origin ? `refs/remotes/origin/${b}` : `refs/heads/${b}`;
  const target = sha ?? headSha;
  let mergeSha: string | undefined;
  if (target) {
    const [c, parent, ...more] = (tryGit(git, '-C', path, 'log', '-1', '--format=%H %P', '--fixed-strings', `--grep=Squash of ${target}, merged by the software factory.`, at) ?? '').split(' ');
    if (c && parent && !more.length) { const t = treeOf(git, path, c); if (t !== treeOf(git, path, parent) && mergeTree(git, path, parent, target) === t) mergeSha = c; }
  }
  const merged = !!mergeSha || !!(sha && tryGit(git, '-C', path, 'merge-base', '--is-ancestor', sha, at) !== null);
  return { state: merged ? 'merged' as const : headSha ? 'open' as const : 'unknown' as const, headSha, approval: null, branch, ...(mergeSha && { mergeSha }) };
}

// Squashes exactly sha onto the base as it is now, then moves the base only if nobody moved it since (see the rule above).
// merged:false with a detail on every refusal (a moved base, a conflict, a protected base): never retried, never forced.
export function merge(ctx: Ctx, { repo, path, id, sha, base }: { repo: string; path: string; id: string; sha: string; base?: string }) {
  const { git } = ctx, branch = branchOf(id), no = (detail: string) => ({ merged: false, detail });
  if (tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) !== sha) return no(`${branch} is not at the reviewed commit ${sha.slice(0, 7)}`);
  const old = mergeTreeMissing(git);
  if (old) return no(old);
  try { base ??= baseBranch(ctx, { repo, path }); } catch (e) { return no(firstLine(e)); }
  const origin = hasOrigin(git, path), ref = origin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
  if (origin) try { git('-C', path, 'fetch', '-q', 'origin', `refs/heads/${base}:${ref}`); } catch (e) { return no(`cannot fetch ${base} from origin: ${firstLine(e)}`); }
  const seen = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
  if (!seen) return no(`no ${base} branch${origin ? ' on origin' : ''}`);
  // already there (a retry after a fast-forward, or a human's): nothing to squash, nothing pushed
  if (tryGit(git, '-C', path, 'merge-base', '--is-ancestor', sha, seen) !== null) return { merged: true, detail: `${sha.slice(0, 7)} is already on ${base}` };
  let tree: string | null; // a merge with no checkout: the index and files of the user's clone are never touched
  try { tree = mergeTree(git, path, seen, sha); } catch (e) { return no(`cannot merge ${branch}: ${(e as Error).message}`); }
  // merge base into the branch, never rebase: a rebased branch's plain push would be refused as a non-fast-forward
  if (tree === null) return no(`${branch} conflicts with ${base}: merge ${base} into it, then review it again`);
  if (tree === treeOf(git, path, seen)) return no(`${branch} changes nothing on ${base}: it is merged already, or empty`);
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
  // no remote: compare-and-swap the base; where it is checked out, its clean files then follow (checked first, by a dry run)
  const wt = git('-C', path, 'worktree', 'list', '--porcelain').split('\n\n').map((b) => ({ dir: /^worktree (.+)$/m.exec(b)?.[1], on: /^branch (.+)$/m.exec(b)?.[1], gone: /^prunable/m.test(b) })).find((w) => w.on === ref);
  if (wt) {
    if (wt.gone) return no(`${base} is checked out in ${wt.dir}, which is missing: git worktree prune, then merge again`);
    let dirty: string;
    try { dirty = git('-C', wt.dir!, 'status', '--porcelain', '--untracked-files=no').trim(); } catch (e) { return no(`cannot read ${base}'s checkout in ${wt.dir} (${firstLine(e)}): merge again once it is back`); }
    if (dirty) return no(`${base} is checked out with uncommitted changes in ${wt.dir}: commit or stash them, then merge again`);
    try { git('-C', wt.dir!, 'read-tree', '-m', '-u', '-n', seen, mergeSha); } catch (e) { return no(`cannot update ${base}'s files in ${wt.dir}: ${firstLine(e)}`); }
  }
  try { git('-C', path, 'update-ref', ref, mergeSha, seen); } catch (e) { return no(`${base} moved while merging (${firstLine(e)}): review again`); }
  if (wt) try { git('-C', wt.dir!, 'read-tree', '-m', '-u', seen, mergeSha); } catch (e) {
    const back = tryGit(git, '-C', path, 'update-ref', ref, seen, mergeSha); // undone only if the ref still holds the squash
    return no(`cannot update ${base}'s files in ${wt.dir} (${firstLine(e)})${back === null ? `; ${base} is at the squash, so check that checkout` : ''}: merge again`);
  }
  return { merged: true, sha: mergeSha };
}
