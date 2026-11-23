import { Badge, Button, Dialog, Dot, Input, Select, Table, Tabs } from '@software-factory/design-system';
import { useState, type ReactNode } from 'react';
import { post, type CatalogEntry, type Harness, type SkillsData, type StepRunner } from './data.ts';
import {
  SOURCES, editStep, entriesFor, keepModel, kindOf, modelSource, pickResult, presetCommand, runnerKey, runnerName, setHere, skillCommand, stepLabel,
} from './skillsModel.ts';

// Who runs each step. Under `F ui` (a token) changes save through /api; otherwise each change copies the CLI command.
const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } };
type Pick = { title: string; step: string; current: StepRunner | null; axis?: StepRunner; done: (p: { runner: StepRunner; axis?: string; when?: string[] }) => void };
interface Props { open: boolean; onClose: () => void; skills: SkillsData; harnesses?: Harness[]; token?: string; scope?: string; onSaved: (s: SkillsData) => void }

export function SkillsSheet({ open, onClose, harnesses = [], ...p }: Props) {
  const tools = harnesses.map((h) => h.label).filter(Boolean).join(', ') || 'none registered';
  return (
    <Dialog open={open} onClose={onClose} variant="sheet" title="Skills" className="web-sk"
      description={`Who runs each step: the factory’s built-in brief, a skill, an agent, a harness tool (${tools}), or your own brief.`}>
      <SkillsBody {...p} />
    </Dialog>
  );
}

