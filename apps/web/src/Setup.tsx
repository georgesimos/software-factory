import { Badge, Button, Checkbox, Dialog, Dot, IngestProgress, Input, ProjectPicker, Select, shq, type DiscoveredRepo, type IngestItem } from '@software-factory/design-system';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { post, setByText, type FactoryData, type Rule, type SkillsData, type StepRunner } from './data.ts';
import { Picker, copy, type Pick } from './Skills.tsx';
import { F_CMD, kindOf, runnerName, skillCommand, stepLabel } from './skillsModel.ts';
import { store } from './store.ts';

// The setup wizard, ported from dashboard.html. Under `F ui` (a token) it reads POST /onboard (it runs local CLIs, so only on
// open and "Check again", never from the poll) and writes through /onboard/*; otherwise every step shows the command to run.
export const STEPS: [string, string][] = [['ai', 'Local AI'], ['repo', 'Repo'], ['ship', 'What you ship'], ['flow', 'Workflow'], ['rules', 'Rules'], ['start', 'Review and start']];
const SHIP: [string, string, string][] = [['web', 'Web', 'A site or web app with preview and production deploys.'], ['mobile', 'Mobile', 'An iOS or Android app: builds, TestFlight and the stores.'], ['desktop', 'Desktop', 'A desktop app: builds, signing and releases.']];
interface HarnessState { id: string; label: string; install?: string; installed?: boolean; version?: string | null; login?: { ok?: boolean; hint?: string } | null; notes?: { label?: string; hint?: string; ok?: boolean | null }[]; headless?: { cmd?: string; args?: string[]; note?: string } | null; app?: { installed?: boolean; path?: string; sessions?: boolean; opens?: boolean } | null }
type Policy = Record<string, Rule>;
/** POST /onboard (onboardState) and the onboardConfig every /onboard/* write returns. */
export interface Onboard {
  harnesses?: HarnessState[]; repos?: DiscoveredRepo[]; hooks?: FactoryData['hooks'];
  projects?: Record<string, { path?: string; autoMerge?: boolean }>; ship?: Record<string, { ship?: string[] }>;
  skills?: SkillsData; rules?: Record<string, { policy?: Policy }>; rulesError?: string;
}
type Saved = { step?: number; visited?: number[]; scope?: string; done?: boolean };
const saved = (): Saved => { try { return JSON.parse(store('sf.onboard') ?? '{}') ?? {}; } catch { return {}; } };
const keep = (p: Saved) => store('sf.onboard', JSON.stringify({ ...saved(), ...p }));
const where = (s: string) => (s === 'default' ? 'all projects' : s);

export function Cmd({ cmd }: { cmd: string }) {
  const [done, setDone] = useState(false);
  return <div className="web-ob-cmd"><code>{cmd}</code><Button size="sm" variant="ghost" aria-label="Copy command" onClick={async () => setDone(await copy(cmd))}>{done ? 'Copied' : 'Copy'}</Button></div>;
}

interface Props { open: boolean; onClose: () => void; data: FactoryData; token?: string; onSkills: (s: SkillsData) => void; refresh: () => void; openSkills: (scope: string) => void }

