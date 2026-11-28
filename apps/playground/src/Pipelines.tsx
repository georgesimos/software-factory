import { Button, Dialog, PipelineGraph, PipelineList, nodeLabel, type CustomSlot, type Pipeline, type PipelineOff, type StepEditing, type StepRunner } from '@software-factory/design-system';
import { useState } from 'react';
import { EFFORTS, MODELS, PIPELINES, PLAN, RUNNERS, RUNNER_STEPS } from './fixtures/pipelines.ts';

/** acme/shop's sample pipelines, first match first and the default last, drawn by the same graph the dashboard uses. Edits stay in this page. */
export function Pipelines() {
  const [id, setId] = useState(PIPELINES[0]!.id), [plan, setPlan] = useState(PLAN), [set, setSet] = useState<Record<string, StepRunner>>({});
  const [picking, setPicking] = useState(''), [choice, setChoice] = useState(0), [offs, setOffs] = useState<Record<string, PipelineOff[]>>({});
  const [customs, setCustoms] = useState<Record<string, Pipeline['custom']>>({}), [adding, setAdding] = useState<{ slot: CustomSlot; index: number } | null>(null);
  const p = PIPELINES.find((x) => x.id === id)!, off = offs[id] ?? p.pipeline.off, custom = customs[id] ?? p.pipeline.custom;
  const addStep = (r: StepRunner) => { // as the dashboard does: an id from the runner's name, new in this pipeline, at the "+" it was asked at
    const { slot, index } = adding!, ids = Object.values(custom).flat().map((c) => c.id), base = (r.name ?? r.harness ?? r.path?.split('/').pop()?.replace(/\.md$/, '') ?? 'step').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let cid = base; for (let n = 2; ids.includes(cid); n++) cid = `${base}-${n}`;
    const xs = [...(custom[slot] ?? [])]; xs.splice(index, 0, { id: cid, slot, ...r });
    setCustoms({ ...customs, [id]: { ...custom, [slot]: xs } });
  };
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
    onRemove: (cid) => setCustoms({ ...customs, [id]: Object.fromEntries(Object.entries(custom).map(([k, xs]) => [k, xs.filter((c) => c.id !== cid)])) }),
    onOff: (step, turn, reason) => setOffs({ ...offs, [id]: turn ? [...off, { step, scope: 'acme/shop', reason, by: 'you' }] : off.filter((o) => o.step !== step) }),
    status: Object.keys(set).length || Object.keys(offs).length || Object.keys(customs).length ? { text: 'Changed in this page only.' } : undefined,
  };
  return (
    <div className="sf-pl-cols pg-pipelines">
      <PipelineList items={PIPELINES} current={id} onPick={setId} />
      <PipelineGraph name={`acme/shop · ${p.name}`} pipeline={{ ...p.pipeline, off, custom }} plan={plan} cap={p.cap} costCap={p.costCap} edit={edit} runs={p.runs}
        adds={{ slots: id === 'default' ? ['spec.after', 'build.after'] : ['build.after'], onAdd: (slot, index) => { setAdding({ slot, index }); setChoice(1); } }} />
      <Dialog open={!!adding} onClose={() => setAdding(null)} title={`A custom step after ${adding?.slot === 'spec.after' ? 'spec' : 'build'}`} description="Sample runners: the dashboard offers its whole catalog here."
        footer={<><Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button><Button variant="primary" onClick={() => { addStep(RUNNERS[choice]!.runner); setAdding(null); }}>Add step</Button></>}>
        <fieldset className="pg-pick"><legend className="sf-sr-only">Runner</legend>
          {RUNNERS.slice(1).map((x, i) => <label key={x.label}><input type="radio" name="pg-custom" checked={choice === i + 1} onChange={() => setChoice(i + 1)} /> {x.label}</label>)}
        </fieldset>
      </Dialog>
      <Dialog open={!!picking} onClose={() => setPicking('')} title={`Runner for ${nodeLabel(picking)}`} description="Sample runners: the dashboard offers its whole catalog here."
        footer={<><Button variant="ghost" onClick={() => setPicking('')}>Cancel</Button><Button variant="primary" onClick={() => { const { model, effort } = set[picking] ?? {}; change(picking, { ...RUNNERS[choice]!.runner, model, effort }); setPicking(''); }}>Save</Button></>}>
        <fieldset className="pg-pick"><legend className="sf-sr-only">Runner</legend>
          {RUNNERS.map((x, i) => <label key={x.label}><input type="radio" name="pg-runner" checked={choice === i} onChange={() => setChoice(i)} /> {x.label}</label>)}
        </fieldset>
      </Dialog>
    </div>
  );
}
