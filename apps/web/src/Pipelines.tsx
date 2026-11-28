import { Button, Dialog, EmptyState, Input, PipelineGraph, PipelineList, Select, repoOf, shq, type CustomSlot, type CustomStep, type StepEditing } from '@software-factory/design-system';
import { useEffect, useState, type ReactNode } from 'react';
import { CAP, COST_CAP, post, type FactoryData, type MatchSet, type NamedPipeline, type SkillsData } from './data.ts';
import { RuleLog } from './Rules.tsx';
import { Picker, copy, runnerPick, useSkillsSave, type Pick } from './Skills.tsx';
import { F_CMD, editStep, runnerFrom, runnerName, skillCommand, stepChoices } from './skillsModel.ts';

// The steps each issue goes through, per project, drawn from F's own `pipeline` (F skills) by the design system's graph.
// A step's panel changes who runs it through the Skills sheet's write path (POST /api/skills, or the copied F skills set
// command on a read-only page). Turning a review off (slice 3) is F's guarded steps.off rule: the page only requests it, the
// desktop app confirms it in its own dialog, and plain F ui or a read-only page gives the command for a terminal (§5).
// Named pipelines (slice 4, §7): the list is in match order with the default last; routing (match, pipelines) is guarded
// while two pipelines differ in what a run gets, so the page requests it the same way. A template only creates a draft.
interface Props { open: boolean; onClose: () => void; data: FactoryData; project?: string; onSaved?: (s: SkillsData) => void; refresh?: () => void }
const WAIT_MS = 2_000, WAIT_TRIES = 60; // re-read GET /api/state while the desktop dialog is open: its answer is written by F, not by this page
const DEFAULT = 'default';
// Drafts to start from: a name, a match and (Hotfix) a lower loop cap, which only tightens. Steps are turned off in the graph.
const TEMPLATES: { id: string; name: string; match: MatchSet[]; loops?: number; what: string }[] = [
  { id: 'hotfix', name: 'Hotfix', match: [{ labels: ['hotfix'] }], loops: 1, what: 'issues labelled hotfix, one loop' },
  { id: 'docs', name: 'Docs only', match: [{ files: ['docs/**', '**/*.md'] }], what: 'changes only to docs' },
  { id: 'ui', name: 'UI first', match: [{ files: ['src/components/**', '**/*.css'] }], what: 'changes only to components and styles' },
];
// A new custom step's id, from its runner's name: lowercase, and new among the ids the pipeline already has.
const newId = (r: { name?: string; path?: string }, taken: string[]) => {
  const base = ((r.name ?? (r.path ?? '').split(/[\\/]/).pop()?.replace(/\.md$/, '') ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 28)) || 'step';
  let id = base; for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
};
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const setText = (s: MatchSet) => [s.labels?.length && `label${s.labels.length > 1 ? 's' : ''} ${s.labels.join(', ')}`, s.files?.length && `files ${s.files.join(', ')}`, s.maxDiffLines && `≤ ${s.maxDiffLines} lines`].filter(Boolean).join(' · ');
const matchText = (m: MatchSet[] | null) => (m?.length ? m.map(setText).join(' or ') : 'no match: never matches');

export const pipelinesOf = (S?: SkillsData) => Object.entries(S?.plans ?? {}).filter(([, p]) => p.pipeline?.host).map(([scope]) => scope);