function SkillsBody({ skills: S, token, scope: first = 'default', onSaved }: Omit<Props, 'open' | 'onClose' | 'harnesses'>) {
  const scopes = S.scopes ?? [];
  const [picked, setScope] = useState(first);
  const scope = picked === 'default' || scopes.includes(picked) ? picked : 'default';
  const [status, setStatus] = useState<{ text: ReactNode; bad?: boolean }>({ text: '' });
  const [pick, setPick] = useState<Pick | null>(null);
  const live = token
    ? <p className="web-sk-live"><Dot tone="ok" /> Live: changes save to ~/.claude/factory/skills.json</p>
    : <p className="web-sk-live"><Dot tone="idle" /> <span>Read-only page. Run <code>F ui</code> to edit here; until then, each change gives you the command to run.</span></p>;
  if (S.error) return <>{live}<p className="web-sk-err">skills.json is invalid: {S.error}. Fix the file, then reload.</p></>;

  const apply = async (route: string, body: object, cmd: string, said = (_: SkillsData) => 'Saved.') => {
    try {
      if (!token) {
        const ok = await copy(cmd);
        return setStatus({ text: <>{ok ? 'Command copied. Run it in a terminal, or open this page with F ui to save directly:' : 'Run this in a terminal:'} <code>{cmd}</code></> });
      }
      const x = await post<SkillsData>(route, body, token);
      onSaved(x);
      setStatus({ text: said(x) });
    } catch (e) { setStatus({ text: (e as Error).message, bad: true }); }
  };
  const save = (step: string, runner: StepRunner | StepRunner[] | null) => apply('/skills', { scope, step, runner }, skillCommand(scope, step, runner));
  const preset = (name: string) => apply('/skills/preset', { name, scope }, presetCommand(name, scope), (x) =>
    [`Applied ${name} to ${x.applied?.length ?? 0} steps.`, x.skipped?.length ? `${x.skipped.length} not run by Claude kept their runner.` : '',
      x.inherited?.length ? `${x.inherited.length} this project doesn’t set follow global.` : ''].filter(Boolean).join(' '));

  const cfg = S.config ?? {}, glob = (cfg.default ?? {}) as Record<string, StepRunner>, plan = S.plans?.[scope]?.plan ?? {};
  const row = (step: string) => {
    const here = setHere(S, scope, step), r = plan[step] ?? { use: 'default' }, isDef = !r.use || r.use === 'default';
    const label = stepLabel(step), axis = step.startsWith('review.') ? step.slice(7) : '';
    const change = () => setPick({ title: label, step, current: r, done: (x) => save(step, keepModel(here ? (cfg[scope] as Record<string, StepRunner>)[step] : undefined, x.runner)) });
    return (
      <tr key={step}>
        <th scope="row">{label} {(S.required ?? []).includes(axis) ? <Badge quiet>required</Badge> : null}</th>
        <td><div className="web-sk-run">
          <span className="web-sk-name" data-def={isDef || undefined}>{runnerName(S, scope, r)}</span>
          {isDef ? null : <Badge>{kindOf(S, scope, r)}</Badge>}
          <span className="web-sk-from" data-here={here || undefined}>{here ? (scope === 'default' ? 'set globally' : 'set for this project') : scope !== 'default' && step in glob ? 'from global' : 'built-in'}</span>
        </div></td>
        <td>{r.model ? <ModelCell S={S} scope={scope} step={step} r={r} label={label} save={save} /> : null}</td>
        <td className="web-sk-act">
          <Button size="sm" aria-label={`Change runner for ${label}`} onClick={change}>Change</Button>
          {here ? <Button size="sm" variant="ghost" aria-label={`${scope === 'default' ? 'Reset' : 'Use the global runner for'} ${label}`} onClick={() => save(step, null)}>{scope === 'default' ? 'Reset' : 'Use global'}</Button> : null}
        </td>
      </tr>
    );
  };
  const steps = S.steps ?? [];
  const groups: [string, string[]][] = [['Pipeline', steps.filter((k) => ['intake', 'spec', 'build'].includes(k))], ['Review axes', steps.filter((k) => k.startsWith('review.'))], ['After review', steps.filter((k) => ['verifier', 'postmerge'].includes(k))]];

  // Extra axes: a scope's list is saved whole. Under a project, global axes show read-only.
  const own = ((cfg[scope] ?? {})['axes.extra'] ?? []) as StepRunner[];
  const fromGlobal = scope === 'default' ? [] : ((glob['axes.extra'] ?? []) as unknown as StepRunner[]).filter((x) => !own.some((y) => y.axis === x.axis));
  const saveAxes = (list: StepRunner[]) => save('axes.extra', list.length ? list : null);
  const editAxis = (x: StepRunner | null) => {
    const { axis, when, ...runner } = x ?? {};
    setPick({ title: x ? 'Review · ' + axis : 'New review axis', step: 'axes.extra', current: x ? runner : null, axis: x ?? { axis: '', when: [] },
      done: (p) => saveAxes(x ? own.filter((y) => y.axis === axis || y.axis !== p.axis).map((y) => (y.axis === axis ? { axis: p.axis, when: p.when, ...p.runner } : y)) // a rename onto another axis replaces it
        : [...own.filter((y) => y.axis !== p.axis), { axis: p.axis, when: p.when, ...p.runner }]) });
  };
  const axisItem = (x: StepRunner, editable: boolean) => (
    <li key={(editable ? 'own:' : 'g:') + x.axis}>
      <Badge>{x.axis}</Badge><span className="web-sk-glob">{(x.when ?? []).join(', ')}</span><span className="web-sk-name">{runnerName(S, scope, x)}</span>
      {editable ? <span className="web-sk-act">
        <Button size="sm" variant="ghost" aria-label={`Edit the ${x.axis} axis`} onClick={() => editAxis(x)}>Edit</Button>
        <Button size="sm" variant="ghost" aria-label={`Remove the ${x.axis} axis`} onClick={() => saveAxes(own.filter((y) => y.axis !== x.axis))}>Remove</Button>
      </span> : <span className="web-sk-from">from global</span>}
    </li>
  );
  const presets = Object.keys(S.presets ?? {});

  return (
    <>
      {live}
      <Tabs label="Scope" value={scope} onChange={(s) => { setScope(s); setStatus({ text: '' }); }} items={[{ id: 'default', label: 'Global' }, ...scopes.map((s) => ({ id: s, label: s }))]}>
        <p className="web-sk-note">{scope === 'default' ? 'Applies to every project unless the project picks its own.' : `Overrides the global choice for ${scope}, step by step.`}</p>
        {presets.length ? (
          <div className="web-sk-presets" role="group" aria-label="Presets">
            <span>Presets</span>
            {presets.map((n) => <Button key={n} size="sm" onClick={() => preset(n)} title={scope === 'default' ? 'Sets model, effort and fallback on every Claude-run step' : 'Only on the steps this project sets; the rest follow global'}>Apply {n}{n === S.preset ? ' (built-in)' : ''}</Button>)}
          </div>
        ) : null}
        <Table className="web-sk-table">
          <caption className="sf-sr-only">Runner per step for {scope === 'default' ? 'all projects' : scope}</caption>
          {groups.map(([g, ks]) => (
            <tbody key={g}><tr className="web-sk-group"><th colSpan={4} scope="colgroup">{g}</th></tr>{ks.map(row)}</tbody>
          ))}
        </Table>
        <section className="web-sk-axes" aria-labelledby="sk-axes-t">
          <h3 id="sk-axes-t">Extra review axes</h3>
          <p className="web-sk-note">Reviewed next to the built-in axes whenever a changed file matches. They add to code and security, never replace them.</p>
          {own.length || fromGlobal.length ? <ul>{[...fromGlobal.map((x) => axisItem(x, false)), ...own.map((x) => axisItem(x, true))]}</ul> : null}
          <Button size="sm" variant="ghost" onClick={() => editAxis(null)}>+ Add axis</Button>
        </section>
      </Tabs>
      <p className="web-sk-status" role="status" aria-live="polite" data-bad={status.bad || undefined}>{status.text}</p>
      <Dialog open={!!pick} onClose={() => setPick(null)} title={pick ? 'Runner for ' + pick.title : ''} description={scope === 'default' ? 'Global choice' : 'For ' + scope} className="web-pk">
        {pick ? <Picker S={S} scope={scope} pick={pick} live={!!token} close={() => setPick(null)} /> : null}
      </Dialog>
    </>
  );
}

