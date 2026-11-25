import { forwardRef, type ReactNode } from 'react';
import { Badge } from '../components/Badge.tsx';
import { Button, IconButton } from '../components/Button.tsx';
import { CloseIcon } from '../components/icons.tsx';
import { Select } from '../components/Input.tsx';
import { formatDuration, formatTokens } from './model.ts';
import { STEP_STATUS, slotLabel, type PipelineNode, type StepResult, type StepRunner } from './pipelineModel.ts';

/** What a step's panel may change: where its runner comes from, and its model and effort ('' inherits). No model: a runner that has none. */
export interface StepEdit {
  from: string;
  model?: { value: string; inherit: string; options: string[] };
  effort?: { value: string; inherit: string; options: string[] };
}
/** Who runs which step can change here; `for` says how for one step, or null for read-only. The host saves each change. */
export interface StepEditing {
  for: (step: string) => StepEdit | null;
  onModel: (step: string, model: string) => void;
  onEffort: (step: string, effort: string) => void;
  onRunner: (step: string) => void;
  /** A step's panel opened: the host clears the last change's status, which was about another step. */
  onOpen?: (step: string) => void;
  /** The last change's result: saved, the command to run, or why it failed. */
  status?: { text: ReactNode; bad?: boolean };
}
export interface PipelineStepPanelProps {
  node: PipelineNode;
  /** The panel's id, unique on the page (the graph's step buttons point at it). */
  id: string;
  /** The runner's display name; a brief is only ever named by its file. */
  runnerName: (r: StepRunner) => string;
  edit?: StepEditing;
  /** The step's latest result in the run shown, and that run's short name. */
  result?: StepResult;
  runLabel?: string;
  /** A user step's outcomes, each with where it sends the run, as the graph names it. */
  outcomes?: [outcome: string, to: string][];
  onClose: () => void;
}
const OWN = new Set(['gate', 'merge', 'watch']); // F's own decisions (docs/plans/pipelines.md §2): never a runner
const KIND: Record<string, string> = { default: 'built-in brief', skill: 'skill', brief: 'brief', provider: 'harness tool' };
const file = (p?: string) => (p ?? '').split(/[\\/]/).pop();

/** One step of a pipeline, beside the graph (n8n's node panel, in this design system): what it is, who runs it, and its result in a run. */
export const PipelineStepPanel = forwardRef<HTMLHeadingElement, PipelineStepPanelProps>(function PipelineStepPanel({ node: n, id, runnerName, edit, result, runLabel, outcomes, onClose }, head) {
  const r = n.runner, e = edit?.for(n.id) ?? null, label = n.label;
  const row = (k: string, v: ReactNode) => (v ? <><dt>{k}</dt><dd>{v}</dd></> : null);
  return (
    <aside className="sf-pl-side sf-pl-panel" aria-label={`${label} step`} id={id}
      onKeyDown={(x) => { if (x.key === 'Escape') { x.preventDefault(); x.stopPropagation(); onClose(); } }}>
      <div className="sf-pl-panel-head">
        <h3 ref={head} tabIndex={-1}>{label}</h3>
        <IconButton label="Close step" size="sm" onClick={onClose}><CloseIcon /></IconButton>
      </div>
      <p>{n.step ? <><Badge quiet>Yours</Badge> Added by this pipeline; F still runs every locked step.</> : n.locked ? <><Badge quiet>Locked</Badge> Every run has it; it can’t be turned off.</> : <><Badge quiet>Optional</Badge> Not on F’s locked list.</>}</p>
      <dl className="sf-pl-dl">
        {n.step && n.slot ? <>
          {row('Kind', n.sub)}
          {row('Where', slotLabel(n.slot))}
          {row('Command', n.step.run ? <code>{n.step.run}</code> : '')}
        </> : row('Runs', n.kind === 'review' ? n.sub : n.sub ? `every issue · ${n.sub}` : 'every issue')}
        {r ? <>
          {row('Runner', r.use === 'brief' ? file(r.path) : runnerName(r))}
          {row('Kind', KIND[r.use || 'default'] ?? r.use)}
          {row('Harness', r.harness)}
          {row('Model', r.model)}
          {row('Effort', r.effort)}
          {row('Fallback', r.fallback?.length ? r.fallback.join(' → ') : '')}
        </> : null}
      </dl>
      {outcomes ? <><p className="sf-label">Outcomes</p><ul className="sf-pl-outcomes" aria-label="Outcomes">{outcomes.map(([k, t]) => <li key={k}>{k} → {t}</li>)}</ul></> : null}
      {n.step ? null : OWN.has(n.id) ? <p className="sf-pl-note">F’s own check, not a runner: nobody else can run it.</p> : e ? (
        <div className="sf-pl-edit">
          <p className="sf-pl-note">{e.from}</p>
          {e.model ? <label>Model<Select aria-label={`Model for ${label}`} value={e.model.value} onChange={(x) => edit!.onModel(n.id, x.target.value)}>
            <option value="">{e.model.inherit}</option>{e.model.options.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select></label> : null}
          {e.effort ? <label>Effort<Select aria-label={`Effort for ${label}`} value={e.effort.value} onChange={(x) => edit!.onEffort(n.id, x.target.value)}>
            <option value="">{e.effort.inherit}</option>{e.effort.options.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select></label> : null}
          <Button size="sm" onClick={() => edit!.onRunner(n.id)}>Change runner</Button>
        </div>
      ) : edit ? <p className="sf-pl-note">Who runs it changes in Skills.</p> : null}
      {edit?.status?.text ? <p className="sf-pl-status" role="status" data-bad={edit.status.bad || undefined}>{edit.status.text}</p> : null}
      {result && runLabel ? (
        <section className="sf-pl-result" aria-label={`In ${runLabel}`}>
          <p className="sf-label">In {runLabel}</p>
          <p><span className="sf-pl-dot" data-status={result.status} aria-hidden="true" /> {STEP_STATUS[result.status]}{result.note ? ` · ${result.note}` : ''}</p>
          {result.review ? <p>{[`${result.review.findings} finding${result.review.findings === 1 ? '' : 's'}`, `${result.review.blocking} blocking`, `${result.review.dismissed} dismissed`].join(' · ')}</p> : null}
          {result.tokens || result.ms ? <p>{[result.tokens ? `${formatTokens(result.tokens)} tokens` : '', result.ms ? formatDuration(result.ms)?.join('') : ''].filter(Boolean).join(' · ')}</p> : null}
        </section>
      ) : null}
    </aside>
  );
});
