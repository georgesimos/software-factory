// A run's change request through the host and CI adapters (local-first PR 6), so SKILL.md names no host tool:
// F pr opens it, F ci reads its CI, F escalate hands it to a human. The target is always the run's own (its branch, base,
// recorded change request and issue) and the text is F's (intake's title, DIR/spec.md, the decision), never typed.
import fs from 'node:fs';
import path from 'node:path';
import { blocking } from './constants.ts';
import { ciChecks, ciLog } from './ci.ts';
import { getRun } from './derive.ts';
import { localResult } from './gate.ts';
import { adapterCtx, parseRun, postmerge } from './github.ts';
import { record, runDir } from './log.ts';
import { rules } from './rules.ts';
import { scrubText } from './scrub.ts';
import { baseBranch, git, hostFn, hostOf, projects, trackerOf, wtInfo } from './workspace.ts';
import type { AxisReview, Run } from './types.ts';

const BODY_MAX = 60_000; // GitHub refuses a body over 65,536 characters
const driven = (run: string) => {
  const r = getRun(run);
  if (r.imported) throw new Error(`${run} is imported: the factory doesn't drive it`);
  return r;
};

/** Opens the run's change request once, as a draft from its factory branch; later calls return the recorded one. */
export function openPr(run: string) {
  const r = driven(run), { repo, n } = parseRun(run);
  if (r.pr) return { pr: r.pr, branch: r.branch, existing: true };
  const w = wtInfo(run);
  if (!w) throw new Error(`${run} has no worktree: run F worktree ${run} first`);
  let spec = '';
  try { spec = fs.readFileSync(path.join(runDir(run), 'spec.md'), 'utf8'); } catch { /* refused below */ }
  if (!spec.trim()) throw new Error(`${run} has no spec: write DIR/spec.md (F dir ${run}) first`);
  let body = `${trackerOf(repo) === 'github-issues' ? `Closes #${n}` : `Factory item #${n}`}\n\n${spec}`;
  if (body.length > BODY_MAX) body = `${body.slice(0, BODY_MAX)}\n\n… (cut here: the whole spec is the run's DIR/spec.md)`;
  const c = hostFn(hostOf(repo), 'openChangeRequest', 'open a change request')(adapterCtx(), { repo, path: w.repoPath, branch: w.branch, base: w.base ? String(w.base) : baseBranch(repo, w.repoPath), title: String(r.title || `#${n}`), body, draft: true });
  record(run, 'build', 'opened', { pr: c.id, branch: w.branch });
  return { pr: c.id, branch: w.branch, ...(c.url && { url: c.url }) };
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The project's CI on the run's worktree head (and its change request). watch: polls while pending, up to max, never longer. */
export function ciStatus(run: string, { watch = false, every = 30_000, max = 20 * 60_000 } = {}) {
  const r = driven(run), { repo } = parseRun(run), w = wtInfo(run), at = projects()[repo]?.path;
  const sha = w ? git('-C', w.path, 'rev-parse', 'HEAD').trim() : undefined;
  const cmds = rules(repo).policy['checks.commands']?.value, local = (s?: string) => localResult(getRun(run).localChecks, cmds, s);
  const ask = () => ciChecks(repo, { path: at, sha, changeRequest: r.pr }, local);
  let c = ask();
  for (const end = Date.now() + max; watch && c.state === 'pending' && Date.now() + every <= end;) { sleep(every); c = ask(); }
  const log = c.state === 'fail' && sha ? ciLog(repo, { path: at, sha }, local) : '';
  return { state: c.state, ci: c.ci, ...(c.url && { url: c.url }), ...(c.failed?.length && { failed: c.failed }), ...(c.detail && { detail: c.detail }), ...(c.broken && { broken: c.broken }), ...(log && { log }) };
}

/** Why the run needs a human: its decision's reasons (after a merge, why its base can't be watched) and its open blocking findings. */
function why(run: string, r: Run) {
  const reasons = r.outcome === 'merged' ? [postmerge(run).reason ?? 'CI on the base branch after the merge could not be read'] : r.decision?.reasons ?? [];
  if (!reasons.length) throw new Error(`${run} has no decision to escalate: run F merge ${run} first`);
  const open = Object.entries(r.reviews[r.iteration] ?? {}).filter(([, v]) => v.verdict !== 'passed')
    .flatMap(([axis, v]) => (v as AxisReview).findings.filter(blocking).map((f) => `- ${axis}, ${f.severity} ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.issue ?? ''}`.trimEnd()));
  return scrubText(['The software factory needs a human here.', '', 'Why:', ...reasons.map((x) => `- ${x}`), ...(open.length ? ['', 'Open findings:', ...open] : [])].join('\n'));
}
/** Marks the change request (or the issue, with none) for a human, with one comment. Cosmetic: the escalation itself is F event … approve escalated. */
export function escalate(run: string) {
  const r = driven(run), { repo, n } = parseRun(run), body = why(run, r), at = projects()[repo]?.path;
  const out = hostFn(hostOf(repo), 'escalate', 'escalate')(adapterCtx(), { repo, ...(at && { path: at }), ...(r.pr && { id: r.pr }), issue: n, body });
  if (out.detail && out.posted) console.error(`factory: ${out.detail}`);
  return { on: r.pr ? 'pr' : 'issue', ...out };
}
