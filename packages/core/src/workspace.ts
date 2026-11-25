import fs from 'node:fs';
import path from 'node:path';
import { derive } from './derive.ts';
import { execFileSync } from 'node:child_process';
import { exec, posixShell } from './platform.ts';
import { gh, parseRun } from './github.ts';
import { attach } from './sync.ts';
import { io, read, record, runDir, stateDir } from './log.ts';
import { rules } from './rules.ts';
import { withClaim } from './claim.ts';
import { specCleared } from './approve.ts';
import { builtin as builtinHosts, type Host } from '../../adapters/hosts/index.ts';
import { builtin as builtinTrackers, type Tracker } from '../../adapters/trackers/index.ts';
import type { Project, WorktreeInfo } from './types.ts';

/** What execFileSync throws: Node types it as a plain Error. */
type ExecError = Error & { code?: string; status?: number | null; signal?: NodeJS.Signals | null; stdout?: string | Buffer; stderr?: string | Buffer };

export const git = (...args: string[]): string => exec(io.git, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const ls = (d: string): string[] => { try { return fs.readdirSync(d); } catch { return []; } };
export const projectsFile = () => path.join(stateDir(), 'projects.json');
export const projects = (): Record<string, Project> => { try { return JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); } catch { return {}; } };
export const saveProject = (repo: string, p: string) => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], path: p, synced: projects()[repo]?.synced } }, null, 2)); };
/** The project's host: set at attach (sync), never read from the id's shape, except that a local/ id is never GitHub. A legacy
 *  entry, or none, is GitHub. stored: the host to use instead of projects.json's (attach, before it writes). */
export const hostOf = (repo: string, stored = projects()[repo]?.host) => repo.startsWith('local/') ? 'git' : stored ?? 'github';
/** Refuses a GitHub call for a git-hosted project, before anything runs, with what was being done. */
export function requireGithub(repo: string, doing: string) {
  if (hostOf(repo) !== 'github') throw new Error(`${repo} is a git project, not on GitHub: ${doing} works only for GitHub projects for now`);
}
/** A clone's origin URL, or '' when it has none (or the folder is not a clone). */
export const originUrl = (repoPath: string) => { try { return git('-C', repoPath, 'remote', 'get-url', 'origin').trim(); } catch { return ''; } };
/** The project's host adapter function, or a refusal naming the host and what it can't do. Never another host's. */
export function hostFn<K extends 'whoami' | 'baseBranch' | 'listChangeRequests' | 'changeRequest' | 'merge' | 'openChangeRequest' | 'escalate'>(id: string, fn: K, verb: string): NonNullable<Host[K]> {
  const f = Object.hasOwn(builtinHosts, id) ? (builtinHosts as Record<string, Host>)[id]![fn] : undefined;
  if (!f) throw new Error(`host "${id}" cannot ${verb}`);
  return f as NonNullable<Host[K]>;
}
/** projects.json tracker, else github-issues on a GitHub project and local (its own files, docs/plans/local-first.md 5b) on a git one.
 *  GitHub Issues only on a GitHub project: elsewhere the repo name it would ask about isn't this project, so it can't say who wrote an item. */
export const trackerOf = (repo: string) => {
  const host = hostOf(repo), t = projects()[repo]?.tracker ?? (host === 'github' ? 'github-issues' : 'local');
  if (t === 'github-issues' && host !== 'github') throw new Error(`tracker github-issues reads GitHub, and ${repo} is on ${host}`);
  return t;
};
/** The tracker's function, or a refusal naming the tracker and what it can't do. */
export function trackerFn<K extends 'getItem' | 'comments' | 'trust' | 'createIssues' | 'listOpen' | 'ensureLabels' | 'label' | 'comment'>(id: string, fn: K, verb: string): NonNullable<Tracker[K]> {
  const f = Object.hasOwn(builtinTrackers, id) ? (builtinTrackers as Record<string, Tracker>)[id]![fn] : undefined;
  if (!f) throw new Error(`tracker "${id}" cannot ${verb}`);
  return f as NonNullable<Tracker[K]>;
}
/** The branch `repo`'s runs start from, from its host (host: before projects.json has it, at attach). */
export const baseBranch = (repo: string, repoPath: string, host = hostOf(repo)) =>
  hostFn(host, 'baseBranch', 'tell the base branch')({ gh, git }, { repo, path: repoPath, ...(projects()[repo]?.base && { base: projects()[repo]!.base }) });
