// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { derive } from './derive.ts';
import { execFileSync } from 'node:child_process';
import { exec, posixShell } from './platform.ts';
import { gh, parseRun } from './github.ts';
import { io, read, record, runDir, stateDir } from './log.ts';
import { rules } from './rules.ts';
import { withClaim } from './claim.ts';
import type { Project, WorktreeInfo } from './types.ts';

export const git = (...args: string[]): string => exec(io.git, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const ls = (d: string): string[] => { try { return fs.readdirSync(d); } catch { return []; } };
export const projectsFile = () => path.join(stateDir(), 'projects.json');
export const projects = (): Record<string, Project> => { try { return JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); } catch { return {}; } };
export const saveProject = (repo, p) => { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], path: p, synced: projects()[repo]?.synced } }, null, 2)); };
export const wtFile = (run) => path.join(runDir(run), 'worktree.json');
export const wtInfo = (run: string): WorktreeInfo | null => { try { return JSON.parse(fs.readFileSync(wtFile(run), 'utf8')); } catch { return null; } };
// One git worktree per run, sharing the clone's object store (not a second clone). A resume recreates it from the pushed branch.
export function worktree(run, repoPath) {
  const have = wtInfo(run);
  if (have && fs.existsSync(have.path)) return have;
  const { repo, n } = parseRun(run);
  repoPath = repoPath ? path.resolve(repoPath) : projects()[repo]?.path;
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) throw new Error(`no local clone for ${repo}; pass its path: worktree ${run} <path>`);
  const base = gh('repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name').trim();
  const branch = `factory/issue-${n}`;
  const wt = path.join(runDir(run), 'wt');
  fs.mkdirSync(runDir(run), { recursive: true });
  git('-C', repoPath, 'worktree', 'prune');
  git('-C', repoPath, 'fetch', '-q', 'origin', base);
  let from = `origin/${base}`;
  try { git('-C', repoPath, 'fetch', '-q', 'origin', `${branch}:refs/remotes/origin/${branch}`); from = `origin/${branch}`; } catch { /* first run: nothing pushed yet */ }
  git('-C', repoPath, 'worktree', 'add', '-q', '-B', branch, wt, from);
  const info = { repoPath, path: wt, branch, base };
  fs.writeFileSync(wtFile(run), JSON.stringify(info, null, 2));
  if (projects()[repo]?.path !== repoPath) saveProject(repo, repoPath);
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
export function gc() {
  const out = {};
  for (const r of Object.values(derive(read()))) if (r.outcome !== 'in-progress' && wtInfo(r.id)) out[r.id] = cleanup(r.id);
  for (const { path: p } of Object.values(projects())) if (p && fs.existsSync(p)) git('-C', p, 'worktree', 'prune');
  return out;
}
// Cheapest node_modules for a run's worktree. Prints one line; install logs only on failure, to keep them out of the context.
export function deps(run) {
  const w = wtInfo(run);
  if (!w) throw new Error(`no worktree for ${run}; run "worktree" first`);
  const has = (dir, f) => fs.existsSync(path.join(dir, f));
  const sh = (cmd, args) => {
    try { exec(cmd, args, { cwd: w.path, env: withClaim(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { // the repo's install scripts never get the run's claim token
      const tail = (x) => String(x || '').trim().split('\n').slice(-15).join('\n');
      throw new Error(`${cmd} ${args.join(' ')} failed:\n${tail(e.stdout)}\n${tail(e.stderr)}`);
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
export function localChecks(run) {
  const { repo } = parseRun(run), w = wtInfo(run);
  if (!w || !fs.existsSync(w.path)) throw new Error(`no worktree for ${run}; run "worktree" first`);
  const cmds = rules(repo).policy['checks.commands']?.value;
  if (!cmds) throw new Error(`no checks.commands rule for ${repo}; the user can set one: rules set ${repo} checks.commands '["pnpm test"]' --reason "…"`);
  if (git('-C', w.path, 'status', '--porcelain').trim()) throw new Error('the worktree has uncommitted changes; commit first, so the checks cover the commit that gets reviewed');
  const sha = git('-C', w.path, 'rev-parse', 'HEAD').trim();
  const shell = posixShell(); // before the log opens: no shell, no run
  const file = path.join(runDir(run), 'local-checks.log'), fd = fs.openSync(file, 'w'), commands = [];
  try {
    for (const cmd of cmds) {
      fs.writeSync(fd, `$ ${cmd}\n`);
      const t = Date.now();
      let exit = 0;
      try { execFileSync(shell, ['-c', cmd], { cwd: w.path, env: { ...withClaim(process.env), CI: '1' }, stdio: ['ignore', fd, fd], timeout: 30 * 60e3 }); } // to a file: no maxBuffer limit
      catch (e) { exit = e.status ?? (e.signal ? 'timeout' : 1); }
      commands.push({ cmd, exit, ms: Date.now() - t });
    }
  } finally { fs.closeSync(fd); }
  const state = commands.every((c) => c.exit === 0) ? 'pass' : 'fail';
  record(run, 'build', state === 'pass' ? 'passed' : 'failed', { localChecks: { state, sha, commands } });
  const tail = state === 'fail' ? fs.readFileSync(file, 'utf8').split('\n').slice(-60).join('\n') : undefined;
  return { state, sha, commands, log: file, ...(tail && { tail }) };
}
