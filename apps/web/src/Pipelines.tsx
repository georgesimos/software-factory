import { Dialog, EmptyState, PipelineGraph, PipelineList, repoOf, shq, type StepEditing } from '@software-factory/design-system';
import { useEffect, useState } from 'react';
import { CAP, COST_CAP, post, type FactoryData, type SkillsData } from './data.ts';
import { Picker, copy, runnerPick, useSkillsSave, type Pick } from './Skills.tsx';
import { F_CMD, editStep, runnerFrom, runnerName, stepChoices } from './skillsModel.ts';

// The steps each issue goes through, per project, drawn from F's own `pipeline` (F skills) by the design system's graph.
// A step's panel changes who runs it through the Skills sheet's write path (POST /api/skills, or the copied F skills set
// command on a read-only page). Turning a review off (slice 3) is F's guarded steps.off rule: the page only requests it, the
// desktop app confirms it in its own dialog, and plain F ui or a read-only page gives the command for a terminal (§5).
interface Props { open: boolean; onClose: () => void; data: FactoryData; project?: string; onSaved?: (s: SkillsData) => void; refresh?: () => void }
const WAIT_MS = 2_000, WAIT_TRIES = 60; // re-read GET /api/state while the desktop dialog is open: its answer is written by F, not by this page

export const pipelinesOf = (S?: SkillsData) => Object.entries(S?.plans ?? {}).filter(([, p]) => p.pipeline?.host).map(([scope]) => scope);

export function PipelinesSheet({ open, onClose, data, project, onSaved = () => {}, refresh }: Props) {
  const scopes = pipelinesOf(data.skills);
  const [picked, setPicked] = useState(project && scopes.includes(project) ? project : scopes[0] ?? '');
  const scope = scopes.includes(picked) ? picked : scopes[0] ?? '', at = data.skills?.plans?.[scope];
  const { status, setStatus, save } = useSkillsSave(data.token, data.fCmd ?? undefined, onSaved), [pick, setPick] = useState<Pick | null>(null);
  const items = scopes.map((s) => { const n = data.runs.filter((r) => repoOf(r.id) === s).length; return { id: s, name: s, meta: `${n} run${n === 1 ? '' : 's'}`, pipeline: data.skills!.plans![s]!.pipeline! }; });
  const S = data.skills!, plan = at?.plan ?? {}, [waiting, setWaiting] = useState(0);
  useEffect(() => { // a requested change: re-read until the dialog's answer shows (or a minute or two passes)
    if (!waiting || !refresh) return;
    let n = 0; const t = setInterval(() => { refresh(); if (++n >= WAIT_TRIES) clearInterval(t); }, WAIT_MS);
    return () => clearInterval(t);
  }, [waiting, refresh]);
  const offs = at?.pipeline?.off ?? [], f = data.fCmd ?? F_CMD;
  const turn = async (step: string, off: boolean, reason: string) => {
    const next = off ? [...offs.map((o) => o.step), step] : offs.map((o) => o.step).filter((s) => s !== step);
    const why = off ? reason : offs.find((o) => o.step === step)?.reason ?? ''; // a shorter list is still a set: it keeps the rule's reason
    const body = next.length ? { scope, key: 'steps.off', value: next, reason: why } : { scope, key: 'steps.off', unset: true }; // nothing left off: unset, which only tightens
    const cmd = next.length ? `${f} rules set ${shq(scope)} ${shq('steps.off')} ${shq(JSON.stringify(next))} --reason ${shq(why)}` : `${f} rules unset ${shq(scope)} ${shq('steps.off')}`;
    const terminal = async (lead: string) => { const ok = await copy(cmd); setStatus({ text: <>{lead} {ok ? 'Command copied: run it in your own terminal:' : 'Run this in your own terminal:'} <code>{cmd}</code></> }); };
    if (!data.token) return terminal('Turning a review off or on is saved by F, not this page.');
    try {
      const x = await post<{ skills?: SkillsData; requested?: string }>('/onboard/rule', body, data.token);
      if (x.skills) onSaved(x.skills);
      setStatus({ text: x.requested ? 'Confirm it in the app’s dialog: nothing changes until you do.' : 'Saved.' });
      if (x.requested && refresh) { refresh(); setWaiting((n) => n + 1); }
    } catch (e) {
      const m = (e as Error).message;
      if (/needs your confirmation outside the page/.test(m)) return terminal('Turning a review off needs your confirmation outside the page, and this is plain F ui.');
      setStatus({ text: m, bad: true });
    }
  };
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
    onOff: (step, off, reason) => void turn(step, off, reason),
    onOpen: () => setStatus({ text: '' }), // the last save was about another step
    status,
  };
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Pipelines" className="web-pl" description="The steps each issue goes through.">
      {!at?.pipeline ? <EmptyState title="No project attached">Attach a project with F sync to see its pipeline.</EmptyState> : (
        <div className="sf-pl-cols">
          <PipelineList items={items} current={scope} onPick={(s) => { setPicked(s); setStatus({ text: '' }); }} />
          <PipelineGraph name={scope} pipeline={at.pipeline} plan={{ ...plan, ...Object.fromEntries((at.extra ?? []).map((x) => [`review.${x.axis}`, x])) }}
            runnerName={(r) => runnerName(S, scope, r)} cap={at.pipeline.caps?.loops ?? data.cap ?? CAP} costCap={at.pipeline.caps?.budgetUsd ?? data.costCap ?? COST_CAP}
            edit={edit} runs={data.runs.filter((r) => repoOf(r.id) === scope)} />
        </div>
      )}
      <Dialog open={!!pick} onClose={() => setPick(null)} title={pick ? 'Runner for ' + pick.title : ''} description={'For ' + scope} className="web-pk">
        {pick ? <Picker S={S} scope={scope} pick={pick} live={!!data.token} close={() => setPick(null)} /> : null}
      </Dialog>
    </Dialog>
  );
}
