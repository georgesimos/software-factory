// @ts-nocheck
// Notes: a one-shot, run-scoped instruction from the user for one step (or "next": whichever steps start next).
// Same limits as guidance, and only ever from the user's own chat message or the F ui box. Recorded like rule
// changes, outside record(): no stage/status of the run, no session, so burn and the gate never see them.
import { STEP_KEYS } from './skills.ts';
import { TERMINAL } from './constants.ts';
import { audit, isGuideKey, whoami } from './rules.ts';
import { derive } from './derive.ts';
import { read } from './log.ts';

export const NOTE_MAX = 1000;
const noteStep = (s, at) => { if (s === '*' || !isGuideKey(s)) throw new Error(`${at}: "${s}" is not one step (${STEP_KEYS.join('|')}|review.<extra axis>)`); };
const runOf = (run) => {
  const runs = derive(read());
  if (!Object.hasOwn(runs, run)) throw new Error(`no run ${run}`); // own keys only: "__proto__" must not pass as a run
  return runs[run];
};

export function note(run, step, text) {
  if (step !== 'next') noteStep(step, 'note');
  text = String(text ?? '').trim();
  if (!text || text.length > NOTE_MAX) throw new Error(`note text must be 1-${NOTE_MAX} characters`);
  const r = runOf(run);
  if (r.imported) throw new Error(`${run} is imported: the factory doesn't build it, so no step would read the note`);
  if (TERMINAL.includes(r.outcome)) throw new Error(`${run} is ${r.outcome}: notes steer a running issue`);
  const e = { id: `n${(r.notes?.length || 0) + 1}`, step, text, by: whoami('writing the note') };
  audit(run, 'pending', e, 'note');
  return e;
}

// Hands each pending note to the steps starting now, once. A note for a step that already ran waits for a loop-back to it.
export function takeNotes(run, steps) {
  if (!steps.length) throw new Error('usage: notes <run> <step…> (every step starting now, e.g. all review axes in one call)');
  for (const s of steps) noteStep(s, 'notes');
  const due = (runOf(run).notes || []).filter((n) => n.state === 'pending' && (n.step === 'next' || steps.includes(n.step)));
  if (!due.length) return {};
  audit(run, 'applied', { notes: due.map((n) => n.id), steps }, 'note');
  return Object.fromEntries(steps.map((s) => [s, due.filter((n) => n.step === 'next' || n.step === s).map((n) => n.text)]).filter(([, t]) => t.length));
}
