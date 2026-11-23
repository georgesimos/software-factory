// @ts-nocheck
import path from 'node:path';
import { CAP, DOCS, MAX_DIFF, SEO, SOURCE, TEST, TRUSTED, UI, blocking, sensitive } from './constants.ts';
import { budget, budgetWhy } from './derive.ts';

export function axesFor(files, extra = []) {
  const axes = ['code', 'security'];
  if (files.some((f) => UI.test(f))) axes.push('ux', 'ui');
  if (files.some((f) => SEO.test(f))) axes.push('seo');
  if (files.some((f) => DOCS.test(f))) axes.push('docs');
  for (const x of extra) if (files.some((f) => x.when.some((g) => path.matchesGlob(f, g)))) axes.push(x.axis); // user axes only add, never replace. shortcut: path.matchesGlob needs Node >= 22.5 (experimental before 24); swap in a small glob regex if older Node matters
  return axes;
}
// Loop-backs re-review only what the new commits touch, plus every axis that failed last time.
export function reviewAxes(r, files, extra = []) {
  const prev = Math.max(-1, ...Object.keys(r.axes || {}).map(Number).filter((i) => i < r.iteration));
  const failed = prev < 0 ? [] : r.axes[prev].filter((a) => r.reviews[prev]?.[a]?.verdict !== 'passed');
  return [...new Set([...axesFor(files, extra), ...failed])];
}
export function gate(r) {
  const expected = r.axes?.[r.iteration];
  if (!expected) throw new Error(`no review axes recorded for iteration ${r.iteration}; run "axes" first`);
  const rev = r.reviews[r.iteration] || {};
  const missing = expected.filter((a) => !rev[a]);
  if (missing.length) throw new Error(`missing review verdicts: ${missing.join(', ')}`);
  const failed = expected.filter((a) => rev[a].verdict !== 'passed');
  if (!failed.length) return { status: 'passed', next: 'approve', reasons: [`all axes passed: ${expected.join(', ')}`] };
  const findings = failed.flatMap((a) => rev[a].findings.filter(blocking));
  const route = findings.some((f) => f.route === 'spec') ? 'spec' : 'build';
  const reasons = failed.map((a) => `${a}: ${rev[a].findings.filter(blocking).length} blocking finding(s)`);
  if (r.iteration >= CAP) return { status: 'failed', next: 'approve', reasons: [...reasons, `loop cap ${CAP} reached`] };
  const b = budget(r);
  if (b.over) return { status: 'failed', next: 'approve', reasons: [...reasons, `budget reached ${budgetWhy(b)}`] };
  return { status: 'failed', next: route, reasons };
}
// Default is escalate: merge only when every condition holds.
export function decide(r, f) {
  if (r.imported) return { action: 'escalate', reasons: [`imported ${r.source || ''} run: the factory did not spec or build it`] };
  const why = [];
  const assoc = f.association ?? r.association; // facts() reads it live from GitHub
  if (!TRUSTED.includes(assoc)) why.push(`author association "${assoc || 'unknown'}" is not trusted`);
  if (r.originAssociation && !TRUSTED.includes(r.originAssociation)) why.push(`split from ${r.origin}, whose author "${r.originAssociation}" is not trusted`);
  if (f.autoMerge === false) why.push('auto-merge is turned off for this project');
  const expected = r.axes?.[r.iteration] || [];
  const rev = r.reviews[r.iteration] || {};
  const notPassed = expected.filter((a) => rev[a]?.verdict !== 'passed');
  if (!expected.length) why.push('no reviews recorded');
  if (notPassed.length) why.push(`axes not passed: ${notPassed.join(', ')}`);
  // CI: required unless a rule says otherwise. Not required never means green: F's own local checks on the reviewed commit stand in, or the run escalates.
  const pol = f.rules || {}, ci = pol.ci?.value || 'required', cmds = pol['checks.commands']?.value;
  const by = (x) => `set by ${x.setBy} on ${String(x.setAt).slice(0, 10)}: ${x.reason}`;
  if (ci === 'required' && f.checks !== 'pass') why.push(`CI checks are "${f.checks ?? 'unknown'}"`);
  const ruleNote = ci === 'required' ? null : `CI not required by rule ci=${ci}, ${by(pol.ci)}${ci === 'advisory' ? ` (CI is "${f.checks ?? 'unknown'}")` : ''}`;
  let local = null;
  if (ci !== 'required' || cmds) {
    const lc = r.localChecks, short = (s) => String(s || 'none').slice(0, 7);
    const failing = (lc?.commands || []).filter((c) => c.exit !== 0).map((c) => c.cmd);
    local = !cmds ? { ok: false, text: 'no checks.commands rule replaces CI, so nothing was checked' }
      : !lc ? { ok: false, text: 'Local checks: not run ("F checks")' }
      : lc.sha !== r.reviewedSha ? { ok: false, text: `Local checks: ran on ${short(lc.sha)}, not the reviewed commit ${short(r.reviewedSha)}` }
      : JSON.stringify((lc.commands || []).map((c) => c.cmd)) !== JSON.stringify(cmds) ? { ok: false, text: 'Local checks: ran a different command list than the checks.commands rule now has' }
      : lc.state !== 'pass' || failing.length ? { ok: false, text: `Local checks: fail (${failing.join(', ') || 'unknown'})` }
      : { ok: true, text: `Local checks: pass (${cmds.join(', ')})` };
  }
  const ciLine = [ruleNote, local?.text].filter(Boolean).join('. ');
  if (local && !local.ok) why.push(ciLine);
  const lines = (f.additions || 0) + (f.deletions || 0), cap = Math.min(MAX_DIFF, pol.diffCap?.value ?? MAX_DIFF);
  if (lines > cap) why.push(`diff is ${lines} lines (max ${cap}${cap < MAX_DIFF ? ` by rule diffCap, ${by(pol.diffCap)}` : ''})`);
  const sens = (f.files || []).filter(sensitive);
  if (sens.length) why.push(`touches sensitive paths: ${sens.join(', ')}`);
  if (r.iteration > CAP) why.push(`iteration ${r.iteration} exceeds cap ${CAP}`);
  const b = budget(r);
  if (b.over) why.push(`run budget exceeded ${budgetWhy(b)}`);
  const src = (f.files || []).filter((p) => SOURCE.test(p) && !TEST.test(p));
  if (src.length && !(f.files || []).some((p) => TEST.test(p))) why.push(`source changed (${src.length} file(s)) with no test change`);
  if (!r.pr) why.push('no PR recorded');
  if (ciLine && local?.ok && why.length) why.push(ciLine); // context: this escalation happened under a CI rule
  // Rule deploy.preview: a ready preview of the reviewed commit from any web-deploy connector (only the normalized fields count).
  const pv = pol['deploy.preview']?.value || 'off', notes = [];
  if (pv !== 'off') {
    const sha = r.reviewedSha, hit = sha && (f.deploys ?? r.deploys ?? []).find((d) => d.kind === 'web-deploy' && d.env === 'preview' && d.state === 'ready' && d.sha === sha && /^https:\/\//.test(d.url || ''));
    const line = hit ? `preview ready: ${hit.url} (${hit.connector})` : `no ready preview deploy for the reviewed commit ${String(sha || 'none').slice(0, 7)} (rule deploy.preview=${pv}, ${by(pol['deploy.preview'])})`;
    (!hit && pv === 'required' ? why : notes).push(line); // advisory: shown, never blocking
  }
  return why.length
    ? { action: 'escalate', reasons: [...why, ...notes] }
    : ciLine ? { action: 'merge', reasons: [`trusted author, all axes passed, tests changed, ${lines}-line diff, no sensitive paths`, ...(ci === 'required' ? ['CI green'] : []), ciLine, ...notes] }
    : { action: 'merge', reasons: [`trusted author, all axes passed, CI green, tests changed, ${lines}-line diff, no sensitive paths`, ...notes] };
}
// Before building: untrusted authors and sensitive planned files need a human to approve the spec.
export function risk(r, plannedFiles) {
  const reasons = [];
  if (!TRUSTED.includes(r.association)) reasons.push(`author association "${r.association || 'unknown'}" is not trusted`);
  if (r.originAssociation && !TRUSTED.includes(r.originAssociation)) reasons.push(`split from ${r.origin}, whose author is not trusted`);
  const sens = plannedFiles.filter(sensitive);
  if (sens.length) reasons.push(`plans to touch sensitive paths: ${sens.join(', ')}`);
  return { risky: reasons.length > 0, reasons };
}
export function metrics(runs) {
  const count = (o) => runs.filter((r) => r.outcome === o).length;
  const merged = count('merged'), escalated = count('escalated');
  const built = runs.filter((r) => !r.imported && ['merged', 'escalated'].includes(r.outcome));
  const cycles = built.map((r) => r.durationMs).sort((a, b) => a - b);
  const reverts = runs.filter((r) => r.reverted).length;
  const spent = (r) => r.burn?.total || { tokens: r.tokens || 0, costUsd: r.costUsd ?? null };
  const costUsd = +runs.reduce((s, r) => s + (spent(r).costUsd || 0), 0).toFixed(2);
  const tokens = runs.reduce((s, r) => s + spent(r).tokens, 0);
  const byStage = {};
  for (const r of runs) for (const [k, c] of Object.entries(r.burn?.byStage || {})) byStage[k] = (byStage[k] || 0) + c.tokens;
  return {
    runs: runs.length, inProgress: count('in-progress'), merged, escalated, rejected: count('rejected'), needsInfo: count('needs-info'),
    closed: count('closed'), awaitingApproval: count('awaiting-approval'), split: count('split'),
    mergeRate: merged + escalated ? +(merged / (merged + escalated)).toFixed(3) : null,
    avgIterations: built.length ? +(built.reduce((s, r) => s + r.iteration, 0) / built.length).toFixed(2) : null,
    medianCycleMs: cycles.length ? cycles[Math.floor(cycles.length / 2)] : null,
    reverts, revertRate: merged ? +(reverts / merged).toFixed(3) : null,
    costUsd, costPerMergeUsd: merged ? +(costUsd / merged).toFixed(2) : null,
    tokens, tokensPerMerge: merged ? Math.round(tokens / merged) : null, measuredRuns: runs.filter((r) => r.burn?.measured).length,
    stageShare: Object.fromEntries(Object.entries(byStage).map(([k, n]) => [k, tokens ? +(n / tokens).toFixed(3) : 0])),
  };
}
