import { Dialog, EmptyState, PipelineGraph, PipelineList, repoOf } from '@software-factory/design-system';
import { useState } from 'react';
import { CAP, COST_CAP, type FactoryData, type SkillsData } from './data.ts';
import { runnerName } from './skillsModel.ts';

// The steps each issue goes through, per project, drawn from F's own `pipeline` (F skills) by the design system's graph.
// Read-only for now (docs/plans/pipelines.md, slice 1): who runs a step changes in Skills, and nothing here writes.
interface Props { open: boolean; onClose: () => void; data: FactoryData; project?: string }

export const pipelinesOf = (S?: SkillsData) => Object.entries(S?.plans ?? {}).filter(([, p]) => p.pipeline?.host).map(([scope]) => scope);

export function PipelinesSheet({ open, onClose, data, project }: Props) {
  const scopes = pipelinesOf(data.skills);
  const [picked, setPicked] = useState(project && scopes.includes(project) ? project : scopes[0] ?? '');
  const scope = scopes.includes(picked) ? picked : scopes[0] ?? '', at = data.skills?.plans?.[scope];
  const items = scopes.map((s) => { const n = data.runs.filter((r) => repoOf(r.id) === s).length; return { id: s, name: s, meta: `${n} run${n === 1 ? '' : 's'}`, pipeline: data.skills!.plans![s]!.pipeline! }; });
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Pipelines" className="web-pl" description="The steps each issue goes through.">
      {!at?.pipeline ? <EmptyState title="No project attached">Attach a project with F sync to see its pipeline.</EmptyState> : (
        <div className="sf-pl-cols">
          <PipelineList items={items} current={scope} onPick={setPicked} />
          <PipelineGraph name={scope} pipeline={at.pipeline} plan={{ ...at.plan, ...Object.fromEntries((at.extra ?? []).map((x) => [`review.${x.axis}`, x])) }}
            runnerName={(r) => runnerName(data.skills!, scope, r)} cap={data.cap ?? CAP} costCap={data.costCap ?? COST_CAP} />
        </div>
      )}
    </Dialog>
  );
}
