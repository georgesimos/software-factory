// docs/plans/pipelines.md §3, §7.4: custom steps in a run. F steps works out which are due at a slot and records them (custom
// started); F step records one step's result (custom passed|failed), with F review's contract. Core enforces that they run:
// build started refuses a spec.after step with no result, F axes a build.after one, the gate fails on a failed or missing one
// and routes it by slot, and decide escalates. A custom step only adds a failure: it never clears one and never moves the gate.
import path from 'node:path';
import { FINDING_KEYS, SEVERITIES, blocking } from './constants.ts';
import { INVALID, derive, thisRun } from './derive.ts';
import { read } from './log.ts';
import { SLOTS, ownersOf, routeOf, type CustomStep, type Slot } from './route.ts';
import { readSkills, type SkillsConfig } from './skills.ts';
import type { FactoryEvent, Finding, Run } from './types.ts';

const repoOf = (id: string) => id.split(/[#:@]/)[0] as string; // split always has a first part
const isCustom = (e: FactoryEvent, status?: string) => e.stage === 'custom' && (!status || e.status === status);
/** The pipelines a run was routed to so far (the meet's, §7.4), the default left out: it adds nothing of its own. */
export const pickedOf = (events: FactoryEvent[]) => [...new Set((routeOf(events)?.picks ?? []).map((p) => p.pipeline).filter((p) => p !== 'default'))];

/** The meet's custom steps (§7.4): the project's (default's, then its own), then each pipeline's the run was routed to, in pick
 *  order; a step that has been due stays due through the run's records (slotState). spec.after steps are the project's only. */
export function customOf(repo: string, pipelines: string[] = [], cfg: SkillsConfig = readSkills()): Record<Slot, CustomStep[]> {
  const { owners } = ownersOf(repo, cfg), out: Record<Slot, CustomStep[]> = { 'spec.after': [], 'build.after': [] }, seen = new Set<string>();
  const mine = pipelines.map((id) => owners.find((o) => o.owner === `${repo}@${id}`)).filter((o) => !!o);
  for (const [i, o] of [owners[0]!, ...mine].entries()) for (const c of o.custom) { // owners[0]: the project, always
    if (seen.has(c.id) || (i > 0 && c.slot !== 'build.after')) continue;
    seen.add(c.id); out[c.slot].push(c);
  }
  return out;
}
/** The run's custom steps now: its project's, then its picked pipelines'. */
export const runCustom = (r: Pick<Run, 'id' | 'events'>, cfg: SkillsConfig = readSkills()) => customOf(repoOf(r.id), pickedOf(thisRun(r.events)), cfg);
/** A step's when, against the run's whole change: no when means every change. */
export const dueOn = (c: CustomStep, files: string[]) => !c.when || files.some((f) => c.when!.some((g) => path.matchesGlob(f, g)));

/** One phase of a slot in a run's events (this attempt): spec.after runs from intake, or from the last gate that looped back to
 *  spec (a build loop-back keeps the spec, and its spec.after results); build.after from a build started (back: phases before
 *  the last). null when it hasn't begun. */
export function phase(events: FactoryEvent[], slot: Slot, back = 0): FactoryEvent[] | null {
  if (slot === 'spec.after') return back ? null : events.slice(events.findLastIndex((e) => e.stage === 'gate' && e.next === 'spec') + 1);
  const at = events.flatMap((e, i) => (e.stage === 'build' && e.status === 'started' ? [i] : [])), k = at.length - 1 - back;
  return k < 0 ? null : events.slice(at[k]! + 1, at[k + 1] ?? events.length);
}
export interface StepResult { status: 'passed' | 'failed'; invalid: boolean; findings: Finding[] }
/** What a phase recorded for a slot: whether F steps ran, what it made due (union: once due, due for the phase) and each result. */
export function slotState(events: FactoryEvent[], slot: Slot) {
  const due: string[] = [], results: Record<string, StepResult> = {};
  let recorded = false;
  for (const e of events) {
    if (!isCustom(e) || e.slot !== slot) continue;
    if (e.status === 'started') { recorded = true; for (const id of Array.isArray(e.ids) ? e.ids : []) if (typeof id === 'string' && !due.includes(id)) due.push(id); }
    else if ((e.status === 'passed' || e.status === 'failed') && typeof e.id === 'string') {
      const findings = Array.isArray(e.findings) ? e.findings : [];
      results[e.id] = { status: e.status, invalid: findings.some((f) => f.issue?.startsWith(INVALID)), findings };
    }
  }
  return { recorded, due, results };
}
/** What a run's custom steps say now, for the gate and decide: per step due in the current phases, missing (no result: a slot
 *  F steps never recorded counts its live steps), failed or passed. live: the slot's ids from config, for a slot never recorded. */
export function customCheck(r: Pick<Run, 'events'>, live: Partial<Record<Slot, string[]>> = {}) {
  const evs = thisRun(r.events), out = { missing: [] as string[], failed: [] as { id: string; slot: Slot }[], passed: [] as string[] };
  for (const slot of SLOTS) {
    const ph = phase(evs, slot);
    if (!ph) continue; // build.after before any build: nothing is due yet
    const st = slotState(ph, slot);
    for (const id of st.recorded ? st.due : live[slot] ?? []) {
      const x = st.results[id];
      if (!x) out.missing.push(id); else if (x.status === 'failed') out.failed.push({ id, slot }); else out.passed.push(id);
    }
  }
  return out;
}
/** The refusal before the next step (§3): F event build started for spec.after, F axes for build.after. Only until something is
 *  recorded for each due step, and F step records anything, a broken runner's output as a failure, so it never strands a run. */
export function customCleared(r: Pick<Run, 'id' | 'events'>, slot: Slot, live: string[], doing: string) {
  const st = slotState(phase(thisRun(r.events), slot) ?? [], slot);
  if (!st.recorded && live.length) throw new Error(`${r.id} has ${slot} custom steps (${live.join(', ')}) that were never started: run F steps ${r.id} ${slot}, run each step it returns and record it with F step ${r.id} <id> passed|failed -, then ${doing}`);
  const missing = st.due.filter((id) => !st.results[id]);
  if (missing.length) throw new Error(`${slot} custom step${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ha${missing.length > 1 ? 've' : 's'} no result: run each and record it with F step ${r.id} <id> passed|failed -, then ${doing}`);
}

/** F steps RUN <slot>: what is due now. The slot's live steps whose when matches the run's whole change, the previous build
 *  phase's failed or unanswered build.after steps still configured (as reviewAxes keeps failed axes), and whatever this phase
 *  already made due. files: the run's whole change (base...HEAD); empty at spec.after, which runs before there is a diff. */
export function stepsDue(r: Pick<Run, 'id' | 'events'>, slot: Slot, files: string[], cfg: SkillsConfig = readSkills()) {
  const evs = thisRun(r.events), ph = phase(evs, slot);
  if (!ph) throw new Error(`${slot} steps run after the build's checks pass: record "build started" first`);
  if (slot === 'spec.after' && ph.some((e) => e.stage === 'build' && e.status === 'started')) throw new Error(`spec.after steps run after the spec is written, before build: ${r.id} already started building on this spec`);
  if (ph.some((e) => e.stage === 'gate')) throw new Error(`${r.id} is already gated: run F steps after the next build`);
  const live = runCustom(r, cfg)[slot], st = slotState(ph, slot), ids = new Set(st.due);
  for (const c of live) if (dueOn(c, files)) ids.add(c.id);
  const prev = slot === 'build.after' ? phase(evs, slot, 1) : null;
  if (prev) { const p = slotState(prev, slot); for (const id of p.due) if (p.results[id]?.status !== 'passed' && live.some((c) => c.id === id)) ids.add(id); }
  const due = live.map((c) => c.id).filter((id) => ids.has(id)).concat([...ids].filter((id) => !live.some((c) => c.id === id))); // config order, then any no longer configured
  return { due, steps: live.filter((c) => ids.has(c.id)) };
}

const STEP_KEYS = ['id', 'verdict', 'findings', 'costUsd', 'tokens', 'usage', 'model'];
/** F step RUN <id> passed|failed: the runner's reply, untrusted text with F review's contract ({id, verdict, findings}). Anything
 *  outside it records a failure, never a pass; it passes only when the word, the verdict and the findings all say so. */
export function stepFromText(run: string, id: string, word: string, text: unknown) {
  if (word !== 'passed' && word !== 'failed') throw new Error('usage: step <run> <id> passed|failed -   (the runner\'s reply on stdin)');
  const r = derive(read())[run];
  if (!r) throw new Error(`no run ${run}`);
  const evs = thisRun(r.events), found = SLOTS.map((slot) => ({ slot, ph: phase(evs, slot) })).find(({ slot, ph }) => ph && slotState(ph, slot).due.includes(id));
  if (!found) throw new Error(`custom step "${id}" is not due now: F steps ${run} <slot> says which are`);
  const { slot } = found, ph = found.ph!;
  if (ph.some((e) => e.stage === 'gate')) throw new Error(`iteration ${r.iteration} is already gated; its custom steps are frozen`);
  if (slot === 'spec.after' && ph.some((e) => e.stage === 'build' && e.status === 'started')) throw new Error('spec.after results close when build starts');
  const prev = slotState(ph, slot).results[id];
  if (prev && !prev.invalid) throw new Error(`a ${prev.status} result for custom step "${id}" is already recorded; only an invalid one can be replaced`);
  const at = { id, slot, iteration: slot === 'spec.after' ? r.iteration + 1 : r.iteration }; // the build it comes before, or after
  try {
    const p = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*\n([^]*)\n```$/, '$1'));
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not a JSON object');
    const extra = Object.keys(p).filter((k) => !STEP_KEYS.includes(k)); // usage fields are ignored: the flags carry it, never the reply
    if (extra.length) throw new Error(`unknown fields: ${extra.join(', ')}`);
    if (p.id !== id) throw new Error(`id is "${p.id}", expected "${id}"`); // a runner can't answer for another step
    if (!['passed', 'failed'].includes(p.verdict)) throw new Error('verdict must be passed|failed');
    const findings: unknown = p.findings ?? [];
    if (!Array.isArray(findings)) throw new Error('findings must be an array');
    for (const f of findings) {
      const bad = f && typeof f === 'object' ? Object.keys(f).filter((k) => !FINDING_KEYS.includes(k)) : ['(not an object)'];
      if (bad.length) throw new Error(`finding has unknown fields: ${bad.join(', ')}`);
      if (!SEVERITIES.includes(f.severity)) throw new Error(`finding severity must be ${SEVERITIES.join('|')}`);
      if (typeof f.issue !== 'string' || !f.issue) throw new Error('finding needs an issue sentence');
      if (f.dismissed !== undefined) throw new Error('a custom step\'s findings are never dismissed'); // no verifier pass for them
    }
    const ok = word === 'passed' && p.verdict === 'passed' && !(findings as Finding[]).some(blocking);
    return { status: ok ? 'passed' : 'failed', payload: { ...at, verdict: p.verdict, findings } };
  } catch (e) {
    return { status: 'failed', payload: { ...at, verdict: 'failed', findings: [{ severity: 'high', issue: `${INVALID}${(e as Error).message}`.slice(0, 300) }] } };
  }
}