/** The match editor: each set's labels and globs as comma lists and an optional line limit. Saved whole, with a reason. */
function MatchEditor({ p, onSave }: { p: NamedPipeline; onSave: (m: MatchSet[], reason: string) => void }) {
  const from = (m: MatchSet[] | null) => (m?.length ? m : [{}]).map((s) => ({ labels: (s.labels ?? []).join(', '), files: (s.files ?? []).join(', '), max: s.maxDiffLines ? String(s.maxDiffLines) : '' }));
  const [sets, setSets] = useState(from(p.match)), [reason, setReason] = useState('');
  useEffect(() => { setSets(from(p.match)); setReason(''); }, [p.id, JSON.stringify(p.match)]); // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (i: number, k: 'labels' | 'files' | 'max', v: string) => setSets(sets.map((s, j) => (j === i ? { ...s, [k]: v } : s)));
  const value = sets.map((s) => ({ ...(list(s.labels).length && { labels: list(s.labels) }), ...(list(s.files).length && { files: list(s.files) }), ...(s.max.trim() && { maxDiffLines: Number(s.max) }) }));
  return (
    <form className="web-pl-match" aria-label={`Match for ${p.name}`} onSubmit={(e) => { e.preventDefault(); onSave(value, reason.trim()); }}>
      <p className="web-sk-note">A set holds when all its terms do (every changed file must match a glob); the pipeline matches when any set holds.</p>
      {sets.map((s, i) => (
        <fieldset key={i}>
          <legend>Set {i + 1}{sets.length > 1 ? <Button size="sm" variant="ghost" type="button" aria-label={`Remove set ${i + 1}`} onClick={() => setSets(sets.filter((_, j) => j !== i))}>Remove</Button> : null}</legend>
          <label>Labels <Input value={s.labels} placeholder="hotfix" onChange={(e) => edit(i, 'labels', e.target.value)} /></label>
          <label>Files <Input value={s.files} placeholder="docs/**, **/*.md" onChange={(e) => edit(i, 'files', e.target.value)} /></label>
          <label>At most <Input value={s.max} inputMode="numeric" placeholder="lines" onChange={(e) => edit(i, 'max', e.target.value)} /></label>
        </fieldset>
      ))}
      <div className="web-pl-row">
        {sets.length < 5 ? <Button size="sm" variant="ghost" type="button" onClick={() => setSets([...sets, { labels: '', files: '', max: '' }])}>Add a set</Button> : null}
        <Input aria-label="Reason for the match" value={reason} placeholder="Reason (required)" onChange={(e) => setReason(e.target.value)} />
        <Button size="sm" type="submit" disabled={!reason.trim()}>Save match</Button>
      </div>
    </form>
  );
}

