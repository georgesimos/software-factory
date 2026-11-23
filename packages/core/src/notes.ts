// @ts-nocheck
// Notes: a one-shot, run-scoped instruction from the user for one step (or "next": whichever steps start next).
// Same limits as guidance, and only ever from the user's own chat message or the F ui box. Recorded like rule
// changes, outside record(): no stage/status of the run, no session, so burn and the gate never see them.
import { randomUUID } from 'node:crypto';
import { BUILTIN_AXES, STEP_KEYS, skills } from './skills.ts';
import { TERMINAL } from './constants.ts';
import { audit, isGuideKey, whoami } from './rules.ts';
import { derive } from './derive.ts';
import { read } from './log.ts';

export const NOTE_MAX = 1000;
const noteStep = (s, at) => { if (s === '*' || !isGuideKey(s)) throw new Error(`${at}: "${s}" is not one step (${STEP_KEYS.join('|')}|review.<extra axis>)`); };
const runOf = (run) => { const runs = derive(read()); return Object.hasOwn(runs, run) ? runs[run] : undefined; }; // own keys only: "__proto__" is not a run
const ran = (r, step) => r.events.some((e) => (step.startsWith('review.') ? e.stage === 'review' && e.axis === step.slice(7) : e.stage === step));

export function note(run, step, text) {
  if (step !== 'next') noteStep(step, 'note');
  text = String(text ?? '').trim();
  if (!text || text.length > NOTE_MAX) throw new Error(`note text must be 1-${NOTE_MAX} characters`);
  const r = runOf(run);
  if (!r) throw new Error(`no run ${run}`);
  const axis = step.startsWith('review.') && step.slice(7);
  if (axis && !BUILTIN_AXES.includes(axis) && !skills(run.split('#')[0]).extra.some((x) => x.axis === axis)) throw new Error(`note: review.${axis} is not an axis of ${run.split('#')[0]} (built-in, or axes.extra in F skills)`);
  if (r.imported) throw new Error(`${run} is imported: the factory doesn't build it, so no step would read the note`);
  if (TERMINAL.includes(r.outcome)) throw new Error(`${run} is ${r.outcome}: notes steer a running issue`);
  const e = { id: `n-${randomUUID()}`, step, text, by: whoami('writing the note') }; // unique: the CLI and the F ui box may write at once
  audit(run, 'pending', e, 'note');
  return step !== 'next' && ran(r, step) ? { ...e, warning: `${step} already ran: this note waits until a gate loops back to it` } : e;
}

// Hands each pending note to the steps starting now, once. A note for a step that already ran waits for a loop-back to it.
// No lock: the claim is one appended line, and derive() gives each note to the first claim in the log that lists it,
// so two callers starting together re-read the log and each returns only the notes its own claim won.
export function takeNotes(run, steps) {
  if (!steps.length) throw new Error('usage: notes <run> <step…> (every step starting now, e.g. all review axes in one call)');
  for (const s of steps) noteStep(s, 'notes');
  const due = (runOf(run)?.notes || []).filter((n) => n.state === 'pending' && (n.step === 'next' || steps.includes(n.step))); // no run yet (a new issue's intake): nothing due
  if (!due.length) return {};
  const claim = randomUUID();
  audit(run, 'applied', { claim, notes: due.map((n) => n.id), steps }, 'note');
  const won = runOf(run).notes.filter((n) => n.claim === claim);
  return Object.fromEntries(steps.map((s) => [s, won.filter((n) => n.step === 'next' || n.step === s).map((n) => n.text)]).filter(([, t]) => t.length));
}
