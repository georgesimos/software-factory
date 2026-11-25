// A project's CI provider (adapters/ci/, docs/plans/local-first.md §1.4): which one, and what it says, failing closed.
import { STATES, builtin, type CiResult, type Ctx } from '../../adapters/ci/index.ts';
import { gh } from './github.ts';
import { git, hostOf, projects } from './workspace.ts';

/** From most to least checked: moving right to left relaxes (F project set). */
export const CI_ORDER = ['none', 'local', 'github-actions'];
/** projects.json ci, else what the host implies: GitHub's checks on a GitHub project, F's own checks on a git one. */
export const ciOf = (repo: string) => projects()[repo]?.ci ?? (hostOf(repo) === 'github' ? 'github-actions' : 'local');

/** Why repo's CI provider can't answer at all (unknown id, or GitHub's on a project not on GitHub), else null. */
export function ciBroken(repo: string): string | null {
  const id = ciOf(repo);
  if (!Object.hasOwn(builtin, id)) return `unknown CI provider "${id}" in projects.json (${Object.keys(builtin).join('|')})`;
  if (id === 'github-actions' && hostOf(repo) !== 'github') return `CI provider github-actions needs a project on GitHub, and ${repo} is not`;
  return null;
}
/** The provider's answer on sha. Never throws: a broken, throwing or off-contract provider is state unknown with broken set,
 *  which the gate escalates under every ci rule. */
export function ciChecks(repo: string, opts: { path?: string; sha?: string; changeRequest?: string }, local: Ctx['local']): CiResult & { ci: string; broken?: string } {
  const ci = ciOf(repo), bad = ciBroken(repo);
  if (bad) return { ci, state: 'unknown', broken: bad };
  try {
    const r = builtin[ci]!.checks({ gh, git, local }, { repo, ...opts });
    if (!STATES.includes(r?.state)) return { ci, state: 'unknown', broken: `CI provider ${ci} answered state "${r?.state}"` };
    return { ci, ...r };
  } catch (e) {
    const out = String((e as { stderr?: unknown }).stderr || (e as Error).message || e).trim().split('\n')[0];
    return { ci, state: 'unknown', broken: `CI provider ${ci} failed: ${out}` };
  }
}
// The last 80 lines, and at most 16 KB of them: a wide log never floods the session. Cut by bytes, it keeps whole lines.
function tail(s: string) {
  const t = s.trimEnd().split('\n').slice(-80).join('\n'), b = Buffer.from(t);
  return b.length <= 16_384 ? t : b.subarray(-16_384).toString('utf8').replace(/^[^\n]*\n/, '');
}
// The provider's failed-check log on sha, its tail(); '' when it has none or can't read it (the state already says so).
export function ciLog(repo: string, opts: { path?: string; sha: string }, local: Ctx['local']) {
  try { return tail(builtin[ciOf(repo)]?.logTail?.({ gh, git, local }, { repo, ...opts }) ?? ''); } catch { return ''; }
}
