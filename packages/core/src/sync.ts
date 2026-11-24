import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboard } from './log.ts';
import { shipTrack } from './ship.ts';
import { read, record, sessionsFile, stateDir } from './log.ts';
import { derive } from './derive.ts';
import { gh, openPRs, relabelMerged } from './github.ts';
import { baseBranch, baseRef, git, hostOf, ls, originUrl, projects, projectsFile } from './workspace.ts';
import { cloneId, hostFor, isGithubRemote, normRemote, remoteParts, withoutUserinfo } from './remote.ts';
import { harnesses } from '../../adapters/harnesses/index.ts';
import type { FactoryEvent, Project, Session } from './types.ts';

/** Agent sessions on one branch, from the harnesses' local logs. */
export interface BranchSessions { agents: string[]; last: string; sessions: (Session & { last: string })[] }

// branch -> { agents, last, sessions } from each harness's local logs (adapter sessions()). Branch names and file times only, never prompt text.
export function sessionsByBranch(repo: string, repoPath: string): Record<string, BranchSessions> {
  const out: Record<string, BranchSessions> = {}, p = projects()[repo];
  const remote = (p?.host ?? 'github') === 'github' ? `https://github.com/${repo}.git` : p?.remote || ''; // a git project: its own origin, or none
  for (const h of harnesses) for (const { branch, id, cwd, last } of h.sessions?.(repoPath, remote) || []) {
    if (!branch || branch === 'HEAD') continue;
    const s = (out[branch] ??= { agents: [], last: '', sessions: [] });
    if (!s.agents.includes(h.id)) s.agents.push(h.id);
    if (last > s.last) s.last = last;
    if (id && !s.sessions.some((x) => x.id === id)) s.sessions.push({ agent: h.id, id, cwd, last });
  }
  return out;
}
export const SKIP_DIRS = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'AppData', 'OneDrive', 'dist', 'build', 'vendor']);
export const DISCOVER_ROOTS = ['Development', 'code', 'Code', 'projects', 'Projects', 'src', 'dev', 'repos', 'workspace', 'git', 'GitHub'];
// Finds local git clones for onboarding: GitHub ones by owner/repo, any other origin by its sanitized path, and a clone with
// no network origin as local/<folder>. Reads .git/config directly (no subprocess per folder);
// skips hidden folders and node_modules.
export function discover(roots?: string[], maxDepth = 5) {
  roots = roots?.length ? roots.map((r) => path.resolve(r)) : DISCOVER_ROOTS.map((d) => path.join(os.homedir(), d)).filter((d) => fs.existsSync(d));
  const clones: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dotGit = entries.find((e) => e.name === '.git');
    if (dotGit?.isDirectory()) clones.push(dir); // keep descending: clones can live inside another repo (a .git *file* is a linked worktree, counted under its clone)
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  const byRepo: Record<string, { repo: string; host: 'github' | 'git'; remote?: string; path: string; lastCommit: string | null; worktrees: number }[]> = {};
  for (const dir of clones) {
    let config: string;
    try { config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'); } catch { continue; }
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] || '';
    const m = isGithubRemote(url); // the same host test hostFor() uses, so discover and attach agree
    const id = cloneId(url, dir), net = normRemote(url);
    let lastCommit = null;
    try { lastCommit = git('-C', dir, 'log', '-1', '--format=%cI').trim() || null; } catch { /* empty repo */ }
    const worktrees = ls(path.join(dir, '.git', 'worktrees')).length;
    // clones of one repo group by its origin (GitHub: by id, as before); a clone with no network origin is its own repo
    const key = m ? `github:${id}` : net ? `net:${net}` : `dir:${dir}`;
    (byRepo[key] ??= []).push({ repo: id, host: m ? 'github' : 'git', ...(!m && net && { remote: withoutUserinfo(url) }), path: dir, lastCommit, worktrees });
  }
  const attached = projects();
  const found = Object.values(byRepo).map((cs) => {
    cs.sort((a, b) => (b.lastCommit || '').localeCompare(a.lastCommit || ''));
    const { host, remote } = cs[0]!;
    // a git clone already attached keeps the id it was attached under, whatever its folder or origin would give now
    const known = host === 'git' ? Object.entries(attached).find(([, p]) => cs.some((c) => c.path === p?.path))?.[0] : undefined;
    const repo = known ?? cs[0]!.repo, a = attached[repo];
    const main = (cs.find((c) => c.path === a?.path) || cs[0]) as (typeof cs)[number]; // prefer the clone already attached, else the freshest (cs is never empty)
    // a git clone is attached only as its own folder (local/app attached from another folder is not this one); a GitHub one when
    // the id's entry is the same GitHub repo, from any of its clones
    const mine = host === 'git' ? known !== undefined : !!a && clash(repo, a, `https://github.com/${repo}`, main.path) === null;
    return { repo, path: main.path, otherClones: cs.filter((c) => c !== main).map((c) => c.path), attached: mine, lastCommit: main.lastCommit, worktrees: main.worktrees, ...(host === 'git' && { host, ...(remote && { remote }) }) };
  });
  // Pickers key rows by id, so ids are unique: two local/app folders, or acme/app on GitHub and on another host. An attached
  // clone keeps its id, and so does a GitHub one (it names the repo for gh); any other gets "-2", "-3", ... until free.
  // shortcut: a GitHub clone whose id an attached git project already holds keeps it (it can't be attached under it anyway).
  const used = new Set<string>(), rank = (e: (typeof found)[number]) => (e.attached ? 0 : !e.host ? 1 : 2);
  for (const e of [...found].sort((a, b) => rank(a) - rank(b))) {
    if (e.host && !e.attached) for (let i = 2, id = e.repo; ; id = `${e.repo}-${i++}`) if (!used.has(id) && !(attached[id] && !e.attached)) { e.repo = id; break; }
    used.add(e.repo);
  }
  return found.sort((a, b) => (b.lastCommit || '').localeCompare(a.lastCommit || ''));
}
// Why attaching repoPath (origin url) as `repo` would clash with its existing entry, or null when it is the same repository:
// ssh, scp and https forms of one origin are equal, a second clone of it is fine. A legacy GitHub entry is github.com/<id>,
// and a clone of it with a local-path origin (a mirror, a test) is not refused. With no network origin on either side, the
// clone folder is the identity (case-folded on Windows).
export function clash(repo: string, prior: Project, url: string, repoPath: string): string | null {
  if (!prior.path) return null; // never attached (an auto-merge or rule set first)
  const real = (p: string) => { let r: string; try { r = fs.realpathSync(p); } catch { r = path.resolve(p); } return process.platform === 'win32' ? r.toLowerCase() : r; };
  if (real(prior.path) === real(repoPath)) return null; // its own folder, even after its origin was added or moved (host and remote stay)
  const moved = !fs.existsSync(path.join(prior.path, '.git')); // the attached folder is gone (moved or deleted): re-point it
  const was = prior.remote ? normRemote(prior.remote) : (prior.host ?? 'github') === 'github' ? `github.com/${repo.toLowerCase()}` : null, now = normRemote(url);
  if (was && now) return was === now ? null : was;
  if (was) return prior.remote && !moved ? was : null;
  return moved ? null : now ? 'a clone with no remote' : 'another folder';
}
// Records repoPath as `repo`'s clone, the one way a path gets into projects.json (sync, and worktree with a path): refuses a
// clash, and decides host and remote on the first attach (a legacy entry, a path and no host, stays GitHub).
export function attach(repo: string, repoPath: string, extra: Project = {}) {
  const prior = projects()[repo], url = originUrl(repoPath);
  const why = prior && clash(repo, prior, url, repoPath);
  // a clone with no network origin keeps a local/ id: owner/name with no origin would be taken for GitHub
  if (why) throw new Error(`${repo} is already attached to ${why}, and ${repoPath} is a different repository: attach it under another id (F sync ${remoteParts(url) ? '<owner/name>' : 'local/<name>'} ${repoPath})`);
  const first = !(prior?.path || prior?.host), fresh: Project = first && hostFor(url, repo) === 'git' ? { host: 'git', ...(remoteParts(url) && { remote: withoutUserinfo(url) }) } : {};
  const onGithub = hostOf(repo, fresh.host ?? prior?.host) === 'github';
  const ref = onGithub ? null : baseRef(repoPath, baseBranch(repo, repoPath, 'git')); // before anything is written: a clone with no base branch is not attached
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...prior, ...fresh, path: repoPath, ...extra } }, null, 2));
  return { onGithub, baseRef: ref };
}
// Registers the repo and imports work already in flight: open PRs, plus recent agent sessions on unmerged branches.
// Imported runs are tracked, never driven: decide() always escalates them.
export function sync(repo: string, repoPath?: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error(`repo must look like owner/repo, got "${repo}"`);
  repoPath = path.resolve(repoPath || projects()[repo]?.path || '.');
  const { onGithub, baseRef } = attach(repo, repoPath, { synced: new Date().toISOString() });
  const runs = Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') || r.id.startsWith(repo + ':'));
  const byPr = new Map(runs.filter((r) => r.pr).map((r) => [r.pr, r]));
  const byBranch = new Map(runs.filter((r) => r.branch).map((r) => [r.branch, r]));
  // a git project: no GitHub calls; nothing is open on a host, and the base comes from the clone (a local ref without a remote)
  const { base, prs, doneBranches } = onGithub ? openPRs(repo) : { base: '', prs: [], doneBranches: [] };
  const sessions = sessionsByBranch(repo, repoPath);
  const ours = (b: string) => b.startsWith('factory/'); // the factory's own branches are never imported
  const added: string[] = [], attached: string[] = [], closed: string[] = [];
  const importRun = (id: string, meta: Partial<FactoryEvent>, summary: string) => {
    record(id, 'intake', 'started', { ...meta, imported: true });
    record(id, 'intake', 'passed', { summary });
  };
  for (const p of prs) {
    if (byPr.has(p.url) || ours(p.headRefName)) continue;
    const prior = byBranch.get(p.headRefName);
    if (prior) { // a session-only run whose branch now has a PR
      if (!prior.pr && prior.outcome === 'in-progress') { record(prior.id, 'build', 'passed', { pr: p.url }); attached.push(prior.id); }
      continue;
    }
    const s = sessions[p.headRefName];
    const source = s ? s.agents.join('+') : 'none';
    const id = `${repo}#${p.number}`; // PRs and issues share GitHub's number space
    importRun(id, { title: p.title, url: p.url, author: p.author?.login, association: p.authorAssociation, source, issues: p.closingIssuesReferences.nodes.map((x) => x.number) },
      `Imported open PR${s ? ` from a ${source} session` : ' (no local session found)'}; not built by the factory.`);
    record(id, 'build', 'started');
    record(id, 'build', 'passed', { pr: p.url, branch: p.headRefName });
    added.push(id);
  }
  // shortcut: only local branches count as session work; a session on a remote-only branch is skipped until it has a PR.
  const unmerged = new Set(git('-C', repoPath, 'branch', '--no-merged', baseRef ?? `origin/${base}`, '--format=%(refname:short)').split('\n').map((b) => b.trim()).filter(Boolean));
  const openHeads = new Set(prs.map((p) => p.headRefName));
  const done = new Set(doneBranches); // squash-merged branches still look unmerged to git
  const recent = new Date(Date.now() - 14 * 864e5).toISOString();
  for (const [branch, s] of Object.entries(sessions)) {
    if (ours(branch) || branch === 'project' || openHeads.has(branch) || done.has(branch) || byBranch.has(branch) || !unmerged.has(branch) || s.last < recent) continue;
    const id = `${repo}:${branch}`;
    importRun(id, { title: branch, source: s.agents.join('+') }, `Imported ${s.agents.join('+')} session on an unmerged branch with no PR yet.`);
    record(id, 'build', 'started', { branch });
    added.push(id);
  }
  // In-progress runs whose work ended outside the factory become "closed": a merge elsewhere is not a factory merge.
  const open = new Set(prs.map((p) => p.url));
  for (const r of runs) {
    if (r.outcome !== 'in-progress' || attached.includes(r.id)) continue;
    let reason: string | undefined;
    if (r.pr && !open.has(r.pr)) {
      if (!onGithub) continue; // a git project's PR (none yet) is never looked up on GitHub
      const { state }: { state: string } = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'state'));
      if (state !== 'OPEN') reason = `PR ${state.toLowerCase()} outside the factory`;
    } else if (!r.pr && r.imported && r.branch && !openHeads.has(r.branch) && (done.has(r.branch) || !unmerged.has(r.branch))) {
      reason = `branch ${r.branch} was merged, closed or deleted`;
    }
    if (reason) { record(r.id, 'approve', 'closed', { reasons: [reason] }); closed.push(r.id); }
  }
  // Escalated runs whose PR a human then merged on GitHub (#21): recorded as merged by a human. Every fact comes from
  // GitHub (state, merge time, merger, merge commit, head branch, fork or not), never from issue, PR or comment text. It
  // never merges or re-runs; it only records, then relabels the issue factory:merged. The merge must follow the latest
  // "decided escalate", or else (a "merge" decision, or none because facts() threw) the "escalated" event: F merge has
  // returned or thrown by then, so a later merge is not its own.
  // A failed lookup skips the run and is reported, never breaks sync. shortcut: archived escalated runs are not checked.
  const humanMerged: string[] = [], humanMergeErrors: { run: string; error: string }[] = [];
  for (const r of runs) {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(r.pr || ''); // r.pr was typed by the orchestrator
    if (!onGithub || r.outcome !== 'escalated' || r.imported || !m || m[1] !== repo || open.has(r.pr as string)) continue; // imported runs: not the factory's work
    const decided = r.events.findLast((e) => e.stage === 'approve' && e.status === 'decided');
    const since = decided?.action === 'escalate' ? decided.ts : r.events.findLast((e) => e.stage === 'approve' && e.status === 'escalated')?.ts;
    let p: { state: string; mergedAt: string; mergedBy?: { login: string } | null; mergeCommit?: { oid: string } | null; headRefName: string; isCrossRepository?: boolean };
    try { p = JSON.parse(gh('pr', 'view', m[2] as string, '-R', repo, '--json', 'state,mergedAt,mergedBy,mergeCommit,headRefName,isCrossRepository')); }
    catch (e: any) { humanMergeErrors.push({ run: r.id, error: String(e?.stderr || e?.message || e).trim().split('\n')[0] as string }); continue; }
    if (p.state !== 'MERGED' || p.isCrossRepository !== false || p.headRefName !== `factory/issue-${r.id.split('#')[1]}` || !(Date.parse(p.mergedAt) > Date.parse(since as string))) continue; // a fork's factory/issue-N branch never counts; no since: NaN, never later, so skipped
    record(r.id, 'approve', 'merged', { by: 'human', mergedBy: p.mergedBy?.login || null, sha: p.mergeCommit?.oid || null });
    relabelMerged(r.id);
    humanMerged.push(r.id);
  }
  const links = sessionsFile();
  const prev: Record<string, Session[]> = fs.existsSync(links) ? JSON.parse(fs.readFileSync(links, 'utf8')) : {};
  for (const r of Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') || r.id.startsWith(repo + ':'))) {
    if (r.branch && sessions[r.branch]) prev[r.id] = (sessions[r.branch] as BranchSessions).sessions.sort((a, b) => b.last.localeCompare(a.last)).slice(0, 5);
  }
  fs.writeFileSync(links, JSON.stringify(prev, null, 2));
  const head = new Map(prs.map((p) => [p.url, p.headRefOid])); // deploy state of each in-progress run's PR head (finished runs aren't polled)
  const ship = shipTrack(Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') && r.outcome === 'in-progress' && head.get(r.pr as string)).map((r) => ({ run: r.id, repo, sha: head.get(r.pr as string), path: repoPath })));
  dashboard.render();
  return { repo, path: repoPath, added, attached, closed, humanMerged, ...(humanMergeErrors.length && { humanMergeErrors }), ...(ship && { ship }) };
}
