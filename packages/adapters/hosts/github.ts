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
