import { Button, Dialog, PipelineGraph, PipelineList, nodeLabel, type StepEditing, type StepRunner } from '@software-factory/design-system';
import { useState } from 'react';
import { EFFORTS, MODELS, PIPELINES, PLAN, RUNNERS, RUNNER_STEPS } from './fixtures/pipelines.ts';

/** acme/shop's sample pipelines, first match first and the default last, drawn by the same graph the dashboard uses. Edits stay in this page. */
export function Pipelines() {
  const [id, setId] = useState(PIPELINES[0]!.id), [plan, setPlan] = useState(PLAN), [set, setSet] = useState<Record<string, StepRunner>>({});
  const [picking, setPicking] = useState(''), [choice, setChoice] = useState(0);
  const p = PIPELINES.find((x) => x.id === id)!;
  const change = (step: string, x: StepRunner) => { // as the dashboard saves it: a harness tool carries no Claude model
    const own = Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as StepRunner, base = PLAN[step] ?? {};
    setSet({ ...set, [step]: own });
    setPlan({ ...plan, [step]: own.use === 'provider' ? own : { use: base.use, model: base.model, effort: base.effort, ...own } });
  };
  const edit: StepEditing = {
    for: (step) => {
      if (!RUNNER_STEPS.includes(step)) return null;
      const mine = set[step] ?? {}, base = PLAN[step] ?? {};
      return { from: set[step] ? 'set for this project' : 'built-in', ...(plan[step]?.model && {
        model: { value: mine.model ?? '', inherit: `Preset (${base.model})`, options: MODELS }, effort: { value: mine.effort ?? '', inherit: base.effort ?? 'Default', options: EFFORTS } }) };
    },
    onModel: (step, v) => change(step, { ...set[step], model: v || undefined }),
    onEffort: (step, v) => change(step, { ...set[step], effort: v || undefined }),
    onRunner: (step) => { setPicking(step); setChoice(0); },
    status: Object.keys(set).length ? { text: 'Changed in this page only.' } : undefined,
  };
  return (
    <div className="sf-pl-cols pg-pipelines">
      <PipelineList items={PIPELINES} current={id} onPick={setId} />
      <PipelineGraph name={`acme/shop · ${p.name}`} pipeline={p.pipeline} plan={plan} cap={p.cap} costCap={p.costCap} edit={edit} runs={p.runs} />
      <Dialog open={!!picking} onClose={() => setPicking('')} title={`Runner for ${nodeLabel(picking)}`} description="Sample runners: the dashboard offers its whole catalog here."
        footer={<><Button variant="ghost" onClick={() => setPicking('')}>Cancel</Button><Button variant="primary" onClick={() => { const { model, effort } = set[picking] ?? {}; change(picking, { ...RUNNERS[choice]!.runner, model, effort }); setPicking(''); }}>Save</Button></>}>
        <fieldset className="pg-pick"><legend className="sf-sr-only">Runner</legend>
          {RUNNERS.map((x, i) => <label key={x.label}><input type="radio" name="pg-runner" checked={choice === i} onChange={() => setChoice(i)} /> {x.label}</label>)}
        </fieldset>
      </Dialog>
    </div>
  );
}
