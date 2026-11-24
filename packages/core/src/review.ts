import { INVALID, assertReviewOpen, derive, validateReview } from './derive.ts';
import { blocking } from './constants.ts';
import { harnesses } from '../../adapters/harnesses/index.ts';
import { read } from './log.ts';
import { resolvedSteps, skills, type ExtraAxisRunner, type StepRunner } from './skills.ts';
import type { Runner } from './types.ts';

// Pinned unattended flags come from the harness that runs the skill (claude-code.ts: `claude -p`), so F names no harness.
// `share`: how many headless runs spend the remaining budget at once (parallel reviewers). Each gets an equal cut,
// in whole cents rounded down, so together they can't spend more than is left.
export const MIN_SHARE_USD = 0.05;
export function headlessArgs({ share = 1, ...opts }: { share?: number; budget?: unknown; [k: string]: unknown } = {}) {
  const h = harnesses.find((x) => x.host && x.headlessArgs);
  if (!h) throw new Error('no host harness with headlessArgs() is registered');
  if (!Number.isInteger(share) || share < 1) throw new Error(`share must be a positive integer (got ${share})`);
  const cents = Math.floor(Number(opts.budget) * 100 + 1e-9); // a spent or invalid budget is left for the harness to refuse
  if (share > 1 && opts.budget != null && cents > 0) {
    const each = Math.floor(cents / share) / 100;
    if (each < MIN_SHARE_USD) throw new Error(`budget share $${each} per reviewer is below $${MIN_SHARE_USD}; escalate instead of running`);
    opts = { ...opts, budget: each };
  }
  return h.headlessArgs!(opts); // found by it
}
// F, not the payload, says who did the work. Default runners leave events unchanged; a fallback can only downgrade to default.
export function runnerStamp(run: string, stage: string, axis?: string, fallback?: unknown, role?: string): { runner?: Runner } {
  const key = stage === 'review' ? (role === 'verifier' ? 'verifier' : axis && `review.${axis}`) : stage === 'gate' ? 'verifier' : ['intake', 'spec', 'build'].includes(stage) ? stage : null;
  if (!key) return {};
  const { plan, extra } = skills(run.split(/[#:]/)[0] as string); // split always has a first part
  const found: StepRunner & Partial<ExtraAxisRunner> = plan[key] || extra.find((x) => x.axis === axis) || { use: 'default' };
  const { axis: _a, when: _w, ...runner } = found;
  if (fallback) return { runner: { use: 'default', fallback: { from: runner, reason: String(fallback).slice(0, 200) } } };
  return runner.use === 'default' && !runner.model ? {} : { runner }; // the configured model; the payload's `model` is the measured one
}
// The flags a headless run of one step gets from its resolved runner: model, effort and fallback after the version check.
export function stepModel(run: string, key: string) {
  const all = resolvedSteps(run.split(/[#:]/)[0] as string); // split always has a first part
  if (!all[key]) throw new Error(`unknown step "${key}" (${Object.keys(all).join('|')})`);
  const { model, effort, fallback } = all[key];
  return { model, effort, fallback };
}
// Reviewer output from any runner is untrusted text: anything outside the contract is a failed review, never a pass.
export function reviewFromText(run: string, axis: string, text: unknown) {
  const r = derive(read())[run];
  const axes = r?.axes?.[r.iteration] || [];
  if (!r || !axes.includes(axis)) throw new Error(`axis "${axis}" is not one of this iteration's axes (${axes.join(', ') || 'none recorded'})`);
  assertReviewOpen(r, axis); // before the catch: a frozen review is refused, not turned into an "invalid" one
  try {
    const p = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n([^]*)\n```$/, '$1'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not a JSON object');
    if (p.axis !== axis) throw new Error(`axis is "${p.axis}", expected "${axis}"`); // a reviewer can't overwrite another axis's cell
    if (!['passed', 'failed'].includes(p.verdict)) throw new Error('verdict must be passed|failed');
    validateReview(run, p, p.verdict);
    return { status: (p.findings || []).some(blocking) ? 'failed' : 'passed', payload: p };
  } catch (e) {
    return { status: 'failed', payload: { axis, verdict: 'failed', findings: [{ severity: 'high', issue: `${INVALID}${(e as Error).message}`.slice(0, 300), route: 'build' }] } };
  }
}