export function PipelinesSheet({ open, onClose, data, project, onSaved = () => {}, refresh }: Props) {
  const scopes = pipelinesOf(data.skills);
  const [picked, setPicked] = useState(project && scopes.includes(project) ? project : scopes[0] ?? '');
  const repo = scopes.includes(picked) ? picked : scopes[0] ?? '', at = data.skills?.plans?.[repo];
  const named = at?.pipelines ?? [], [pid, setPid] = useState(DEFAULT);
  const cur = named.find((p) => p.id === pid) ?? null, scope = cur ? `${repo}@${cur.id}` : repo, pl = cur ?? at?.pipeline;
  const listed = named.filter((p) => p.listed).map((p) => p.id);
  const { status, setStatus, save } = useSkillsSave(data.token, data.fCmd ?? undefined, onSaved), [pick, setPick] = useState<Pick | null>(null);
  const S = data.skills!, plan = at?.plan ?? {}, [waiting, setWaiting] = useState(0), [tpl, setTpl] = useState(''), [tplWhy, setTplWhy] = useState('');
  const [why, setWhy] = useState(''), routeWhy = why.trim(); // a routing change's reason, typed: the dialog shows it as typed
  const [said, setSaid] = useState<{ text: ReactNode; bad?: boolean }>({ text: '' }); // the routing section's own status line; a step's is in its panel
  useEffect(() => { // a requested change: re-read until the dialog's answer shows (or a minute or two passes)
    if (!waiting || !refresh) return;
    let n = 0; const t = setInterval(() => { refresh(); if (++n >= WAIT_TRIES) clearInterval(t); }, WAIT_MS);
    return () => clearInterval(t);
  }, [waiting, refresh]);
  const runs = data.runs.filter((r) => repoOf(r.id) === repo);
  const items = [
    ...named.map((p) => ({ id: p.id, name: p.name, meta: p.listed ? `${listed.indexOf(p.id) + 1}. ${matchText(p.match)}` : 'draft: not listed, never matches', pipeline: p })),
    ...(at?.pipeline ? [{ id: DEFAULT, name: 'Default', meta: named.length ? 'every other issue' : `${runs.length} run${runs.length === 1 ? '' : 's'}`, pipeline: at.pipeline }] : []),
  ];
  const offs = pl?.off ?? [], f = data.fCmd ?? F_CMD;
  // One write path for every rule here: core decides whether it loosens; if it does, the page only requests it (§5).
  type Say = (x: { text: ReactNode; bad?: boolean }) => void;
  const rule = async (sc: string, key: string, value: unknown, reason: string, what: string, asks = what, say: Say = setStatus) => {
    const body = value === undefined ? { scope: sc, key, unset: true, ...(reason && { reason }) } : { scope: sc, key, value, reason };
    const cmd = value === undefined ? `${f} rules unset ${shq(sc)} ${shq(key)}${reason ? ` --reason ${shq(reason)}` : ''}` : `${f} rules set ${shq(sc)} ${shq(key)} ${shq(typeof value === 'string' ? value : JSON.stringify(value))} --reason ${shq(reason)}`;
    const terminal = async (lead: string) => { const ok = await copy(cmd); say({ text: <>{lead} {ok ? 'Command copied: run it in your own terminal:' : 'Run this in your own terminal:'} <code>{cmd}</code></> }); return false; };
    if (!data.token) return terminal(`${what} is saved by F, not this page.`);
    try {
      const x = await post<{ skills?: SkillsData; requested?: string }>('/onboard/rule', body, data.token);
      if (x.skills) onSaved(x.skills);
      say({ text: x.requested ? 'Confirm it in the app’s dialog: nothing changes until you do.' : 'Saved.' });
      if (x.requested && refresh) { refresh(); setWaiting((n) => n + 1); }
      return true;
    } catch (e) {
      const m = (e as Error).message;
      if (/needs your confirmation outside the page/.test(m)) return terminal(`${asks} needs your confirmation outside the page, and this is plain F ui.`);
      say({ text: m, bad: true });
      return false;
    }
  };
  const turn = (step: string, off: boolean, reason: string) => {
    const next = off ? [...offs.map((o) => o.step), step] : offs.map((o) => o.step).filter((s) => s !== step);
    const why = off ? reason : offs.find((o) => o.step === step)?.reason ?? ''; // a shorter list is still a set: it keeps the rule's reason
    return rule(scope, 'steps.off', next.length ? next : undefined, next.length ? why : '', 'Turning a review off or on', 'Turning a review off'); // nothing left off: unset, which only tightens
  };
  const order = async (next: string[]) => { if (await rule(repo, 'pipelines', next.length ? next : undefined, routeWhy, 'Routing', 'Routing', setSaid)) setWhy(''); }; // a reason is for one change
  const move = (id: string, by: number) => { const i = listed.indexOf(id), next = [...listed]; next.splice(i, 1); next.splice(i + by, 0, id); return order(next); };
  const create = async (id: string) => { // a draft: never matches until it is listed
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t || named.some((p) => p.id === t.id)) return setSaid({ text: `${repo}@${id} already exists: pick it in the list.`, bad: true });
    const sc = `${repo}@${t.id}`, reason = tplWhy.trim();
    if (!data.token) { // one command line for a terminal: name, then the cap (lowering it never asks), then the match
      const cmd = [`${f} skills set ${shq(sc)} name ${shq(JSON.stringify(t.name))}`, ...(t.loops ? [`${f} rules set ${shq(sc)} run.loops ${t.loops} --reason ${shq(reason)}`] : []),
        `${f} rules set ${shq(sc)} match ${shq(JSON.stringify(t.match))} --reason ${shq(reason)}`].join(' && ');
      const ok = await copy(cmd);
      return setSaid({ text: <>{ok ? 'Command copied: run it in your own terminal:' : 'Run this in your own terminal:'} <code>{cmd}</code></> });
    }
    try { onSaved(await post<SkillsData>('/skills', { scope: sc, step: 'name', runner: t.name }, data.token)); } // F skills set: a name is never a loosening
    catch (e) { return setSaid({ text: (e as Error).message, bad: true }); }
    setPid(t.id);
    if (t.loops && !(await rule(sc, 'run.loops', t.loops, reason, 'A cap', 'A cap', setSaid))) return;
    if (await rule(sc, 'match', t.match, reason, 'Routing', 'Routing', setSaid)) setTplWhy('');
  };
  // Only F's runner keys change here; an extra axis is a list saved whole (its runner and its files together), in Skills.
  const edit: StepEditing = {
    for: (step) => {
      if (!(S.steps ?? []).includes(step) || cur) return null; // a pipeline changes which steps run, never who runs one (§7.1)
      const r = plan[step] ?? { use: 'default' }, c = stepChoices(S, repo, step, r);
      return { from: runnerFrom(S, repo, step), ...(r.model && { model: c.model, effort: c.effort }) };
    },
    onModel: (step, v) => save(repo, step, editStep(S, repo, step, 'model', v)),
    onEffort: (step, v) => save(repo, step, editStep(S, repo, step, 'effort', v)),
    onRunner: (step) => setPick(runnerPick(S, repo, step, (st, r) => save(repo, st, r))),
    onOff: (step, off, reason) => void turn(step, off, reason),
    onOpen: () => setStatus({ text: '' }), // the last save was about another step
    status,
  };
  // Custom steps (slice 5): the scope's own steps.custom list, saved whole through POST /api/skills. Adding is free; removing
  // one is guarded, so the page only requests it (the desktop confirms), or gives the command for a terminal.
  const [added, setAdded] = useState<{ text: ReactNode; bad?: boolean }>({ text: '' });
  const own = ((S.config?.[scope] as Record<string, unknown> | undefined)?.['steps.custom'] ?? []) as CustomStep[];
  const writeSteps = async (next: CustomStep[], reason: string, say: Say) => {
    const runner = next.length ? next : null, cmd = `${skillCommand(scope, 'steps.custom', runner, f)}${reason ? ` --reason ${shq(reason)}` : ''}`;
    const terminal = async (lead: string) => { const ok = await copy(cmd); say({ text: <>{lead} {ok ? 'Command copied: run it in your own terminal:' : 'Run this in your own terminal:'} <code>{cmd}</code></> }); };
    if (!data.token) return terminal('Custom steps are saved by F, not this page.');
    try {
      const x = await post<SkillsData & { requested?: string }>('/skills', { scope, step: 'steps.custom', runner, ...(reason && { reason }) }, data.token);
      onSaved(x);
      say({ text: x.requested ? 'Confirm it in the app’s dialog: nothing changes until you do.' : 'Saved.' });
      if (x.requested && refresh) { refresh(); setWaiting((n) => n + 1); }
    } catch (e) {
      const m = (e as Error).message;
      if (/needs your confirmation outside the page/.test(m)) return terminal('Removing a custom step needs your confirmation outside the page, and this is plain F ui.');
      say({ text: m, bad: true });
    }
  };
  const addAt = (slot: CustomSlot, index: number) => setPick({ title: `a custom step after ${slot === 'spec.after' ? 'spec' : 'build'}`, step: 'steps.custom', current: null,
    done: ({ runner }) => {
      const shown = pl?.custom?.[slot] ?? [], taken = [at?.pipeline, ...named].flatMap((x) => [...Object.values(x?.custom ?? {}).flat().map((y) => y.id), ...(x?.axes ?? []).map((y) => y.axis)]); // one namespace: the project and all its pipelines (§7.1)
      const c = { id: newId(runner, [...taken, ...own.map((x) => x.id)]), slot, ...runner } as CustomStep;
      const before = own.findIndex((x) => x.id === shown[index]?.id), after = own.findIndex((x) => x.id === shown[index - 1]?.id); // place it among the scope's own steps
      const i = before >= 0 ? before : after >= 0 ? after + 1 : own.length;
      void writeSteps([...own.slice(0, i), c, ...own.slice(i)], '', setAdded);
    } });
  edit.onRemove = (id, reason) => {
    if (!own.some((x) => x.id === id)) return setStatus({ text: `${id} is set on ${cur ? repo : 'default'}, not here: remove it there.`, bad: true });
    void writeSteps(own.filter((x) => x.id !== id), reason, setStatus);
  };
  const pickRepo = (s: string) => { setPicked(s); setPid(DEFAULT); setStatus({ text: '' }); setSaid({ text: '' }); setAdded({ text: '' }); setWhy(''); };
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Pipelines" className="web-pl" description="The steps each issue goes through, and which issues go to which pipeline.">
      {!at?.pipeline || !pl ? <EmptyState title="No project attached">Attach a project with F sync to see its pipeline.</EmptyState> : (<>
        <div className="sf-pl-cols">
          <div className="web-pl-left">
            {scopes.length > 1 ? <Select aria-label="Project" value={repo} onChange={(e) => pickRepo(e.target.value)}>{scopes.map((s) => <option key={s} value={s}>{s}</option>)}</Select> : null}
            <PipelineList items={items} current={cur ? cur.id : DEFAULT} onPick={(id) => { setPid(id); setStatus({ text: '' }); setSaid({ text: '' }); setAdded({ text: '' }); setWhy(''); }} />
            <div className="web-pl-new">
              <Select aria-label="New pipeline from a template" value={tpl} onChange={(e) => setTpl(e.target.value)}>
                <option value="">New pipeline from…</option>
                {TEMPLATES.map((t) => <option key={t.id} value={t.id} disabled={named.some((p) => p.id === t.id)}>{t.name}: {t.what}</option>)}
              </Select>
              <Input aria-label="Reason for the new pipeline" value={tplWhy} placeholder="Reason (required)" onChange={(e) => setTplWhy(e.target.value)} />
              <Button size="sm" disabled={!tpl || !tplWhy.trim()} onClick={() => void create(tpl)}>Create draft</Button>
            </div>
          </div>
          <PipelineGraph name={cur ? `${cur.name} (${scope})` : repo} pipeline={pl} plan={{ ...plan, ...Object.fromEntries((at.extra ?? []).map((x) => [`review.${x.axis}`, x])) }}
            runnerName={(r) => runnerName(S, repo, r)} cap={pl.caps?.loops ?? data.cap ?? CAP} costCap={pl.caps?.budgetUsd ?? data.costCap ?? COST_CAP}
            edit={edit} adds={{ slots: cur ? ['build.after'] : ['spec.after', 'build.after'], onAdd: addAt, status: added }} runs={runs.filter((r) => (r.route?.pipeline ?? DEFAULT) === (cur ? cur.id : DEFAULT))} />
        </div>
        <section className="web-pl-route" aria-label="Routing">
          <h2 className="sf-label">Routing</h2>
          {cur ? (<>
            <p>
              {cur.listed ? <>Checked {listed.indexOf(cur.id) + 1} of {listed.length}, before the default.</> : <>A draft: it never matches until you list it.</>}
              {cur.matchBy ? <> Match set by {cur.matchBy}: {cur.matchReason}.</> : null}
            </p>
            <div className="web-pl-row">
              <Input aria-label="Reason for routing" value={why} placeholder="Reason (required)" onChange={(e) => setWhy(e.target.value)} />
              {cur.listed ? (<>
                <Button size="sm" variant="ghost" disabled={!routeWhy || listed.indexOf(cur.id) === 0} onClick={() => void move(cur.id, -1)}>Earlier</Button>
                <Button size="sm" variant="ghost" disabled={!routeWhy || listed.indexOf(cur.id) === listed.length - 1} onClick={() => void move(cur.id, 1)}>Later</Button>
                <Button size="sm" variant="ghost" disabled={!routeWhy} onClick={() => void order(listed.filter((x) => x !== cur.id))}>Unlist</Button>
              </>) : <Button size="sm" disabled={!cur.match || !routeWhy} onClick={() => void order([...listed, cur.id])}>List it, before the default</Button>}
            </div>
            <MatchEditor p={cur} onSave={(m, reason) => void rule(scope, 'match', m, reason, 'Routing', 'Routing', setSaid)} />
          </>) : <p>The default pipeline takes every issue no listed pipeline matches{listed.length ? `: after ${listed.join(', ')}` : ''}. It is always last.</p>}
          {said.text ? <p role="status" className="web-pl-said" data-bad={said.bad || undefined}>{said.text}</p> : null}
          <RuleLog data={data} project={repo} keep={(e) => e.run === scope || (e.run === repo && e.key === 'pipelines')} />
        </section>
      </>)}
      <Dialog open={!!pick} onClose={() => setPick(null)} title={pick ? 'Runner for ' + pick.title : ''} description={'For ' + repo} className="web-pk">
        {pick ? <Picker S={S} scope={repo} pick={pick} live={!!data.token} close={() => setPick(null)} /> : null}
      </Dialog>
    </Dialog>
  );
}
