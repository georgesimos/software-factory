// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboard } from './log.ts';
import { shipTrack } from './ship.ts';
import { read, record, sessionsFile, stateDir } from './log.ts';
import { derive } from './derive.ts';
import { gh, openPRs } from './github.ts';
import { git, ls, projects, projectsFile } from './workspace.ts';
import { harnesses } from '../../adapters/harnesses/index.mjs';

// branch -> { agents, last, sessions } from each harness's local logs (adapter sessions()). Branch names and file times only, never prompt text.
export function sessionsByBranch(repo, repoPath) {
  const out = {};
  for (const h of harnesses) for (const { branch, id, cwd, last } of h.sessions?.(repoPath, `https://github.com/${repo}.git`) || []) {
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
// Finds local clones with a GitHub origin, for onboarding. Reads .git/config directly (no subprocess per folder);
// skips hidden folders and node_modules.
export function discover(roots, maxDepth = 5) {
  roots = roots?.length ? roots.map((r) => path.resolve(r)) : DISCOVER_ROOTS.map((d) => path.join(os.homedir(), d)).filter((d) => fs.existsSync(d));
  const clones = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dotGit = entries.find((e) => e.name === '.git');
    if (dotGit?.isDirectory()) clones.push(dir); // keep descending: clones can live inside another repo (a .git *file* is a linked worktree, counted under its clone)
    if (depth >= maxDepth) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  for (const r of roots) walk(r, 0);
  const byRepo = {};
  for (const dir of clones) {
    let config;
    try { config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'); } catch { continue; }
    const url = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] || '';
    const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
    if (!m) continue;
    let lastCommit = null;
    try { lastCommit = git('-C', dir, 'log', '-1', '--format=%cI').trim() || null; } catch { /* empty repo */ }
    const worktrees = ls(path.join(dir, '.git', 'worktrees')).length;
    (byRepo[`${m[1]}/${m[2]}`] ??= []).push({ path: dir, lastCommit, worktrees });
  }
  const attached = projects();
  return Object.entries(byRepo).map(([repo, cs]) => {
    cs.sort((a, b) => (b.lastCommit || '').localeCompare(a.lastCommit || ''));
    const main = cs.find((c) => c.path === attached[repo]?.path) || cs[0]; // prefer the clone already attached, else the freshest
    return { repo, path: main.path, otherClones: cs.filter((c) => c !== main).map((c) => c.path), attached: !!attached[repo], lastCommit: main.lastCommit, worktrees: main.worktrees };
  }).sort((a, b) => (b.lastCommit || '').localeCompare(a.lastCommit || ''));
}
// Registers the repo and imports work already in flight: open PRs, plus recent agent sessions on unmerged branches.
// Imported runs are tracked, never driven: decide() always escalates them.
export function sync(repo, repoPath) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error(`repo must look like owner/repo, got "${repo}"`);
  repoPath = path.resolve(repoPath || projects()[repo]?.path || '.');
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...projects()[repo], path: repoPath, synced: new Date().toISOString() } }, null, 2));
  const runs = Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') || r.id.startsWith(repo + ':'));
  const byPr = new Map(runs.filter((r) => r.pr).map((r) => [r.pr, r]));
  const byBranch = new Map(runs.filter((r) => r.branch).map((r) => [r.branch, r]));
  const { base, prs, doneBranches } = openPRs(repo);
  const sessions = sessionsByBranch(repo, repoPath);
  const ours = (b) => b.startsWith('factory/'); // the factory's own branches are never imported
  const added = [], attached = [], closed = [];
  const importRun = (id, meta, summary) => {
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
  const unmerged = new Set(git('-C', repoPath, 'branch', '--no-merged', `origin/${base}`, '--format=%(refname:short)').split('\n').map((b) => b.trim()).filter(Boolean));
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
    let reason;
    if (r.pr && !open.has(r.pr)) {
      const { state } = JSON.parse(gh('pr', 'view', r.pr, '-R', repo, '--json', 'state'));
      if (state !== 'OPEN') reason = `PR ${state.toLowerCase()} outside the factory`;
    } else if (!r.pr && r.imported && r.branch && !openHeads.has(r.branch) && (done.has(r.branch) || !unmerged.has(r.branch))) {
      reason = `branch ${r.branch} was merged, closed or deleted`;
    }
    if (reason) { record(r.id, 'approve', 'closed', { reasons: [reason] }); closed.push(r.id); }
  }
  // Escalated runs whose PR a human then merged on GitHub (#21): recorded as merged by a human. Every fact comes from
  // GitHub (state, merge time, merger, merge commit, head branch), never from issue, PR or comment text. Record only:
  // nothing here merges, relabels or re-runs. shortcut: archived escalated runs are not checked; they stay escalated.
  const humanMerged = [];
  for (const r of runs) {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(r.pr || ''); // r.pr was typed by the orchestrator
    if (r.outcome !== 'escalated' || r.imported || !m || m[1] !== repo || open.has(r.pr)) continue; // imported runs: not the factory's work
    const p = JSON.parse(gh('pr', 'view', m[2], '-R', repo, '--json', 'state,mergedAt,mergedBy,mergeCommit,headRefName'));
    const escalatedAt = r.events.findLast((e) => e.status === 'escalated')?.ts;
    if (p.state !== 'MERGED' || p.headRefName !== `factory/issue-${r.id.split('#')[1]}` || !(Date.parse(p.mergedAt) > Date.parse(escalatedAt))) continue;
    record(r.id, 'approve', 'merged', { by: 'human', mergedBy: p.mergedBy?.login || null, sha: p.mergeCommit?.oid || null });
    humanMerged.push(r.id);
  }
  const links = sessionsFile();
  const prev = fs.existsSync(links) ? JSON.parse(fs.readFileSync(links, 'utf8')) : {};
  for (const r of Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') || r.id.startsWith(repo + ':'))) {
    if (r.branch && sessions[r.branch]) prev[r.id] = sessions[r.branch].sessions.sort((a, b) => b.last.localeCompare(a.last)).slice(0, 5);
  }
  fs.writeFileSync(links, JSON.stringify(prev, null, 2));
  const head = new Map(prs.map((p) => [p.url, p.headRefOid])); // deploy state of each in-progress run's PR head (finished runs aren't polled)
  const ship = shipTrack(Object.values(derive(read())).filter((r) => r.id.startsWith(repo + '#') && r.outcome === 'in-progress' && head.get(r.pr)).map((r) => ({ run: r.id, repo, sha: head.get(r.pr), path: repoPath })));
  dashboard.render();
  return { repo, path: repoPath, added, attached, closed, humanMerged, ...(ship && { ship }) };
}
