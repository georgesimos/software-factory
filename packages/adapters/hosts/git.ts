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
