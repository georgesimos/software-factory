import { Dialog, EmptyState, PipelineGraph, PipelineList, repoOf, type StepEditing } from '@software-factory/design-system';
import { useState } from 'react';
import { CAP, COST_CAP, type FactoryData, type SkillsData } from './data.ts';
import { Picker, runnerPick, useSkillsSave, type Pick } from './Skills.tsx';
import { editStep, runnerFrom, runnerName, stepChoices } from './skillsModel.ts';

// The steps each issue goes through, per project, drawn from F's own `pipeline` (F skills) by the design system's graph.
// A step's panel changes who runs it through the Skills sheet's write path (POST /api/skills, or the copied F skills set
// command on a read-only page); nothing else here writes (docs/plans/pipelines.md, slice 2).
interface Props { open: boolean; onClose: () => void; data: FactoryData; project?: string; onSaved?: (s: SkillsData) => void }

export const pipelinesOf = (S?: SkillsData) => Object.entries(S?.plans ?? {}).filter(([, p]) => p.pipeline?.host).map(([scope]) => scope);

export function PipelinesSheet({ open, onClose, data, project, onSaved = () => {} }: Props) {
  const scopes = pipelinesOf(data.skills);
  const [picked, setPicked] = useState(project && scopes.includes(project) ? project : scopes[0] ?? '');
  const scope = scopes.includes(picked) ? picked : scopes[0] ?? '', at = data.skills?.plans?.[scope];
  const { status, setStatus, save } = useSkillsSave(data.token, data.fCmd ?? undefined, onSaved), [pick, setPick] = useState<Pick | null>(null);
  const items = scopes.map((s) => { const n = data.runs.filter((r) => repoOf(r.id) === s).length; return { id: s, name: s, meta: `${n} run${n === 1 ? '' : 's'}`, pipeline: data.skills!.plans![s]!.pipeline! }; });
  const S = data.skills!, plan = at?.plan ?? {};
  // Only F's runner keys change here; an extra axis is a list saved whole (its runner and its files together), in Skills.
  const edit: StepEditing = {
    for: (step) => {
      if (!(S.steps ?? []).includes(step)) return null;
      const r = plan[step] ?? { use: 'default' }, c = stepChoices(S, scope, step, r);
      return { from: runnerFrom(S, scope, step), ...(r.model && { model: c.model, effort: c.effort }) };
    },
    onModel: (step, v) => save(scope, step, editStep(S, scope, step, 'model', v)),
    onEffort: (step, v) => save(scope, step, editStep(S, scope, step, 'effort', v)),
    onRunner: (step) => setPick(runnerPick(S, scope, step, (st, r) => save(scope, st, r))),
    status,
  };
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Pipelines" className="web-pl" description="The steps each issue goes through.">
      {!at?.pipeline ? <EmptyState title="No project attached">Attach a project with F sync to see its pipeline.</EmptyState> : (
        <div className="sf-pl-cols">
          <PipelineList items={items} current={scope} onPick={(s) => { setPicked(s); setStatus({ text: '' }); }} />
          <PipelineGraph name={scope} pipeline={at.pipeline} plan={{ ...plan, ...Object.fromEntries((at.extra ?? []).map((x) => [`review.${x.axis}`, x])) }}
            runnerName={(r) => runnerName(S, scope, r)} cap={data.cap ?? CAP} costCap={data.costCap ?? COST_CAP}
            edit={edit} runs={data.runs.filter((r) => repoOf(r.id) === scope)} />
        </div>
      )}
      <Dialog open={!!pick} onClose={() => setPick(null)} title={pick ? 'Runner for ' + pick.title : ''} description={'For ' + scope} className="web-pk">
        {pick ? <Picker S={S} scope={scope} pick={pick} live={!!data.token} close={() => setPick(null)} /> : null}
      </Dialog>
    </Dialog>
  );
}
