import { useId, useState, type ReactNode } from 'react';
import { Button } from '../components/Button.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { Input, Select } from '../components/Input.tsx';
import { STEP_OUTCOMES, insertStep, nodeLabel, slotLabel, slotProblems, slotTargets, type Pipeline, type SlotName, type UserStep, type UserStepKind } from './pipelineModel.ts';

/** Adding the user's own steps: the host saves the new slots (the dashboard copies the command), and says how it went. */
export interface UserStepEditing {
  save: (slots: Pick<Pipeline, SlotName>) => void;
  status?: { text: ReactNode; bad?: boolean };
}
export type InsertAt = { slot: SlotName; after?: string; before: string };
const KINDS: [UserStepKind, string][] = [['step', 'Subagent step'], ['check', 'Shell check'], ['human', 'Your approval']];
const GOOD = new Set(['passed', 'approved']);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 32);

/** n8n's "+" on a connection, in this design system: what kind of step, its name, and where each outcome sends the run. */
export function PipelineInsert({ p, at, onClose, onSave }: { p: Pipeline; at: InsertAt; onClose: () => void; onSave: (slots: Pick<Pipeline, SlotName>) => void }) {
  const uid = useId(), [kind, setKind] = useState<UserStepKind>('step'), [name, setName] = useState(''), [run, setRun] = useState('');
  const [next, setNext] = useState<Record<string, string>>({}), [problems, setProblems] = useState<string[]>([]);
  const { stage, back } = slotTargets(p, at.slot), mine = p[at.slot]?.steps ?? [];
  const targets: [string, string][] = [...mine.map((x): [string, string] => [x.id, x.label || x.id]), [stage, nodeLabel(stage)], ...back.map((b): [string, string] => [b, `Back to ${nodeLabel(b)}`]), ['escalate', 'Escalate to you']];
  const to = (o: string) => next[o] ?? (GOOD.has(o) ? at.before : 'escalate');
  const add = () => {
    const id = slug(name) || name.trim(), st: UserStep = { id, kind, label: name.trim(), ...(kind === 'check' && { run: run.trim() }), next: Object.fromEntries(STEP_OUTCOMES[kind].map((o) => [o, to(o)])) };
    const slots = insertStep(p, at, st), bad = slotProblems({ ...p, ...slots });
    if (bad.length) return setProblems(bad);
    onSave(slots);
    onClose();
  };
  const where = slotLabel(at.slot);
  return (
    <Dialog open onClose={onClose} title={`Add a step ${where[0]!.toLowerCase()}${where.slice(1)}`} description="It runs on every issue this pipeline takes, after F’s step before it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={add}>Add step</Button></>}>
      <div className="sf-pl-insert">
        <fieldset><legend>Kind</legend>
          {KINDS.map(([k, label]) => <label key={k}><input type="radio" name={`${uid}-kind`} checked={kind === k} onChange={() => { setKind(k); setProblems([]); }} /> {label}</label>)}
        </fieldset>
        <label>Name<Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'check' ? 'Lint' : kind === 'human' ? 'On-call approves' : 'Write a plan'} /></label>
        {kind === 'check' ? <>
          <label>Command<Input value={run} onChange={(e) => setRun(e.target.value)} placeholder="pnpm lint" spellCheck={false} /></label>
          <p className="sf-pl-note">A shell check runs a command on the machine F runs on, so adding one is human-only: F asks you to confirm it, and over HTTP it needs the desktop’s confirmation.</p>
        </> : null}
        {STEP_OUTCOMES[kind].map((o) => (
          <label key={o}>When {o}<Select value={to(o)} onChange={(e) => setNext({ ...next, [o]: e.target.value })}>
            {targets.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select></label>
        ))}
        {problems.length ? <ul className="sf-pl-problems" role="alert">{problems.map((x) => <li key={x}>{x}</li>)}</ul> : null}
      </div>
    </Dialog>
  );
}
