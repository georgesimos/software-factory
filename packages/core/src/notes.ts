// Notes: a one-shot, run-scoped instruction from the user for one step (or "next": whichever steps start next).
// Same limits as guidance, and only ever from the user's own chat message. Recorded like rule
// changes, outside record(): no stage/status of the run, no session, so burn and the gate never see them.
import { randomUUID } from 'node:crypto';
import { STEP_KEYS, isBuiltinAxis, skills } from './skills.ts';
import { TERMINAL } from './constants.ts';
import { audit, isGuideKey, whoami } from './rules.ts';
import { derive } from './derive.ts';
import { read } from './log.ts';
import type { Run } from './types.ts';

export const NOTE_MAX = 1000;
const noteStep = (s: string, at: string) => { if (s === '*' || !isGuideKey(s)) throw new Error(`${at}: "${s}" is not one step (${STEP_KEYS.join('|')}|review.<extra axis>)`); };
const runOf = (run: string): Run | undefined => { const runs = derive(read()); return Object.hasOwn(runs, run) ? runs[run] : undefined; }; // own keys only: "__proto__" is not a run
// Whether a step already ran, by the events it records: the verifier is a review usage record, postmerge follows "approve merged".
const ran = (r: Run, step: string) => r.events.some((e) => (step === 'verifier' ? e.stage === 'review' && e.role === 'verifier'
  : step === 'postmerge' ? e.stage === 'approve' && e.status === 'merged'
  : step.startsWith('review.') ? e.stage === 'review' && e.axis === step.slice(7) : e.stage === step));
// review.<axis> must be built in or in this repo's axes.extra
const checkAxis = (run: string, step: string, at: string) => {
  const axis = step.startsWith('review.') && step.slice(7), repo = run.split('#')[0] as string; // split always has a first part
  if (axis && !isBuiltinAxis(axis) && !skills(repo).extra.some((x) => x.axis === axis)) throw new Error(`${at}: review.${axis} is not an axis of ${repo} (built-in, or axes.extra in F skills)`);
};

export function note(run: string, step: string, text: unknown) {
  if (step !== 'next') noteStep(step, 'note');
  const body = String(text ?? '').trim();
  if (!body || body.length > NOTE_MAX) throw new Error(`note text must be 1-${NOTE_MAX} characters`);
  const r = runOf(run);
  if (!r) throw new Error(`no run ${run}`);
  if (step !== 'next') checkAxis(run, step, 'note');
  if (r.imported) throw new Error(`${run} is imported: the factory doesn't build it, so no step would read the note`);
  if (TERMINAL.includes(r.outcome)) throw new Error(`${run} is ${r.outcome}: notes steer a running issue`);
  const done = step !== 'next' && ran(r, step) && !(step === 'intake' && r.outcome === 'needs-info'); // needs-info: intake runs again
  // Gates loop back only to spec or build; intake reruns only from needs-info, postmerge never. Refuse rather than keep a note nobody reads.
  if (done && ['intake', 'postmerge'].includes(step)) throw new Error(`${step} already ran for ${run} and won't run again, so no step would read the note; use "next"`);
  const e = { id: `n-${randomUUID()}`, step, text: body, by: whoami('writing the note') }; // unique: two writers may append at once
  audit(run, 'pending', e, 'note');
  return done ? { ...e, warning: `${step} already ran: the note is handed out only if a gate loops back to it, so it may never be used` } : e;
}

// Hands each pending note to the steps starting now, once. A note for a step that already ran waits for a loop-back to it.
// No lock: the claim is one appended line, and derive() gives each note to the first claim in the log that lists it,
// so two callers starting together re-read the log and each returns only the notes its own claim won.
export function takeNotes(run: string, steps: string[]) {
  if (!steps.length) throw new Error('usage: notes <run> <step…> (every step starting now, e.g. all review axes in one call)');
  for (const s of steps) { noteStep(s, 'notes'); checkAxis(run, s, 'notes'); }
  const due = (runOf(run)?.notes || []).filter((n) => n.state === 'pending' && (n.step === 'next' || steps.includes(n.step ?? ''))); // no run yet (a new issue's intake): nothing due
  if (!due.length) return {};
  const claim = randomUUID();
  audit(run, 'applied', { claim, notes: due.map((n) => n.id), steps }, 'note');
  const won = (runOf(run)?.notes ?? []).filter((n) => n.claim === claim); // the claim just appended: the run is there
  return Object.fromEntries(steps.map((s) => [s, won.filter((n) => n.step === 'next' || n.step === s).map((n) => n.text)] as const).filter(([, t]) => t.length));
}
