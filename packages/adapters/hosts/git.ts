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
// Paths that differ between two commits (no rename pairing), sorted.
const changed = (git: Git, path: string, a: string, b: string) => git('-C', path, 'diff', '--name-only', '-z', '--no-renames', a, b).split('\0').filter(Boolean).sort();
const NUL = '\0';
// sha is the commit that brought exactly the reviewed change onto its line: a squash of it (onto a moved base too), a merge
// commit, or a fast-forward to it. Its own change (first parent to sha) touches exactly the paths the reviewed change
// touches (fork point to reviewed) and equals merging reviewed into that parent. So never a squash with extra files, a
// partial squash or the commit that completed one, a later commit, a revert, or one that changed it again.
// A sha whose parent isn't here (a root commit, or a shallow clone) is refused.
export function introduces(git: Git, path: string, sha: string, reviewed: string) {
  const parent = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `${sha}^1^{commit}`);
  if (!parent) return false;
  let fork: string;
  try { fork = git('-C', path, 'merge-base', parent, reviewed).trim(); }
  catch (e) { if ((e as { status?: number })?.status === 1) return false; throw new Error(firstLine(e)); } // 1: no common history
  const want = changed(git, path, fork, reviewed).join(NUL);
  return !!want && changed(git, path, parent, sha).join(NUL) === want && mergeTree(git, path, parent, reviewed) === treeOf(git, path, sha);
}

// The base as the clone sees it: origin's when there is one, else the local branch.
const baseRef = (origin: boolean, base: string) => (origin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`);
// exit 0: a is on b. exit 1: it isn't. Anything else (an unknown commit) throws its first line.
function isAncestor(git: Git, path: string, a: string, b: string) {
  try { git('-C', path, 'merge-base', '--is-ancestor', a, b); return true; }
  catch (e) { if ((e as { status?: number })?.status === 1) return false; throw new Error(firstLine(e)); }
}
const noChanges = (sha: string, base: string) => `${sha.slice(0, 7)} is already on ${base}: no changes to merge (if you merged it yourself: F close RUN --merged <sha>)`;

// Pushes the branch (a plain push) when the project has a remote; with none it stays local. The id pins the sha. A branch
// with nothing beyond the base is refused: there is nothing to review, and later it would look merged.
export function openChangeRequest({ git }: Ctx, { path, branch, base }: { repo: string; path: string; branch: string; base: string; title: string; body: string }) {
  const sha = git('-C', path, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`).trim(), origin = hasOrigin(git, path);
  if (origin) git('-C', path, 'fetch', '-q', 'origin', `refs/heads/${base}:${baseRef(true, base)}`);
  if (isAncestor(git, path, sha, baseRef(origin, base))) throw new Error(`${branch} has no commits beyond ${base}: nothing to review`);
  if (origin) git('-C', path, 'push', '-q', 'origin', `refs/heads/${branch}:refs/heads/${branch}`);
  return { id: `${branch}@${sha.slice(0, 7)}` };
}