/** The ref for a base branch in a clone: origin's copy when the clone has one, else the local branch (no remote). */
// The base as a full ref, never a short name: a tag main or a branch origin/main, which anyone with the clone (a build agent in its
// worktree too) can create, would otherwise stand in for it and hide the run's diff.
export const baseRef = (repoPath: string, base: string) => { const r = `refs/remotes/origin/${base}`; try { git('-C', repoPath, 'rev-parse', '--verify', '-q', `${r}^{commit}`); return r; } catch { return `refs/heads/${base}`; } };
export const wtFile = (run: string) => path.join(runDir(run), 'worktree.json');
export const wtInfo = (run: string): WorktreeInfo | null => { try { return JSON.parse(fs.readFileSync(wtFile(run), 'utf8')); } catch { return null; } };
// One git worktree per run, sharing the clone's object store (not a second clone). A resume recreates it from the pushed branch.
export function worktree(run: string, repoPath?: string): WorktreeInfo {
  specCleared(run, 'get a worktree'); // a local item builds only after its spec passed (approve.ts)
  const have = wtInfo(run);
  if (have && fs.existsSync(have.path)) return have;
  const { repo, n } = parseRun(run);
  repoPath = repoPath ? path.resolve(repoPath) : projects()[repo]?.path;
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) throw new Error(`no local clone for ${repo}; pass its path: worktree ${run} <path>`);
  if (projects()[repo]?.path !== repoPath) attach(repo, repoPath); // a new or changed clone: the clash check and host decision sync makes
  // GitHub says what the base is; a git project's clone does (local refs when it has no remote)
  const local = hostOf(repo) !== 'github', remote = !local || !!originUrl(repoPath);
  const base = baseBranch(repo, repoPath);
  const branch = `factory/issue-${n}`;
  const wt = path.join(runDir(run), 'wt');
  fs.mkdirSync(runDir(run), { recursive: true });
  git('-C', repoPath, 'worktree', 'prune');
  if (remote) git('-C', repoPath, 'fetch', '-q', 'origin', base);
  let from = remote ? `refs/remotes/origin/${base}` : `refs/heads/${base}`; // full refs: see baseRef
  let fetched = false;
  if (remote) try { git('-C', repoPath, 'fetch', '-q', 'origin', `${branch}:refs/remotes/origin/${branch}`); from = `refs/remotes/origin/${branch}`; fetched = true; } catch { /* first run: nothing pushed yet */ }
  // a git project pushes nothing yet: a resume starts from its local branch, never resets it to the base
  if (local && !fetched) try { git('-C', repoPath, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`); from = `refs/heads/${branch}`; } catch { /* first run */ }
  git('-C', repoPath, 'worktree', 'add', '-q', '-B', branch, wt, from);
  const info: WorktreeInfo = { repoPath, path: wt, branch, base };
  fs.writeFileSync(wtFile(run), JSON.stringify(info, null, 2));
  return info;
}
// Removes a run's worktree and local branch, unless that would lose uncommitted or unpushed work.
export function cleanup(run: string): string {
  const w = wtInfo(run);
  if (!w) return 'none';
  if (fs.existsSync(w.path)) {
    const dirty = git('-C', w.path, 'status', '--porcelain').trim();
    const unpushed = git('-C', w.path, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin').trim();
    if (dirty || unpushed !== '0') return `kept ${w.path}: ${dirty ? 'uncommitted changes' : `${unpushed} unpushed commit(s)`}`;
    git('-C', w.repoPath, 'worktree', 'remove', '--force', w.path);
  }
  git('-C', w.repoPath, 'worktree', 'prune');
  try { git('-C', w.repoPath, 'branch', '-D', w.branch); } catch { /* already gone */ }
  fs.rmSync(wtFile(run));
  return 'removed';
}
// Sweeps worktrees of finished runs (e.g. a session that ended before cleanup ran).
export function gc(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of Object.values(derive(read()))) if (r.outcome !== 'in-progress' && wtInfo(r.id)) out[r.id] = cleanup(r.id);
  for (const { path: p } of Object.values(projects())) if (p && fs.existsSync(p)) git('-C', p, 'worktree', 'prune');
  return out;
}
// Cheapest node_modules for a run's worktree. Prints one line; install logs only on failure, to keep them out of the context.
export function deps(run: string): string {
  const w = wtInfo(run);
  if (!w) throw new Error(`no worktree for ${run}; run "worktree" first`);
  const has = (dir: string, f: string) => fs.existsSync(path.join(dir, f));
  const sh = (cmd: string, args: string[]) => {
    try { exec(cmd, args, { cwd: w.path, env: withClaim(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { // the repo's install scripts never get the run's claim token
      const tail = (x: unknown) => String(x || '').trim().split('\n').slice(-15).join('\n');
      const { stdout, stderr } = e as ExecError;
      throw new Error(`${cmd} ${args.join(' ')} failed:\n${tail(stdout)}\n${tail(stderr)}`);
    }
  };
  if (!has(w.path, 'package.json')) return 'no package.json: nothing to install';
  if (has(w.path, 'node_modules')) return 'node_modules already present';
  if (has(w.path, 'pnpm-lock.yaml')) { sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline']); return 'pnpm install: packages hard-linked from the shared store'; }
  const lock = ['package-lock.json', 'yarn.lock'].find((f) => has(w.path, f));
  const workspaces = !!JSON.parse(fs.readFileSync(path.join(w.path, 'package.json'), 'utf8')).workspaces; // nested node_modules: install instead
  const same = lock && !workspaces && has(w.repoPath, 'node_modules') && has(w.repoPath, lock) &&
    fs.readFileSync(path.join(w.path, lock)).equals(fs.readFileSync(path.join(w.repoPath, lock)));
  if (same) {
    try { // copy-on-write clone: near-instant, no extra disk until a file changes. Never a symlink into the main checkout.
      if (process.platform === 'win32') throw new Error('no reflink on NTFS: a full copy is slower than an install'); // shortcut: ReFS Dev Drives can clone; add them if Windows runs get slow
      fs.cpSync(path.join(w.repoPath, 'node_modules'), path.join(w.path, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE_FORCE }); // APFS, btrfs, XFS; fails where it can't clone
      return 'node_modules cloned copy-on-write from the main checkout (same lockfile)';
    } catch { fs.rmSync(path.join(w.path, 'node_modules'), { recursive: true, force: true }); /* no CoW here: install below */ }
  }
  if (lock === 'yarn.lock') sh('yarn', ['install', '--frozen-lockfile', '--prefer-offline']);
  else sh('npm', [lock ? 'ci' : 'install', '--prefer-offline', '--no-audit', '--no-fund']);
  return `${lock === 'yarn.lock' ? 'yarn' : 'npm'} install (offline cache first)`;
}
// Stand-in for CI that F runs itself: the checks.commands rule (never repo or model text) in the run's worktree, on a clean commit.
// Records an owned build event with exit codes only; output goes to a file and its tail is printed.
// shortcut: weaker than CI. It runs in the worktree the builder prepared, with the user's environment, and the clean-tree
// check can't see ignored files (node_modules, .git/info/exclude), so a tampered node_modules/.bin would pass. Upgrade
// to a fresh clone of the reviewed sha plus a clean install if rules ever stand in for CI on untrusted code.
export function localChecks(run: string) {
  const { repo } = parseRun(run), w = wtInfo(run);
  if (!w || !fs.existsSync(w.path)) throw new Error(`no worktree for ${run}; run "worktree" first`);
  const cmds = rules(repo).policy['checks.commands']?.value as string[] | undefined; // skills.json boundary: readSkills() (checkSkills, checkRules) admits only 1-10 strings here
  if (!cmds) throw new Error(`no checks.commands rule for ${repo}; the user can set one: rules set ${repo} checks.commands '["pnpm test"]' --reason "…"`);
  if (git('-C', w.path, 'status', '--porcelain').trim()) throw new Error('the worktree has uncommitted changes; commit first, so the checks cover the commit that gets reviewed');
  const sha = git('-C', w.path, 'rev-parse', 'HEAD').trim();
  const shell = posixShell(); // before the log opens: no shell, no run
  const file = path.join(runDir(run), 'local-checks.log'), fd = fs.openSync(file, 'w'), commands: { cmd: string; exit: number | string; ms: number }[] = [], LIMIT = 30 * 60e3;
  try {
    for (const cmd of cmds) {
      fs.writeSync(fd, `$ ${cmd}\n`);
      const t = Date.now();
      let exit: number | string = 0; // a code, 'timeout', or the signal that killed it
      try { execFileSync(shell, ['-c', cmd], { cwd: w.path, env: { ...withClaim(process.env), CI: '1' }, stdio: ['ignore', fd, fd], timeout: LIMIT }); } // to a file: no maxBuffer limit
      catch (e) { const x = e as ExecError; exit = x.status ?? (x.code === 'ETIMEDOUT' || Date.now() - t >= LIMIT ? 'timeout' : x.signal ?? 1); }
      commands.push({ cmd, exit, ms: Date.now() - t });
    }
  } finally { fs.closeSync(fd); }
  const state = commands.every((c) => c.exit === 0) ? 'pass' : 'fail';
  record(run, 'build', state === 'pass' ? 'passed' : 'failed', { localChecks: { state, sha, commands } });
  const tail = state === 'fail' ? fs.readFileSync(file, 'utf8').split('\n').slice(-60).join('\n') : undefined;
  return { state, sha, commands, log: file, ...(tail && { tail }) };
}