export function SetupWizard({ open, onClose, ...p }: Props) {
  const [ob, setOb] = useState<Onboard | null>(null), [error, setError] = useState('');
  const check = () => { if (!p.token) return; setError(''); setOb(null); post<Onboard>('/onboard', {}, p.token).then(setOb, (e: Error) => setError(e.message)); };
  useEffect(() => { if (open && p.token && !ob) check(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = useRef<() => boolean>(() => false); // Escape, the backdrop and Close warn about unsaved rules like the steps do
  return (
    <Dialog open={open} onClose={() => { if (!blocked.current()) onClose(); }} title="Set up the factory" className="web-ob"
      description={<>{p.token ? <><Dot tone="ok" /> Live: saves through F ui</> : <><Dot tone="idle" /> Read-only page: each step shows the command to run</>}
        {p.data.fMissing ? <span className="web-ob-note" role="note"> The commands below need the factory installed: in Claude Code, <code>/plugin install software-factory@software-factory</code> (after <code>/plugin marketplace add georgesimos/software-factory</code>), or <code>F install-skill</code> from a clone.</span> : null}</>}>
      <Wizard {...p} ob={ob} setOb={setOb} error={error} check={check} close={onClose} blocked={blocked} />
    </Dialog>
  );
}

function Wizard({ data, token, onSkills, refresh, openSkills, ob, setOb, error, check, close, blocked }: Omit<Props, 'open' | 'onClose'> & { ob: Onboard | null; setOb: (o: Onboard) => void; error: string; check: () => void; close: () => void; blocked: { current: () => boolean } }) {
  const [step, setStep] = useState(() => Math.max(0, Math.min(STEPS.length - 1, Number(saved().step) || 0)));
  const [status, setStatus] = useState<{ text: ReactNode; bad?: boolean }>({ text: '' });
  const [dirty, setDirty] = useState(false), [warned, setWarned] = useState(false);
  const live = !!token, F = data.fCmd || F_CMD;
  const projects = live ? Object.keys(ob?.projects ?? {}) : data.projects ?? [];
  const first = () => { const s = saved().scope ?? ''; return s === 'default' || projects.includes(s) ? s : projects[0] ?? 'default'; };
  const [picked, setScopeState] = useState<string | null>(null);
  const scope = picked ?? first(); // until one is picked: the saved one, once the live projects have arrived with POST /onboard
  const setScope = (s: string, quiet = false) => { keep({ scope: s }); setScopeState(s); if (!quiet) setStatus({ text: '' }); };
  const S = data.skills ?? {};
  const guard = () => { // every way out of the rules (a step, a scope, closing) warns once about unsaved edits
    if (!(dirty && live && !warned)) return false;
    setWarned(true); setStatus({ text: 'Unsaved rule changes: save them, or do that again to leave them.', bad: true });
    return true;
  };
  blocked.current = guard;
  const go = (i: number) => {
    if (guard()) return;
    const n = Math.max(0, Math.min(STEPS.length - 1, i));
    keep({ step: n, visited: [...new Set([...(saved().visited ?? []), step])] });
    setStep(n); setDirty(false); setWarned(false); setStatus({ text: '' });
  };
  const pickScope = (s: string) => { if (guard()) return; setDirty(false); setWarned(false); setScope(s); };
  useEffect(() => { // Alt+Arrow moves between steps, anywhere in the wizard but a field (word navigation) or the runner picker
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!e.altKey || !['ArrowRight', 'ArrowLeft'].includes(e.key) || !t.closest?.('dialog')?.classList.contains('web-ob') || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault(); go(step + (e.key === 'ArrowRight' ? 1 : -1));
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  useEffect(() => document.getElementById('ob-h')?.focus({ preventScroll: true }), [step]); // at commit, so it never steals focus from a field typed in next
  const write = async (route: string, body: object, said: string | ((x: { run?: string }) => string), errs?: string[]) => {
    try {
      const x = await post<Onboard & { run?: string; next?: string }>(route, body, token!);
      if (x.projects || x.skills) setOb({ ...ob, ...x });
      if (x.skills) onSkills(x.skills);
      refresh(); // projects, rules and runs come back with GET /api/state
      if (said) setStatus({ text: typeof said === 'string' ? said : said(x) });
      return x;
    } catch (e) { if (errs) errs.push((e as Error).message); else setStatus({ text: (e as Error).message, bad: true }); return null; }
  };
  const fail = (text: string) => setStatus({ text, bad: true });
  const visited = saved().visited ?? [];
  const scopePicker = (
    <div className="web-ob-scope" role="group" aria-label="Configure for">
      <span>Applies to</span>
      {['default', ...projects].map((s) => <Button key={s} size="sm" variant="ghost" aria-pressed={s === scope} onClick={() => pickScope(s)}>{s === 'default' ? 'All projects' : s}</Button>)}
    </div>
  );
  const clean = (d: boolean) => { setDirty(d); if (!d) setWarned(false); }; // after a save, later edits are guarded again
  const ctx: StepCtx = { data, ob, live, F, scope, scopePicker, write, fail, setStatus, setDirty: clean, setScope, onSkills, openSkills, token, S };
  const key = STEPS[step]![0];
  const body = live && !ob ? (error ? <><p className="web-sk-err">{error}</p><Button onClick={check}>Check again</Button></> : <p className="web-ob-lead">Checking this machine: harness CLIs, logins and local clones…</p>)
    : key === 'ai' ? <Ai {...ctx} check={check} /> : key === 'repo' ? <Repo {...ctx} /> : key === 'ship' ? <Ship key={scope} {...ctx} /> : key === 'flow' ? <Flow {...ctx} /> : key === 'rules' ? <Rules key={scope} {...ctx} /> : <Start {...ctx} />;
  const last = step === STEPS.length - 1;
  return (
    <div className="web-ob-wrap">
      <nav className="web-ob-rail" aria-label="Setup steps">
        <ol>{STEPS.map(([k, t], i) => {
          const done = i !== step && visited.includes(i);
          return <li key={k}><button type="button" aria-current={i === step ? 'step' : undefined} data-done={done || undefined} onClick={() => go(i)}>
            <span className="web-ob-n" aria-hidden="true">{done ? '✓' : i + 1}</span>{t}<span className="sf-sr-only">, step {i + 1} of {STEPS.length}</span></button></li>;
        })}</ol>
      </nav>
      <section className="web-ob-step" aria-labelledby="ob-h">
        <h3 id="ob-h" tabIndex={-1}>{STEPS[step]![1]}</h3>
        {body}
      </section>
      <footer className="web-ob-foot">
        <p className="web-sk-status" role="status" aria-live="polite" data-bad={status.bad || undefined}>{status.text}</p>
        <Button variant="ghost" disabled={step === 0} onClick={() => go(step - 1)}>Back</Button>
        <Button variant="primary" onClick={() => (!last ? go(step + 1) : guard() ? null : (keep({ done: true }), close()))}>{last ? 'Finish' : 'Next'}</Button>
      </footer>
    </div>
  );
}

interface StepCtx {
  data: FactoryData; ob: Onboard | null; live: boolean; F: string; scope: string; scopePicker: ReactNode; token?: string; S: SkillsData;
  write: (route: string, body: object, said: string | ((x: { run?: string }) => string), errs?: string[]) => Promise<(Onboard & { run?: string; next?: string }) | null>;
  fail: (t: string) => void; setStatus: (s: { text: ReactNode; bad?: boolean }) => void; setDirty: (d: boolean) => void; setScope: (s: string, quiet?: boolean) => void;
  onSkills: (s: SkillsData) => void; openSkills: (scope: string) => void;
}

function Ai({ data, ob, live, F, check }: StepCtx & { check: () => void }) {
  const lead = <p className="web-ob-lead">The AI apps on this machine. You work in their desktop apps; the factory runs steps in the background through each one's CLI, once it is installed and signed in.</p>;
  if (!live) return <>{lead}<div className="web-ob-grid">{(data.harnesses ?? []).map((h) => <div key={h.id} className="web-ob-card"><h4>{h.label}</h4><span>Background runs: install its CLI with</span><Cmd cmd={h.install ?? ''} /></div>)}</div>
    <h4>Check the desktop apps, install and login</h4><Cmd cmd={`${F} onboard`} /></>;
  const hs = ob?.harnesses ?? [];
  return (
    <>{lead}
      <div className="web-ob-grid">{hs.length ? hs.map((h) => {
        const ok = h.installed && h.login?.ok, app = h.app;
        return (
          <div key={h.id} className="web-ob-card" data-harness={h.id}>
            <h4><Dot tone={ok && (!app || app.installed) ? 'ok' : ok || app?.installed ? 'warn' : 'bad'} /> {h.label}</h4>
            {app ? <span data-app>{app.installed ? 'Desktop app installed' : 'Desktop app not found'}{app.path ? <span className="web-ob-path"> {app.path}</span> : null}</span> : null}
            {app?.sessions ? <span className="web-ob-note">The factory reads its sessions{app.opens ? ' and can open a run in the app' : ''}.</span> : null}
            <h5 className="web-ob-sub">Background runs {h.version ? <Badge quiet>{h.version}</Badge> : null}</h5>
            {h.installed ? <span>Installed</span> : <><span>Not installed</span><Cmd cmd={h.install ?? ''} /></>}
            {h.installed ? (h.login?.ok ? <span>Signed in{h.login.hint ? ` · ${h.login.hint}` : ''}</span> : <><span>Not signed in</span><Cmd cmd={h.login?.hint ?? ''} /></>) : null}
            {(h.notes ?? []).map((n, i) => <span key={i} className="web-ob-note"><Dot tone={n.ok ? 'ok' : n.ok === null ? 'idle' : 'warn'} /> {n.label}: {n.hint}</span>)}
            {h.headless ? <span className="web-ob-path" title={h.headless.note}>Headless: {[h.headless.cmd, ...(h.headless.args ?? [])].join(' ')}</span> : null}
          </div>
        );
      }) : <p>No harness adapters are registered.</p>}</div>
      <Button onClick={check}>Check again</Button>
    </>
  );
}

function Repo({ data, ob, live, F, write, setScope, fail }: StepCtx) {
  const [selected, setSelected] = useState<string[]>([]), [items, setItems] = useState<IngestItem[] | null>(null);
  const [repo, setRepo] = useState(''), [idea, setIdea] = useState(''), [next, setNext] = useState('');
  const hooks = live ? ob?.hooks : data.hooks, attached = ob?.projects ?? {};
  const ideaCard = (
    <div className="web-ob-card" aria-disabled={hooks?.create ? undefined : true}>
      <h4>Create from an idea {hooks?.create ? null : <Badge quiet>coming soon</Badge>}</h4>
      <span>Describe an app; the factory plans it in Claude Code, then creates the repo and its first issues, each behind a confirmation.</span>
      {hooks?.create && !live ? <Cmd cmd="/software-factory new: <idea>" /> : null}
      {hooks?.create && live ? <>
        <label className="web-ob-field">Repo <Input aria-label="New repo (owner/name)" value={repo} placeholder="owner/new-repo" onChange={(e) => setRepo(e.target.value)} /></label>
        <label className="web-ob-field">Idea<Input aria-label="Idea, one line" value={idea} placeholder="e.g. a personal budget app" maxLength={500} onChange={(e) => setIdea(e.target.value)} /></label>
        <div><Button onClick={async () => { const x = await write('/idea', { repo: repo.trim(), idea: idea.trim() }, (y) => `Idea recorded for ${y.run}. Continue it in Claude Code.`); if (x?.next) setNext(String(x.next)); }}>Record idea</Button></div>
        {next ? <Cmd cmd={next} /> : null}
      </> : null}
    </div>
  );
  const lead = <p className="web-ob-lead">Attach a local clone. The factory imports its open pull requests and the agent sessions already working on it.</p>;
  if (!live) {
    const ps = data.projects ?? [];
    return <>{lead}{ps.length ? <ul className="web-ob-list">{ps.map((p) => <li key={p}><Dot tone="ok" /> {p} <Badge tone="ok">attached</Badge></li>)}</ul> : null}
      <h4>Find clones</h4><Cmd cmd={`${F} discover`} /><h4>Attach one</h4><Cmd cmd={`${F} sync <owner/repo> <clone path>`} /><div className="web-ob-grid">{ideaCard}</div></>;
  }
  const repos = (ob?.repos ?? []).map((r) => ({ ...r, attached: !!attached[r.repo] }));
  const others = Object.keys(attached).filter((r) => !repos.some((x) => x.repo === r));
  const attach = async (list: string[]) => {
    setItems(list.map((r) => ({ repo: r, status: 'queued' })));
    const errs: string[] = [], failed: string[] = [];
    for (const r of list) {
      setItems((xs) => xs!.map((x) => (x.repo === r ? { ...x, status: 'syncing' } : x)));
      const x = await write('/onboard/sync', { repo: r, path: repos.find((y) => y.repo === r)?.path }, `Attached ${r}. Its open PRs and agent sessions are on the board.`, errs);
      setItems((xs) => xs!.map((y) => (y.repo === r ? { ...y, status: x ? 'done' : 'failed' } : y)));
      if (x) setScope(r, true); else failed.push(r); // later steps configure the project just attached
    }
    setSelected(failed); // failed ones stay picked, to retry
    if (failed.length) fail(`Not attached: ${failed.map((r, i) => `${r} (${errs[i]})`).join('; ')}`);
  };
  return (
    <>{lead}
      {others.length ? <ul className="web-ob-list">{others.map((r) => <li key={r}><Dot tone="ok" /> {r} <span className="web-ob-path">{attached[r]?.path}</span> <Badge tone="ok">attached</Badge></li>)}</ul> : null}
      {items ? <IngestProgress items={items} /> : null}
      {repos.length ? <ProjectPicker repos={repos} selected={selected} onChange={setSelected} onSubmit={attach} />
        : <div className="web-ob-card"><h4>No git clones found</h4><span>Point discover at the folder that holds your clones:</span><Cmd cmd={`${F} discover <folder>`} /></div>}
      <div className="web-ob-grid">{ideaCard}</div>
    </>
  );
}

function Ship({ data, ob, live, F, scope, scopePicker, write }: StepCtx) {
  const shipOf = (live ? ob?.ship : data.onboard) ?? {}, [cur, setCur] = useState<string[]>(shipOf[scope]?.ship ?? []); // keyed by scope
  const stored = useRef(cur); // the last list the server confirmed
  const hooks = (live ? ob?.hooks : data.hooks) ?? {}, conns = hooks.connectors as { kind?: string; label?: string }[] | { error?: string } | undefined;
  const toggle = async (k: string, on: boolean) => {
    const next = SHIP.map(([x]) => x).filter((x) => (x === k ? on : cur.includes(x)));
    setCur(next);
    if (!live) return;
    const x = await write('/onboard/ship', { scope, ship: next }, `Saved: ${next.join(', ') || 'nothing'} for ${where(scope)}.`);
    if (x) stored.current = x.ship?.[scope]?.ship ?? next;
    setCur(stored.current); // a refused write puts the boxes back as last stored
  };
  return (
    <>
      <p className="web-ob-lead">What this project ships. Only the choice is stored for now; deploy, build and store connectors read it once they are installed.</p>
      {scopePicker}
      <div className="web-ob-grid" role="group" aria-label="Targets">{SHIP.map(([k, t, d]) => {
        const mine = Array.isArray(conns) ? conns.filter((c) => String(c.kind).startsWith(k) || (k === 'mobile' && c.kind === 'store')) : null;
        return <div key={k} className="web-ob-card" data-ship={k}><Checkbox label={t} description={d} checked={cur.includes(k)} onChange={(e) => toggle(k, e.target.checked)} />
          <div className="web-chips">{mine ? (mine.length ? mine.map((c) => <Badge key={c.label}>{c.label}</Badge>) : <Badge quiet>no connector yet</Badge>) : <Badge quiet>{hooks.ship ? 'connectors: see F onboard' : 'connectors coming soon'}</Badge>}</div></div>;
      })}</div>
      {live ? null : <Cmd cmd={`${F} onboard ship ${shq(scope)} ${cur.join(',') || '""'}`} />}
      {conns && !Array.isArray(conns) && conns.error ? <p className="web-sk-err">Ship connectors failed to load: {conns.error}</p> : null}
    </>
  );
}

function Flow({ data, live, F, scope, scopePicker, token, S, setStatus, onSkills, openSkills }: StepCtx) {
  const [pick, setPick] = useState<Pick | null>(null);
  const plan = S.plans?.[scope]?.plan ?? {}, mine = (S.config?.[scope] ?? {}) as Record<string, StepRunner>;
  const names = (data.harnesses ?? []).map((h) => h.label).filter(Boolean).join(', ');
  const save = async (step: string, runner: StepRunner) => {
    try {
      if (!live) { const cmd = skillCommand(scope, step, runner, F), ok = await copy(cmd); return setStatus({ text: <>{ok ? 'Command copied:' : 'Run this in a terminal:'} <code>{cmd}</code></> }); }
      onSkills(await post<SkillsData>('/skills', { scope, step, runner }, token!));
      setStatus({ text: `Saved ${stepLabel(step)}.` });
    } catch (e) { setStatus({ text: (e as Error).message, bad: true }); }
  };
  if (S.error) return <p className="web-sk-err">skills.json is invalid: {S.error}</p>;
  return (
    <>
      <p className="web-ob-lead">Who runs each step: the factory’s built-in brief, a skill, an agent, or a harness tool{names ? ` (${names})` : ''}.</p>
      {scopePicker}
      <ul className="web-ob-list">{(S.steps ?? []).map((step) => {
        const r = plan[step] ?? {}, isDef = !r.use || r.use === 'default', label = stepLabel(step);
        return <li key={step} data-step={step}><span className="web-ob-sname">{label}</span><span className="web-sk-name" data-def={isDef || undefined}>{runnerName(S, scope, r)}</span>
          {isDef ? null : <Badge>{kindOf(S, scope, r)}</Badge>}{step in mine ? <span className="web-sk-from" data-here>set here</span> : null}
          <Button size="sm" aria-label={`Change runner for ${label}`} onClick={() => setPick({ title: label, step, current: r, done: (x) => save(step, x.runner) })}>Change</Button></li>;
      })}</ul>
      <Button variant="ghost" onClick={() => openSkills(scope)}>Open Skills: models and review axes</Button>
      <Dialog open={!!pick} onClose={() => setPick(null)} title={pick ? 'Runner for ' + pick.title : ''} description={scope === 'default' ? 'Global choice' : 'For ' + scope} className="web-pk">
        {pick ? <Picker S={S} scope={scope} pick={pick} live={live} close={() => setPick(null)} /> : null}
      </Dialog>
    </>
  );
}

// Rules only make the factory stricter, or swap GitHub CI for local checks. Keyed by scope, so typed input survives polls.
function Rules({ data, ob, live, F, scope, scopePicker, write, fail, setStatus, setDirty, S }: StepCtx) {
  const pol: Policy = (live ? ob?.rules?.[scope] : data.rules?.[scope])?.policy ?? {};
  const own = (k: string) => (pol[k]?.scope === scope ? pol[k] : undefined), proj = scope !== 'default';
  const am = proj && (live ? ob?.projects?.[scope]?.autoMerge : data.autoMerge?.[scope]) === true; // D1: off unless turned on
  const ciNow = String(pol.ci?.value ?? 'required'), checksNow = Array.isArray(pol['checks.commands']?.value) ? pol['checks.commands']!.value as string[] : [];
  const guideNow = String(((S.config?.[scope] as { guide?: Record<string, string> } | undefined)?.guide ?? {})['*'] ?? ''); // raw: resolved guidance folds "*" into every step
  const [f, setF] = useState({ ci: ciNow, checks: checksNow.join('\n'), merge: am, guide: guideNow, reason: '', until: '' });
  const [cmds, setCmds] = useState<string[]>([]);
  const set = (k: keyof typeof f, v: string | boolean) => { setF({ ...f, [k]: v }); if (k !== 'reason' && k !== 'until') setDirty(true); };
  const changes = () => {
    const out: { key: string; value?: string; unset?: boolean; guide?: boolean }[] = [], list = f.checks.split('\n').map((c) => c.trim()).filter(Boolean);
    if (f.ci !== ciNow) out.push({ key: 'ci', value: f.ci });
    if (JSON.stringify(list) !== JSON.stringify(checksNow)) { if (list.length) out.push({ key: 'checks.commands', value: JSON.stringify(list) }); else if (own('checks.commands')) out.push({ key: 'checks.commands', unset: true }); }
    if (f.guide.trim() !== guideNow.trim()) out.push(f.guide.trim() ? { key: 'guide.*', value: f.guide.trim(), guide: true } : { key: 'guide.*', unset: true, guide: true });
    return out;
  };
  const reason = f.reason.trim();
  const cmdOf = (c: ReturnType<typeof changes>[number]) => c.unset ? `${F} rules unset ${shq(scope)} ${shq(c.key)}${reason ? ` --reason ${shq(reason)}` : ''}`
    : `${F} rules set ${shq(scope)} ${shq(c.key)} ${shq(c.value!)}${c.guide ? '' : ` --reason ${shq(reason || '…')}`}${f.until && !c.guide ? ` --until ${f.until}` : ''}`;
  const save = async () => {
    const cs = changes(), amChanged = proj && f.merge !== am;
    if (!cs.length && !amChanged) return setStatus({ text: 'Nothing changed.' });
    if (cs.some((c) => !c.guide && !c.unset) && !reason) { fail('A reason is required: it is recorded with the rule.'); return document.getElementById('ob-reason')?.focus(); }
    if (!live) return setCmds([...cs.map(cmdOf), ...(amChanged ? [`${F} automerge ${shq(scope)} ${f.merge ? 'on' : 'off'}`] : [])]);
    for (const c of cs) if (!await write('/onboard/rule', { scope, key: c.key, value: c.value, unset: !!c.unset, reason: reason || undefined, until: c.guide ? undefined : f.until || undefined }, '')) return;
    if (amChanged && !await write('/onboard/automerge', { repo: scope, on: f.merge }, '')) return;
    setDirty(false);
    setStatus({ text: `Rules saved for ${where(scope)}.` });
  };
  return (
    <>
      <p className="web-ob-lead">Rules only make the factory stricter, or swap GitHub CI for checks it runs itself. Every change records who made it and why.</p>
      {scopePicker}
      <div className="web-ob-form">
        <label className="web-ob-field">GitHub CI before merging<Select aria-label="CI" value={f.ci} onChange={(e) => set('ci', e.target.value)}>{['required', 'advisory', 'skip'].map((v) => <option key={v}>{v}</option>)}</Select></label>
        <label className="web-ob-field">Local check commands (run by F checks, one per line; they stand in for CI when it is skipped)
          <textarea className="sf-input web-ob-ta" aria-label="Local check commands, one per line" placeholder={'pnpm test\npnpm lint'} value={f.checks} onChange={(e) => set('checks', e.target.value)} /></label>
        <Checkbox label={proj ? 'Allow auto-merge when every gate passes' : 'Auto-merge is set per project: pick one above'} checked={f.merge} disabled={!proj} onChange={(e) => set('merge', e.target.checked)}
          description={proj && 'Off (the default): a run whose gates pass escalates, and you merge its PR in GitHub. A git project always asks: F approve RUN --merge.'} />
        <label className="web-ob-field">Guidance for every step (optional)
          <textarea className="sf-input web-ob-ta" aria-label="Guidance for every step" placeholder="e.g. Prefer small PRs. Never touch the billing module." value={f.guide} onChange={(e) => set('guide', e.target.value)} /></label>
        <label className="web-ob-field">Reason (required for rule changes)<Input id="ob-reason" aria-label="Reason (required)" maxLength={200} placeholder="Why: e.g. GitHub Actions billing is failing" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></label>
        <label className="web-ob-field">Until (optional; the rule then expires)<Input type="date" aria-label="Until (optional)" value={f.until} onChange={(e) => set('until', e.target.value)} /></label>
        <div><Button variant="primary" onClick={save}>{live ? 'Save rules' : 'Show commands'}</Button></div>
        {cmds.map((c) => <Cmd key={c} cmd={c} />)}
      </div>
      {Object.keys(pol).length ? <><h4>Rules in force</h4><ul className="web-ob-list">{Object.entries(pol).map(([k, x]) =>
        <li key={k}><span className="web-sk-name">{k} = {JSON.stringify(x.value)}</span><span className="web-sk-from" data-here={x.scope === scope || undefined}>{x.scope === 'default' ? 'global' : x.scope} · {setByText(x)}: {x.reason}</span></li>)}</ul></> : null}
    </>
  );
}

// Under F ui with a project picked: start an issue headless through POST /api/runs (F start). Otherwise the prompt to paste.
function StartIssue({ repo, token }: { repo: string; token: string }) {
  const [n, setN] = useState(''), [st, setSt] = useState<{ text: string; bad?: boolean; busy?: boolean }>(), ok = /^[1-9]\d{0,9}$/.test(n.trim());
  const go = async () => {
    const id = `${repo}#${n.trim()}`; // before the await: the field may change meanwhile
    setSt({ text: '', busy: true });
    try {
      const x = await post<{ pid?: number; log?: string }>('/runs', { issue: id }, token);
      setSt({ text: `Started ${id} headless (pid ${x.pid ?? '?'}). It shows on the board once it records its first step.` });
    } catch (e) { setSt({ text: (e as Error).message, bad: true }); }
  };
  return (
    <form className="web-start web-ob-start" onSubmit={(e) => { e.preventDefault(); if (ok) void go(); }}>
      <label className="web-ob-field">Issue #<Input aria-label={`Issue number in ${repo}`} inputMode="numeric" value={n} placeholder="42" onChange={(e) => setN(e.target.value)} /></label>
      <Button type="submit" size="sm" variant="primary" disabled={!ok || st?.busy}>{st?.busy ? 'Starting…' : 'Start'}</Button>
      <p className="web-sk-status" role="status" data-bad={st?.bad || undefined}>{st?.busy ? '' : st?.text}</p>
    </form>
  );
}

function Start({ data, ob, live, F, scope, scopePicker, S, token }: StepCtx) {
  const R = (live ? ob?.rules?.[scope] : data.rules?.[scope]) ?? {}, repo = scope === 'default' ? '<owner/repo>' : scope;
  return (
    <>
      <p className="web-ob-lead">The resolved plan the factory will follow, exactly as the CLI prints it.</p>
      {scopePicker}
      <h4 className="web-ob-cli">F skills {scope}</h4><pre className="web-ob-pre" data-out="skills">{JSON.stringify(S.plans?.[scope] ?? {}, null, 2)}</pre>
      <h4 className="web-ob-cli">F rules {scope}</h4>{Object.keys(R).length ? <pre className="web-ob-pre" data-out="rules">{JSON.stringify(R, null, 2)}</pre> : <Cmd cmd={`${F} rules ${shq(scope)}`} />}
      <h4>First run</h4>
      {live && token && scope !== 'default' ? <><p>Start an issue here, headless in the attached clone:</p><StartIssue key={scope} repo={scope} token={token} /><p>Or in Claude Code:</p></>
        : <p>In Claude Code, factory an issue{live ? ' (pick a project above to start one here)' : ''}:</p>}
      <Cmd cmd={`/software-factory ${repo}#<issue>`} />
      <p>Or see which issues are ready:</p><Cmd cmd={`${F} queue ${repo}`} />
    </>
  );
}