// The branch's head now, and merged only when the base has the factory's own squash of the reviewed commit (sha, else the
// head), confirmed by its tree, never by its message alone. A commit already on the base is "no changes", not merged: an
// empty branch and a human's fast-forward look the same to git. A human's merge: F close RUN --merged <sha>.
// approval: F approve RUN --merge (local-first PR 7).
export function changeRequest(ctx: Ctx, { repo, path, id, base, sha }: { repo: string; path: string; id: string; base?: string; sha?: string }) {
  const { git } = ctx, branch = branchOf(id), origin = hasOrigin(git, path);
  if (origin) tryGit(git, '-C', path, 'fetch', '-q', 'origin');
  const headSha = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) ?? tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`);
  const b = base ?? baseBranch(ctx, { repo, path }), at = baseRef(origin, b);
  const target = sha ?? headSha;
  let mergeSha: string | undefined;
  if (target) {
    const [c, parent, ...more] = (tryGit(git, '-C', path, 'log', '-1', '--format=%H %P', '--fixed-strings', `--grep=Squash of ${target}, merged by the software factory.`, at) ?? '').split(' ');
    if (c && parent && !more.length) { const t = treeOf(git, path, c); if (t !== treeOf(git, path, parent) && mergeTree(git, path, parent, target) === t) mergeSha = c; }
  }
  const empty = !mergeSha && !!target && isAncestor(git, path, target, at);
  return { state: mergeSha ? 'merged' as const : headSha ? 'open' as const : 'unknown' as const, headSha, approval: null, branch, ...(mergeSha && { mergeSha }), ...(empty && { detail: noChanges(target!, b) }) };
}

// The base's checkouts: worktrees with it as HEAD (prunable: the directory is gone).
const checkouts = (git: Git, path: string, ref: string) => git('-C', path, 'worktree', 'list', '--porcelain').split('\n\n')
  .map((b) => ({ dir: /^worktree (.+)$/m.exec(b)?.[1] ?? '', on: /^branch (.+)$/m.exec(b)?.[1], gone: /^prunable/m.test(b) })).filter((w) => w.on === ref);
// An ignored file the squash would overwrite or delete: at a changed path, under one (a directory that becomes a file),
// or in the way of one (a file where a directory comes). read-tree treats ignored files as expendable; the user may not.
function ignoredInTheWay(git: Git, dir: string, paths: string[]) {
  // --directory lists a wholly ignored directory once (node_modules/), so the output stays small; no pathspecs, so no argv limit
  const ignored = git('-C', dir, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory').split('\0').filter(Boolean).map((p) => p.replace(/\/$/, ''));
  return ignored.find((i) => paths.some((p) => i === p || i.startsWith(`${p}/`) || p.startsWith(`${i}/`)));
}

// Squashes exactly sha onto the base as it is now, then moves the base only if nobody moved it since (see the rule above).
// merged:false with a detail on every refusal (a moved base, a conflict, a protected base): never retried, never forced.
export function merge(ctx: Ctx, { repo, path, id, sha, base }: { repo: string; path: string; id: string; sha: string; base?: string }) {
  const { git } = ctx, branch = branchOf(id), no = (detail: string) => ({ merged: false, detail });
  if (tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`) !== sha) return no(`${branch} is not at the reviewed commit ${sha.slice(0, 7)}`);
  const old = mergeTreeMissing(git);
  if (old) return no(old);
  try { base ??= baseBranch(ctx, { repo, path }); } catch (e) { return no(firstLine(e)); }
  const origin = hasOrigin(git, path), ref = baseRef(origin, base);
  if (origin) try { git('-C', path, 'fetch', '-q', 'origin', `refs/heads/${base}:${ref}`); } catch (e) { return no(`cannot fetch ${base} from origin: ${firstLine(e)}`); }
  const seen = tryGit(git, '-C', path, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
  if (!seen) return no(`no ${base} branch${origin ? ' on origin' : ''}`);
  try { if (isAncestor(git, path, sha, seen)) return no(noChanges(sha, base)); } catch (e) { return no(`cannot merge ${branch}: ${(e as Error).message}`); }
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
    // A plain push refuses only a non-fast-forward: origin's base reset to an ancestor of seen, or deleted, would take it.
    // So origin's base must still be exactly seen. shortcut: a reset or delete between this check and the push still
    // lands (docs/plans/local-first.md, 4b known limits); closing it needs a lease on the exact sha, which the no-force rule forbids for now.
    const now = tryGit(git, '-C', path, 'ls-remote', 'origin', `refs/heads/${base}`);
    if (now === null) return no(`cannot read ${base} on origin: merge again`);
    const at = now.split('\n').find((l) => l.endsWith(`\trefs/heads/${base}`))?.split('\t')[0];
    if (at !== seen) return no(`${base} on origin moved while merging (${at ? `now ${at.slice(0, 7)}` : 'deleted'}, was ${seen.slice(0, 7)}): review again`);
    try { git('-C', path, 'push', '-q', 'origin', `${mergeSha}:refs/heads/${base}`); } catch (e) {
      return no(`push to ${base} refused (${firstLine(e)}): merge ${branch} at your host, then F close RUN --merged <sha>`);
    }
    tryGit(git, '-C', path, 'update-ref', ref, mergeSha, seen); // the tracking ref, as a fetch would set it
    return { merged: true, sha: mergeSha };
  }
  // No remote: compare-and-swap the base. Where it is checked out (once at most), the checkout must be there and clean, a dry
  // run must show its files can follow, and no ignored file may be in the way; after the swap the checkouts are listed again
  // and that one's HEAD re-read, and any change undoes the swap. shortcut: a checkout switched between that re-check and
  // read-tree still gets the squash staged; git has no lock spanning both. Upgrade if it is ever seen in practice.
  const before = checkouts(git, path, ref);
  if (before.length > 1) return no(`${base} is checked out in ${before.length} worktrees (${before.map((w) => w.dir).join(', ')}): leave one, then merge again`);
  const wt = before[0];
  if (wt) {
    if (wt.gone) return no(`${base} is checked out in ${wt.dir}, which is missing: git worktree prune, then merge again`);
    let dirty: string;
    try { dirty = git('-C', wt.dir, 'status', '--porcelain', '--untracked-files=no').trim(); } catch (e) { return no(`cannot read ${base}'s checkout in ${wt.dir} (${firstLine(e)}): merge again once it is back`); }
    if (dirty) return no(`${base} is checked out with uncommitted changes in ${wt.dir}: commit or stash them, then merge again`);
    try { git('-C', wt.dir, 'read-tree', '-m', '-u', '-n', seen, mergeSha); } catch (e) { return no(`cannot update ${base}'s files in ${wt.dir}: ${firstLine(e)}`); }
    let inTheWay: string | undefined;
    try { inTheWay = ignoredInTheWay(git, wt.dir, changed(git, path, seen, mergeSha)); } catch (e) { return no(`cannot check ${base}'s ignored files in ${wt.dir}: ${firstLine(e)}`); }
    if (inTheWay) return no(`${base}'s checkout in ${wt.dir} has an ignored file the merge would overwrite or delete (${inTheWay}): move it, then merge again`);
  }
  try { git('-C', path, 'update-ref', ref, mergeSha, seen); } catch (e) { return no(`${base} moved while merging (${firstLine(e)}): review again`); }
  const undo = (why: string) => { const back = tryGit(git, '-C', path, 'update-ref', ref, seen, mergeSha); return no(`${why}${back === null ? `; ${base} is at the squash, so check that checkout` : ''}: merge again`); }; // undone only if the ref still holds the squash
  let after: ReturnType<typeof checkouts>;
  try { after = checkouts(git, path, ref); } catch (e) { return undo(`cannot list ${base}'s checkouts (${firstLine(e)})`); }
  if (after.length !== (wt ? 1 : 0) || (wt && (after[0]!.dir !== wt.dir || tryGit(git, '-C', wt.dir, 'symbolic-ref', '-q', 'HEAD') !== ref))) return undo(`${base}'s checkouts changed while merging`);
  if (wt) try { git('-C', wt.dir, 'read-tree', '-m', '-u', seen, mergeSha); } catch (e) { return undo(`cannot update ${base}'s files in ${wt.dir} (${firstLine(e)})`); }
  return { merged: true, sha: mergeSha };
}