// Model, effort and fallback per Claude-run step (the resolved plan has a model). The empty choice inherits.
function ModelCell({ S, scope, step, r, label, save }: { S: SkillsData; scope: string; step: string; r: StepRunner; label: string; save: (step: string, x: StepRunner | null) => void }) {
  const m = modelSource(S, scope, step), mine = setHere(S, scope, step) ? (S.config?.[scope]?.[step] ?? {}) as StepRunner : {};
  const fb = (mine.fallback ?? []).join(','), chains = [...new Set([fb, ...(S.models ?? []).filter((x) => x !== r.model)])].filter(Boolean);
  const on = (field: 'model' | 'effort' | 'fallback') => (e: { target: { value: string } }) => save(step, editStep(S, scope, step, field, e.target.value));
  return (
    <div className="web-sk-model">
      <Select aria-label={`Model for ${label}`} value={m.set} onChange={on('model')}>
        <option value="">{m.inherit}</option>{[...new Set([...(S.models ?? []), m.set].filter(Boolean))].map((x) => <option key={x} value={x}>{x}</option>)}
      </Select>
      <Select aria-label={`Effort for ${label}`} value={mine.effort ?? ''} onChange={on('effort')}>
        <option value="">{mine.effort ? 'Inherit' : r.effort ?? 'Default'}</option>{(S.efforts ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
      </Select>
      <Select aria-label={`Fallback for ${label}`} value={fb} onChange={on('fallback')}>
        <option value="">{fb ? 'Model’s chain' : '→ ' + ((r.fallback ?? []).join(' → ') || 'none')}</option>{chains.map((x) => <option key={x} value={x}>→ {x.split(',').join(' → ')}</option>)}
      </Select>
      <span className="web-sk-from">{m.why}</span>
    </div>
  );
}

// Every catalog entry is offered for every step. Radios are keyed by source and runner, so a poll's new data keeps the choice.
function Picker({ S, scope, pick, live, close }: { S: SkillsData; scope: string; pick: Pick; live: boolean; close: () => void }) {
  const entries = entriesFor(S, scope), cur = pick.current, keyOf = (e: CatalogEntry) => e.source + '|' + runnerKey(e.runner);
  const known = cur ? entries.find((e) => runnerKey(e.runner) === runnerKey(cur)) : undefined;
  const [q, setQ] = useState(''), [filter, setFilter] = useState('all'), [msg, setMsg] = useState('');
  const [sel, setSel] = useState(known ? keyOf(known) : cur?.use === 'skill' ? 'custom-skill' : cur?.use === 'brief' ? 'custom-brief' : '');
  const [skill, setSkill] = useState(!known && cur?.use === 'skill' ? cur.name ?? '' : ''), [brief, setBrief] = useState(!known && cur?.use === 'brief' ? cur.path ?? '' : '');
  const [axisName, setAxisName] = useState(pick.axis?.axis ?? ''), [globs, setGlobs] = useState((pick.axis?.when ?? []).join(', '));
  const isReview = pick.step.startsWith('review.') || pick.step === 'axes.extra' || pick.step === 'verifier';
  const globalNames = new Set(entries.filter((e) => e.source === 'global').map((e) => e.runner.name));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = entries.filter((e) => (filter === 'all' || e.source === filter) && words.every((w) => [e.name, e.desc, e.group, e.kind].join(' ').toLowerCase().includes(w)));
  const byGroup = new Map<string, CatalogEntry[]>();
  for (const e of shown) { const g = (e.source === 'project' ? 'Project · ' : '') + e.group; byGroup.set(g, [...(byGroup.get(g) ?? []), e]); }
  const opt = (value: string, title: ReactNode, extra: ReactNode) => (
    <label key={value} className="web-pk-opt"><input type="radio" name="pk" value={value} checked={sel === value} onChange={() => setSel(value)} />
      <span className="web-pk-t">{title}</span>{extra}</label>
  );
  const done = () => {
    const e = entries.find((x) => keyOf(x) === sel);
    const runner = sel === 'custom-skill' ? (skill.trim() ? { use: 'skill', name: skill.trim() } : null)
      : sel === 'custom-brief' ? (brief.trim() ? { use: 'brief', path: brief.trim() } : null) : e?.runner ?? null;
    const r = pickResult({ runner, axis: pick.axis ? { name: axisName, globs } : undefined });
    if (typeof r === 'string') return setMsg(r);
    close();
    pick.done(r);
  };
  const counts = Object.fromEntries(SOURCES.map(([k]) => [k, k === 'all' ? entries.length : entries.filter((e) => e.source === k).length]));
  return (
    <>
      {pick.axis ? (
        <div className="web-pk-fields">
          <label>Axis name<Input className="web-sk-mono" value={axisName} placeholder="a11y" onChange={(e) => setAxisName(e.target.value)} /></label>
          <label>Review it when a changed file matches<Input className="web-sk-mono" value={globs} placeholder="**/*.tsx, **/*.jsx" onChange={(e) => setGlobs(e.target.value)} /></label>
        </div>
      ) : null}
      <Input type="search" aria-label="Search runners" placeholder={`Search ${entries.length} skills, agents and tools`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="web-pk-filters" role="group" aria-label="Source">
        {SOURCES.filter(([k]) => counts[k] || k === 'all').map(([k, label]) => <Button key={k} size="sm" variant="ghost" aria-pressed={k === filter} onClick={() => setFilter(k)}>{label} <span className="web-n">{counts[k]}</span></Button>)}
      </div>
      {isReview ? <p className="web-sk-note">A reviewer must reply with the review JSON. Prose tools go through the adapter brief; any other reply fails the axis.</p> : null}
      <fieldset className="web-pk-list">
        <legend className="sf-sr-only">Runner for {pick.title}</legend>
        {byGroup.size ? [...byGroup].map(([g, items]) => (
          <div key={g} role="group" aria-label={g}><h4>{g}</h4>{items.map((e) => opt(keyOf(e), <><span className="web-sk-name">{e.name}</span><Badge>{e.kind}</Badge></>, <>
            {e.desc ? <span className="web-pk-d">{e.desc}</span> : null}
            {e.source === 'project' && isReview ? <span className="web-pk-w">Comes from the repo: a PR that edits it touches .claude/, so it can never auto-merge.</span> : null}
            {e.source === 'project' && globalNames.has(e.runner.name) ? <span className="web-pk-w">A global skill has the same name; the config stores only the name.</span> : null}
          </>))}</div>
        )) : <p className="web-sk-note">Nothing matches. Try another word, or name a skill below.</p>}
        <div role="group" aria-label="Not listed"><h4>Not listed</h4>
          {opt('custom-skill', <><span className="web-sk-name">A skill by name</span><Badge>skill</Badge></>, <>
            <span className="web-pk-d">Any skill Claude Code can invoke, including ones this page can’t see.</span>
            <Input className="web-sk-mono" aria-label="Skill name" placeholder="skill or plugin:skill" value={skill} onChange={(e) => { setSkill(e.target.value); setSel('custom-skill'); }} />
          </>)}
          {opt('custom-brief', <><span className="web-sk-name">A markdown brief</span><Badge>brief</Badge></>, <>
            <span className="web-pk-d">An absolute or ~/ path to a .md file, outside any repo.</span>
            <Input className="web-sk-mono" aria-label="Brief file path" placeholder="~/.claude/factory/briefs/my-review.md" value={brief} onChange={(e) => { setBrief(e.target.value); setSel('custom-brief'); }} />
          </>)}
        </div>
      </fieldset>
      <div className="web-pk-foot">
        <p className="web-sk-status" role="status" aria-live="polite" data-bad={msg ? true : undefined}>{msg}</p>
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={done}>{live ? 'Save' : 'Copy command'}</Button>
      </div>
    </>
  );
}
