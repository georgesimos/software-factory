// F project set (docs/plans/local-first.md §2.2 step 4): a project's host, CI provider or base branch. Only a person changes
// them: refused inside an agent session, never offered on the page or over HTTP (no UI route), audited like a rule. A change
// that relaxes what the factory checks (github to git, CI to less) needs a reason, and on a GitHub project a verified login.
import { harnesses } from '../../adapters/harnesses/index.ts';
import { builtin as hosts } from '../../adapters/hosts/index.ts';
import { audit, whoami } from './rules.ts';
import { cloneId, isGithubRemote, remoteParts, withoutUserinfo } from './remote.ts';
import { git, hostFn, hostOf, originUrl, projects, projectsFile } from './workspace.ts';
import { gh } from './github.ts';
import fs from 'node:fs';
import type { Project } from './types.ts';

/** Refuses when an agent session is running this: an agent must never change what it is checked against. A speed bump, not a
 *  boundary (an agent can unset these), as §2.2 says. */
export function humanOnly(doing: string) {
  const set = process.env.FACTORY_CLAIM ? 'FACTORY_CLAIM' : process.env.CLAUDECODE ? 'CLAUDECODE'
    : harnesses.find((h) => h.current?.()) ? `a ${harnesses.find((h) => h.current?.())!.id} session` : null;
  if (set) throw new Error(`${doing} must come from you, not from an agent session (${set} is set): run it in your own terminal`);
}

// shortcut: the plan's CI ids, least to most checked, until adapters/ci/ (local-first PR 3) brings a registry and a reader;
// until then ci is recorded and audited, and nothing reads it.
const CI = ['none', 'local', 'github-actions'];
export const PROJECT_KEYS = ['host', 'ci', 'base'];

export function setProject(repo: string, key: string, value: string, { reason }: { reason?: string } = {}) {
  humanOnly(`changing a project's ${key}`);
  const p = projects()[repo];
  if (!p?.path) throw new Error(`${repo} is not attached; run sync first`);
  if (!PROJECT_KEYS.includes(key)) throw new Error(`project setting must be ${PROJECT_KEYS.join('|')}, got "${key}"`);
  const host = hostOf(repo), from = key === 'host' ? host : key === 'ci' ? p.ci ?? (host === 'github' ? 'github-actions' : 'none') : p.base ?? null;
  if (value === from) throw new Error(`${repo} already has ${key} ${value}`);
  let next: Project, relaxing = false;
  if (key === 'host') {
    if (!Object.hasOwn(hosts, value)) throw new Error(`unknown host "${value}" (${Object.keys(hosts).join('|')})`);
    const url = originUrl(p.path);
    if (value === 'github') { // gh is asked about the id, so the clone must be that GitHub repo
      if (repo.startsWith('local/')) throw new Error(`${repo} is a local/ id, which is never on GitHub: attach the clone as its GitHub owner/name (F sync <owner/name> <path>)`);
      if (!isGithubRemote(url) || cloneId(url, p.path).toLowerCase() !== repo.toLowerCase()) throw new Error(`host github needs ${repo}'s clone to have the GitHub origin ${repo}`);
      next = { host: 'github', remote: undefined };
    } else {
      relaxing = true; // GitHub's checks (its login, CI, merge) stop applying
      next = { host: 'git', remote: remoteParts(url) ? withoutUserinfo(url) : undefined };
    }
  } else if (key === 'ci') {
    if (!CI.includes(value)) throw new Error(`ci must be ${CI.join('|')}`);
    relaxing = CI.indexOf(value) < CI.indexOf(String(from));
    next = { ci: value };
  } else {
    if (host === 'github') throw new Error(`${repo} is on GitHub: its base is the repo's default branch`);
    try { git('check-ref-format', '--branch', value); } catch { throw new Error(`"${value}" is not a branch name`); }
    hostFn(host, 'baseBranch', 'tell the base branch')({ gh, git }, { repo, path: p.path, base: value }); // the clone must have it
    next = { base: value };
  }
  if (relaxing && !reason?.trim()) throw new Error(`${key} ${from} -> ${value} relaxes what the factory checks: say why with --reason "…"`);
  const who = whoami(`changing ${repo}'s ${key}`, undefined, repo);
  if (relaxing && host === 'github' && who.via === 'local')
    throw new Error(`${key} ${from} -> ${value} relaxes a GitHub project, which needs a verified login (gh auth login), not a local user; or attach the clone under a local/<name> id`);
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...p, ...next } }, null, 2)); // undefined drops a key
  audit(repo, 'set', { key: `project.${key}`, from, value, ...(reason && { reason }), setBy: who.by, ...(who.via === 'local' && { via: who.via }) });
  return { repo, key, from, to: value, by: who.by, via: who.via, ...(key === 'ci' && { note: 'recorded: F reads the CI provider once CI providers exist' }) };
}
