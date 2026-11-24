// F project set (docs/plans/local-first.md §2.2 step 4): a project's host, CI provider or base branch. Only a person changes
// them: refused inside an agent session, never offered on the page or over HTTP (no UI route), audited like a rule. A change
// that relaxes what the factory checks (github to git, CI to less) needs a reason, and on a GitHub project a verified login.
import { harnesses } from '../../adapters/harnesses/index.ts';
import { builtin as hosts } from '../../adapters/hosts/index.ts';
import { audit, whoami } from './rules.ts';
import { CI_ORDER, ciOf } from './ci.ts';
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

export const PROJECT_KEYS = ['host', 'ci', 'base'];

const rank = (ci: unknown) => { const i = CI_ORDER.indexOf(String(ci)); return i < 0 ? CI_ORDER.length : i; }; // an unknown stored ci counts as the strictest

/** value null clears the setting (base only): back to what the host says. */
export function setProject(repo: string, key: string, value: string | null, { reason }: { reason?: string } = {}) {
  humanOnly(`changing a project's ${key}`);
  const p = projects()[repo];
  if (!p?.path) throw new Error(`${repo} is not attached; run sync first`);
  if (!PROJECT_KEYS.includes(key)) throw new Error(`project setting must be ${PROJECT_KEYS.join('|')}, got "${key}"`);
  const host = hostOf(repo), from = key === 'host' ? host : key === 'ci' ? ciOf(repo) : p.base ?? null;
  if (value === null && key !== 'base') throw new Error(`only base can be unset; set ${key} to one of its values instead`);
  if (value === null && from === null) throw new Error(`${repo} has no base set`);
  if (value === from) throw new Error(`${repo} already has ${key} ${value}`);
  let next: Project, relaxing = false, note: string | undefined;
  if (value === null) next = { base: undefined }; // the host's own base again (origin/HEAD, main, master)
  else if (key === 'host') {
    // shortcut: github and git only; a host file joins this list once it implements whoami and baseBranch (local-first §1.2)
    if (!Object.hasOwn(hosts, value)) throw new Error(`host must be ${Object.keys(hosts).join('|')}: "${value}" can't host an attached project`);
    const url = originUrl(p.path);
    if (value === 'github') { // gh is asked about the id, so the clone must be that GitHub repo
      if (repo.startsWith('local/')) throw new Error(`${repo} is a local/ id, which is never on GitHub: attach the clone as its GitHub owner/name (F sync <owner/name> <path>)`);
      if (!isGithubRemote(url) || cloneId(url, p.path).toLowerCase() !== repo.toLowerCase()) throw new Error(`host github needs ${repo}'s clone to have the GitHub origin ${repo}`);
      next = { host: 'github', remote: undefined, base: undefined };
    } else {
      relaxing = true; // GitHub's checks (its login, CI, merge) stop applying
      next = { host: 'git', remote: remoteParts(url) ? withoutUserinfo(url) : undefined, ...(p.ci === 'github-actions' && { ci: undefined }) }; // GitHub's checks can't run off GitHub
    }
    const ci = 'ci' in next ? next.ci : p.ci, now = ci ?? (value === 'github' ? 'github-actions' : 'local');
    note = [value === 'github' && p.base && `base ${p.base} cleared: GitHub's base is the repo's default branch`,
      p.ci && !ci && `ci ${p.ci} cleared: it needs a project on GitHub`, `ci is ${now}${ci ? '' : ` (the ${value} default)`}`].filter(Boolean).join('; ');
  } else if (key === 'ci') {
    if (!CI_ORDER.includes(value)) throw new Error(`ci must be ${CI_ORDER.join('|')}`);
    if (value === 'github-actions' && host !== 'github') throw new Error(`ci github-actions needs a project on GitHub, and ${repo} is on ${host}`);
    relaxing = rank(value) < rank(from);
    next = { ci: value };
  } else {
    if (host === 'github') throw new Error(`${repo} is on GitHub: its base is the repo's default branch`);
    let name = ''; // check-ref-format expands @{-1} to a branch name: only a plain name passes
    try { name = git('-C', p.path, 'check-ref-format', '--branch', value).trim(); } catch { /* below */ }
    if (name !== value || value.startsWith('-')) throw new Error(`"${value}" is not a branch name`);
    hostFn(host, 'baseBranch', 'tell the base branch')({ gh, git }, { repo, path: p.path, base: value }); // the clone must have it
    next = { base: value };
  }
  if (relaxing && !reason?.trim()) throw new Error(`${key} ${from} -> ${value} relaxes what the factory checks: say why with --reason "…"`);
  const who = whoami(`changing ${repo}'s ${key}`);
  if (relaxing && host === 'github' && who.via === 'local')
    throw new Error(`${key} ${from} -> ${value} relaxes a GitHub project, which needs a verified login (gh auth login), not a local user; or attach the clone under a local/<name> id`);
  fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { ...p, ...next } }, null, 2)); // undefined drops a key
  const gone = Object.fromEntries((['base', 'ci'] as const).filter((k) => key === 'host' && k in next && p[k]).map((k) => [k, p[k]])); // what a host switch cleared
  audit(repo, value === null ? 'unset' : 'set', { key: `project.${key}`, from, ...(value !== null && { value }), ...(Object.keys(gone).length && { cleared: gone }), ...(reason && { reason }), setBy: who.by, ...(who.via === 'local' && { via: who.via }) });
  return { repo, key, from, to: value, by: who.by, via: who.via, ...(note && { note }) };
}
