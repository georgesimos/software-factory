import path from 'node:path';
import { CAP, DOCS, MAX_DIFF, SEO, SOURCE, TEST, TRUSTED, UI, blocking, byText, isLocal, sensitive } from './constants.ts';
import { budget, budgetWhy } from './derive.ts';
import { AXIS_WHEN, BUILTIN_AXES } from './skills.ts';
import type { AxisReview, Deploy, LocalChecks, Metrics, Rule, Run } from './types.ts';

/** An extra review axis from skills.json: added when a changed file matches one of its globs. */
export interface ExtraAxis { axis: string; when: string[] }
/** What facts() reads from GitHub (github.ts), or {} for an imported run. */
export interface Facts {
  association?: string; autoMerge?: boolean; checks?: string; additions?: number; deletions?: number; files?: string[];
  rules?: Record<string, Rule>; deploys?: Deploy[];
  /** The CI provider that gave checks (absent: github-actions, as before providers); ciDetail: its one-line why; ciBroken: it
   *  couldn't answer (unknown, wrong host, threw), which escalates under every ci rule; host: the project's (absent: github). */
  ci?: string; ciDetail?: string; ciBroken?: string; host?: string; trustBroken?: string;
  /** trustBroken only because the item's tracker has no verifiable author (a git project's local tracker): approvable (D4). */
  unverifiable?: boolean;
  /** F merge's look at the change request: not open, not the run's own branch, or its head isn't the reviewed commit. */
  headBroken?: string;
}

/** F's own checks (F checks) on sha against the checks.commands rule: pass only on that commit, with that command list, every
 *  exit 0. decide() and the local CI provider both judge them here. */
export function localResult(lc: LocalChecks | undefined, cmds: unknown, sha: string | undefined): { state: 'pass' | 'fail' | 'none'; text: string } {
  const short = (s: string | undefined) => String(s || 'none').slice(0, 7);
  const failing = (lc?.commands || []).filter((c) => c.exit !== 0).map((c) => c.cmd);
  return !Array.isArray(cmds) || !cmds.length ? { state: 'none', text: 'no checks.commands rule, so nothing was checked' }
    : !lc ? { state: 'none', text: 'Local checks: not run ("F checks")' }
    : !sha || lc.sha !== sha ? { state: 'none', text: `Local checks: ran on ${short(lc.sha)}, not the reviewed commit ${short(sha)}` }
    : JSON.stringify((lc.commands || []).map((c) => c.cmd)) !== JSON.stringify(cmds) ? { state: 'none', text: 'Local checks: ran a different command list than the checks.commands rule now has' }
    : lc.state !== 'pass' || failing.length ? { state: 'fail', text: `Local checks: fail (${failing.join(', ') || 'unknown'})` }
    : { state: 'pass', text: `Local checks: pass (${cmds.join(', ')})` };
}

