// GitHub repo host, through the logged-in `gh`. ctx.gh / ctx.git run the CLIs without a shell (the self-test passes stubs).
export const id = 'github';

export function authStatus({ gh }) {
  try { gh('auth', 'status'); } catch (e) { return { ok: false, detail: String(e.stderr || e.message).trim().split('\n').slice(0, 3).join(' ') }; }
  return { ok: true, login: gh('api', 'user', '--jq', '.login').trim() };
}

const urlOf = (gh, repo) => { try { return gh('repo', 'view', repo, '--json', 'url', '--jq', '.url').trim(); } catch { return null; } };

// Never touches a repo that already exists: it reports created:false and the caller decides.
export function createRepo({ gh }, { repo, visibility, description }) {
  const have = urlOf(gh, repo);
  if (have) return { created: false, url: have };
  if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be private|public');
  gh('repo', 'create', repo, `--${visibility}`, '--description', String(description || '').slice(0, 300));
  return { created: true, url: urlOf(gh, repo) || `https://github.com/${repo}` };
}

// Adds origin and pushes the scaffold commit to main. A plain push: it fails rather than overwrite anything.
// shortcut: an https remote needs gh's git credential helper (`gh auth setup-git`); read gh's git_protocol if ssh users hit this.
export function pushInitial({ gh, git }, { repo, path, branch = 'main' }) {
  const url = urlOf(gh, repo);
  if (!url) throw new Error(`${repo} does not exist`);
  const remote = url.endsWith('.git') ? url : url + '.git';
  if (!git('-C', path, 'remote').split('\n').includes('origin')) git('-C', path, 'remote', 'add', 'origin', remote);
  git('-C', path, 'push', '-q', '-u', 'origin', `HEAD:${branch}`);
  return { pushed: true, remote, branch };
}