export function axesFor(files: string[], extra: ExtraAxis[] = []) {
  const on = { ui: UI, seo: SEO, docs: DOCS };
  const axes: string[] = BUILTIN_AXES.filter((a) => AXIS_WHEN[a] === 'always' || files.some((f) => on[AXIS_WHEN[a] as keyof typeof on].test(f))); // skills.ts's table, which the Pipelines page shows
  for (const x of extra) if (files.some((f) => x.when.some((g) => path.matchesGlob(f, g)))) axes.push(x.axis); // user axes only add, never replace. shortcut: path.matchesGlob needs Node >= 22.5 (experimental before 24); swap in a small glob regex if older Node matters
  return axes;
}
// Loop-backs re-review only what the new commits touch, plus every axis that failed last time.
export function reviewAxes(r: Run, files: string[], extra: ExtraAxis[] = []) {
  const prev = Math.max(-1, ...Object.keys(r.axes || {}).map(Number).filter((i) => i < r.iteration));
  // prev is one of r.axes' keys
  const failed = prev < 0 ? [] : ((r.axes as Record<number, string[]>)[prev] as string[]).filter((a) => r.reviews[prev]?.[a]?.verdict !== 'passed');
  return [...new Set([...axesFor(files, extra), ...failed])];
}
export function gate(r: Run) {
  const expected = r.axes?.[r.iteration];
  if (!expected) throw new Error(`no review axes recorded for iteration ${r.iteration}; run "axes" first`);
  const rev = r.reviews[r.iteration] || {};
  const missing = expected.filter((a) => !rev[a]);
  if (missing.length) throw new Error(`missing review verdicts: ${missing.join(', ')}`);
  const failed = expected.filter((a) => (rev[a] as AxisReview).verdict !== 'passed'); // none missing: checked above
  if (!failed.length) return { status: 'passed', next: 'approve', reasons: [`all axes passed: ${expected.join(', ')}`] };
  const findings = failed.flatMap((a) => (rev[a] as AxisReview).findings.filter(blocking));
  const route = findings.some((f) => f.route === 'spec') ? 'spec' : 'build';
  const reasons = failed.map((a) => `${a}: ${(rev[a] as AxisReview).findings.filter(blocking).length} blocking finding(s)`);
  if (r.iteration >= CAP) return { status: 'failed', next: 'approve', reasons: [...reasons, `loop cap ${CAP} reached`] };
  const b = budget(r);
  if (b.over) return { status: 'failed', next: 'approve', reasons: [...reasons, `budget reached ${budgetWhy(b)}`] };
  return { status: 'failed', next: route, reasons };
}
// Default is escalate: merge only when every condition holds. await-approval (local-first §0 D4), on the git host only: every reason
// left is one that F approve RUN --merge may clear, auto-merge off or an author nobody can verify; it merges only with that approval
// of exactly the reviewed commit. On GitHub every reason escalates, auto-merge off (D1) included: the human merges in GitHub.
export function decide(r: Run, f: Facts) {
  if (r.imported) return { action: 'escalate', reasons: [`imported ${r.source || ''} run: the factory did not spec or build it`] };
  const why: string[] = [], asks: string[] = [], git = (f.host ?? 'github') !== 'github';
  const assoc = Object.hasOwn(f, 'association') ? f.association : r.association; // facts() reads it live from the tracker; its null is never intake's
  if (f.trustBroken) (git && f.unverifiable ? asks : why).push(f.trustBroken); // the tracker can't say: never intake's recorded association instead
  else if (!TRUSTED.includes(assoc)) (git ? asks : why).push(`author association "${assoc || 'unknown'}" is not trusted`);
  if (r.originAssociation && !TRUSTED.includes(r.originAssociation)) (git ? asks : why).push(`split from ${r.origin}, whose author "${r.originAssociation}" is not trusted`);
  if (f.autoMerge === false) (git ? asks : why).push(git ? 'auto-merge is turned off for this project: it merges once you approve the reviewed commit (F approve RUN --merge)'
    : 'auto-merge is turned off for this project: merge the PR in GitHub yourself (F sync records it)'); // GitHub: a human merges there; the typed approval is a speed bump an agent can clear
  if (f.headBroken) why.push(f.headBroken);
  const expected = r.axes?.[r.iteration] || [];
  const rev = r.reviews[r.iteration] || {};
  const notPassed = expected.filter((a) => rev[a]?.verdict !== 'passed');
  if (!expected.length) why.push('no reviews recorded');
  if (notPassed.length) why.push(`axes not passed: ${notPassed.join(', ')}`);
  // CI: required unless a rule says otherwise. Not required never means green: F's own local checks on the reviewed commit stand in, or the run escalates.
  const pol = f.rules || {}, ci = pol.ci?.value || 'required', cmds = pol['checks.commands']?.value;
  const by = (x: Rule) => `set by ${byText(x)} on ${String(x.setAt).slice(0, 10)}: ${x.reason}`;
  if (f.ciBroken) why.push(f.ciBroken); // fail closed, even under ci=skip: a provider that can't answer never reads as fine
  else if (ci === 'required' && f.checks !== 'pass') why.push(`CI checks are "${f.checks ?? 'unknown'}"${f.ciDetail ? ` (${f.ci ?? 'github-actions'}: ${f.ciDetail})` : ''}`);
  // CI provider local passes on checks.commands: on a verified host, that rule must come from a verified login too
  if ((f.host ?? 'github') === 'github' && f.ci === 'local' && f.checks === 'pass' && pol['checks.commands'] && isLocal(pol['checks.commands']))
    why.push(`rule checks.commands was set by ${byText(pol['checks.commands'])}: CI provider local passes on it, and on a GitHub project that needs a verified login (gh auth login) before the factory merges on its own`);
  // A rule that relaxes CI counts only from a verified login: a local (OS user) one is recorded and shown, never merged on.
  // Only when the merge relies on it: with GitHub CI green, the relaxation changes nothing.
  if (f.checks !== 'pass') for (const [k, x] of [[`ci=${ci}`, ci !== 'required' && pol.ci], ['checks.commands', ci !== 'required' && cmds && pol['checks.commands']]] as const)
    if (x && isLocal(x)) why.push(`rule ${k} was set by ${byText(x)}: a rule that relaxes CI needs a verified login (gh auth login) before the factory merges on its own`);
  const ruleNote = ci === 'required' ? null : `CI not required by rule ci=${ci}, ${by(pol.ci as Rule)}${ci === 'advisory' ? ` (CI is "${f.checks ?? 'unknown'}")` : ''}`;
  let local = null;
  if (ci !== 'required' || cmds) {
    const l = localResult(r.localChecks, cmds, r.reviewedSha);
    local = { ok: l.state === 'pass', text: l.text };
  }
  const ciLine = [ruleNote, local?.text].filter(Boolean).join('. ');
  if (local && !local.ok) why.push(ciLine);
  const lines = (f.additions || 0) + (f.deletions || 0), cap = Math.min(MAX_DIFF, (pol.diffCap?.value ?? MAX_DIFF) as number);
  if (lines > cap) why.push(`diff is ${lines} lines (max ${cap}${cap < MAX_DIFF ? ` by rule diffCap, ${by(pol.diffCap as Rule)}` : ''})`);
  const sens = (f.files || []).filter(sensitive);
  if (sens.length) why.push(`touches sensitive paths: ${sens.join(', ')}`);
  if (r.iteration > CAP) why.push(`iteration ${r.iteration} exceeds cap ${CAP}`);
  const b = budget(r);
  if (b.over) why.push(`run budget exceeded ${budgetWhy(b)}`);
  const src = (f.files || []).filter((p) => SOURCE.test(p) && !TEST.test(p));
  if (src.length && !(f.files || []).some((p) => TEST.test(p))) why.push(`source changed (${src.length} file(s)) with no test change`);
  if (!r.pr) why.push('no PR recorded');
  if (!r.reviewedSha) why.push('no reviewed commit recorded'); // merge() merges exactly that commit: without it, a "merge" decision could never happen
  if (ciLine && local?.ok && why.length) why.push(ciLine); // context: this escalation happened under a CI rule
  // Rule deploy.preview: a ready preview of the reviewed commit from any web-deploy connector (only the normalized fields count).
  const pv = pol['deploy.preview']?.value || 'off', notes: string[] = [];
  if (pv !== 'off') {
    const sha = r.reviewedSha, hit = sha && (f.deploys ?? r.deploys ?? []).find((d) => d.kind === 'web-deploy' && d.env === 'preview' && d.state === 'ready' && d.sha === sha && /^https:\/\//.test(d.url || ''));
    const line = hit ? `preview ready: ${hit.url} (${hit.connector})` : `no ready preview deploy for the reviewed commit ${String(sha || 'none').slice(0, 7)} (rule deploy.preview=${pv}, ${by(pol['deploy.preview'] as Rule)})`;
    (!hit && pv === 'required' ? why : notes).push(line); // advisory: shown, never blocking
  }
  if (why.length) return { action: 'escalate', reasons: [...why, ...asks, ...notes] };
  const yes = r.reviewedSha && r.events?.findLast((e) => e.stage === 'approve' && e.status === 'passed' && e.sha === r.reviewedSha); // only a git project has asks
  if (asks.length && !yes) return { action: 'await-approval', reasons: [...asks, ...notes] };
  const ok = asks.length && yes ? [`merge approved by ${byText(yes)} for ${String(r.reviewedSha).slice(0, 7)}: ${asks.join('; ')}`] : [];
  return ciLine ? { action: 'merge', reasons: [`trusted author, all axes passed, tests changed, ${lines}-line diff, no sensitive paths`, ...(ci === 'required' ? ['CI green'] : []), ciLine, ...ok, ...notes] }
    : { action: 'merge', reasons: [`trusted author, all axes passed, CI green, tests changed, ${lines}-line diff, no sensitive paths`, ...ok, ...notes] };
}
// Before building: untrusted authors and sensitive planned files need a human to approve the spec.
export function risk(r: Run, plannedFiles: string[]) {
  const reasons = [];
  if (!TRUSTED.includes(r.association)) reasons.push(`author association "${r.association || 'unknown'}" is not trusted`);
  if (r.originAssociation && !TRUSTED.includes(r.originAssociation)) reasons.push(`split from ${r.origin}, whose author is not trusted`);
  const sens = plannedFiles.filter(sensitive);
  if (sens.length) reasons.push(`plans to touch sensitive paths: ${sens.join(', ')}`);
  return { risky: reasons.length > 0, reasons };
}
export function metrics(runs: Run[]): Metrics {
  const count = (o: string) => runs.filter((r) => r.outcome === o).length;
  const humanMerged = runs.filter((r) => r.outcome === 'merged' && r.humanMerge).length; // escalated, then merged on GitHub by a human (#21)
  const merged = count('merged') - humanMerged, escalated = count('escalated') + humanMerged; // merge rate = the factory's own merges
  const built = runs.filter((r) => !r.imported && ['merged', 'escalated'].includes(r.outcome));
  const cycles = built.map((r) => r.durationMs).sort((a, b) => a - b);
  const reverts = runs.filter((r) => r.reverted && !r.humanMerge).length; // of the factory's own merges, like the rate's denominator
  const spent = (r: Run) => r.burn?.total || { tokens: r.tokens || 0, costUsd: r.costUsd ?? null };
  const costUsd = +runs.reduce((s, r) => s + (spent(r).costUsd || 0), 0).toFixed(2);
  const tokens = runs.reduce((s, r) => s + spent(r).tokens, 0);
  const byStage: Record<string, number> = {};
  for (const r of runs) for (const [k, c] of Object.entries(r.burn?.byStage || {})) byStage[k] = (byStage[k] || 0) + c.tokens;
  return {
    runs: runs.length, inProgress: count('in-progress'), merged, humanMerged, escalated, rejected: count('rejected'), needsInfo: count('needs-info'),
    closed: count('closed'), awaitingApproval: count('awaiting-approval'), split: count('split'),
    mergeRate: merged + escalated ? +(merged / (merged + escalated)).toFixed(3) : null,
    avgIterations: built.length ? +(built.reduce((s, r) => s + r.iteration, 0) / built.length).toFixed(2) : null,
    medianCycleMs: cycles[Math.floor(cycles.length / 2)] ?? null,
    reverts, revertRate: merged ? +(reverts / merged).toFixed(3) : null,
    costUsd, costPerMergeUsd: merged ? +(costUsd / merged).toFixed(2) : null,
    tokens, tokensPerMerge: merged ? Math.round(tokens / merged) : null, measuredRuns: runs.filter((r) => r.burn?.measured).length,
    stageShare: Object.fromEntries(Object.entries(byStage).map(([k, n]) => [k, tokens ? +(n / tokens).toFixed(3) : 0])),
  };
}
