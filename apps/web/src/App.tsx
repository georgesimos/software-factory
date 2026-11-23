import { Button, Dot, EmptyState, IconButton, Kbd, Sheet, Skeleton, Tabs, ThemeToggle, formatAgo, formatClock, repoOf } from '@software-factory/design-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Board, runHref } from './Board.tsx';
import { loadData, post, projectsOf, CAP, COST_CAP, type FactoryData } from './data.ts';
import { Panel } from './Panel.tsx';
import { RuleChips } from './Rules.tsx';
import { RunDetail, type StartState } from './RunDetail.tsx';
import { SetupWizard } from './Setup.tsx';
import { SkillsSheet } from './Skills.tsx';
import { store } from './store.ts';

const WIDE = '(min-width: 1100px)'; // the docked panel; narrower screens open a run in a sheet
const readHash = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };
function useMedia(q: string) {
  const m = typeof matchMedia === 'function' ? matchMedia(q) : null;
  const [on, setOn] = useState(() => !!m?.matches);
  useEffect(() => { if (!m) return; const f = () => setOn(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return on;
}

/** A poll's data, keeping the keys written since it started (they hold a newer reply). */
export const merged = (prev: FactoryData | undefined, data: FactoryData, keep: string[]): FactoryData =>
  prev && keep.length ? { ...data, ...Object.fromEntries(keep.map((k) => [k, prev[k as keyof FactoryData]])) } : data;

export function App({ load = loadData }: { load?: () => Promise<FactoryData> }) {
  const [state, setState] = useState<{ data?: FactoryData; error?: string }>({});
  const writes = useRef<string[][]>([]); // the keys each write's reply patched
  // A poll that started before a write keeps that write's keys and takes the rest, so steady editing never freezes the board.
  const settle = useCallback((w: number, data: FactoryData) => setState((s) => ({ data: merged(s.data, data, writes.current.slice(w).flat()) })), []);
  useEffect(() => {
    let ignore = false, waiting = false, timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => { timer = setTimeout(() => { if (document.hidden) waiting = true; else go(false); }, 10_000); }; // no polling in a hidden tab
    const onVis = () => { if (waiting && !document.hidden) { waiting = false; go(false); } };
    const go = (first: boolean) => { const w = writes.current.length; return load().then((data) => {
      if (ignore) return;
      settle(w, data);
      if (data.token) later(); // F ui: live; injected data is a snapshot
      else if (first && data.reload) { // F render's file: re-read it, but never under an open sheet or dialog
        const tick = () => { timer = setTimeout(() => (document.querySelector('dialog[open]') ? tick() : location.reload()), data.reload); };
        tick();
      }
    }, (e: unknown) => {
      if (ignore) return;
      if (first) setState({ error: String((e as Error)?.message ?? e ?? 'Unknown error') });
      else later(); // keep the last good data through a blip
    }); };
    go(true);
    document.addEventListener('visibilitychange', onVis);
    return () => { ignore = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [load, settle]);
  const { data, error } = state;
  const patch = useCallback((p: Partial<FactoryData>) => (writes.current.push(Object.keys(p)), setState((s) => (s.data ? { data: { ...s.data, ...p } } : s))), []); // a write's reply, until the next poll
  const refresh = useCallback(() => { const w = writes.current.length; load().then((d) => settle(w, d), () => {}); }, [load, settle]); // after a setup write
  return data ? <Shell data={data} patch={patch} refresh={refresh} /> : (
    <>
      <header className="web-top"><span className="web-brand"><span className="sf-mark" aria-hidden="true" />Software Factory</span><ThemeToggle /></header>
      <main className="web-main" aria-busy={!error}>
        {error ? <EmptyState title="Could not load runs">{error}</EmptyState> : <><span className="sf-sr-only">Loading runs…</span><Skeleton height={240} width="100%" /></>}
      </main>
    </>
  );
}

const session = (k: string, v?: string) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch { /* blocked storage */ } return null; };

function Shell({ data, patch, refresh }: { data: FactoryData; patch: (p: Partial<FactoryData>) => void; refresh: () => void }) {
  const projects = projectsOf(data);
  const [project, setProjectState] = useState(() => { const p = store('sf.project') ?? ''; return projects.includes(p) ? p : ''; });
  const setProject = (p: string) => { setProjectState(p); store('sf.project', p); if (readHash()) history.replaceState(null, '', location.pathname + location.search); setHash(''); };
  const [hash, setHash] = useState(readHash);
  const [collapsed, setCollapsedState] = useState(() => { // closed until a run is chosen; a link to a run opens it
    if (data.runs.some((r) => r.id === readHash())) { store('sf.panelCollapsed', '0'); return false; }
    return (store('sf.panelCollapsed') ?? '1') === '1';
  });
  const setCollapsed = (c: boolean) => { store('sf.panelCollapsed', c ? '1' : '0'); setCollapsedState(c); };
  const wide = useMedia(WIDE);
  const [skillsOpen, setSkillsOpen] = useState<string | false>(false); // the scope it opens on
  // Nothing yet (no project, run or idea): set up first, unless it was closed in this tab. Data without a projects list never opens it.
  const [setupOpen, setSetupOpen] = useState(() => Array.isArray(data.projects) && !projects.length && session('sf.onboardClosed') !== '1');
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(t); }, []); // "Updated 3m ago" stays true
  const byId = new Map(data.runs.map((r) => [r.id, r]));
  const sel = byId.get(hash) ?? null;
  const runs = data.runs.filter((r) => !project || repoOf(r.id) === project);
  const shown = wide && !collapsed && (!!sel || runs.length > 0);

  useEffect(() => {
    const f = () => { const h = readHash(); setHash(h); if (byId.has(h)) setCollapsed(false); }; // choosing a run always opens the panel
    addEventListener('hashchange', f); addEventListener('popstate', f);
    return () => { removeEventListener('hashchange', f); removeEventListener('popstate', f); };
  });
  const close = useCallback(() => { const id = readHash(); history.pushState(null, '', location.pathname + location.search); setHash(''); setTimeout(() => document.querySelector<HTMLElement>(`.web-board a[href="${CSS.escape(runHref(id))}"]`)?.focus(), 0); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return; // a sheet or dialog handles its own keys
      if (e.key === 'Escape' && sel) { e.preventDefault(); close(); }
      else if (e.key === ']' && wide && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) { e.preventDefault(); setCollapsed(shown); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  const inProg = runs.filter((r) => (r.outcome ?? 'in-progress') === 'in-progress').length;
  useEffect(() => { document.title = (inProg ? `(${inProg}) ` : '') + (sel ? (sel.title || sel.id) + ' · ' : '') + 'Software Factory'; }, [inProg, sel]);

  const fresh = Date.now() - Date.parse(data.generated ?? '') < 5 * 60e3;
  const token = data.token, [starts, setStarts] = useState<Record<string, StartState>>({}); // per run, so switching runs keeps a pending result
  const resume = async (id: string) => { // POST /api/sessions takes the repo and issue only
    const put = (s: StartState) => setStarts((x) => ({ ...x, [id]: s })), [repo, n] = id.split('#');
    put({ text: 'Resuming…', busy: true });
    try {
      const x = await post<{ session?: unknown }>('/sessions', { repo, issue: Number(n) }, token!);
      put({ text: `Resumed${typeof x.session === 'string' ? ` in session ${x.session.slice(0, 8)}` : ''}. It shows here as it runs.` });
      refresh();
    } catch (e) { put({ text: (e as Error).message, bad: true }); }
  };
  const detail = (r: NonNullable<typeof sel>) => <RunDetail run={r} cap={data.cap ?? CAP} costCap={data.costCap ?? COST_CAP} find={(id) => byId.get(id)} href={runHref}
    resume={token && (data.resumable?.includes(r.id) || starts[r.id]) ? { go: () => resume(r.id), state: starts[r.id] } : undefined} />;
  return (
    <>
      <header className="web-top">
        <span className="web-brand"><span className="sf-mark" aria-hidden="true" /><span className="web-brand-t">Software Factory</span></span>
        <RuleChips data={data} project={project} />
        {data.generated ? <span className="web-updated"><Dot tone={fresh ? 'ok' : 'idle'} /><time dateTime={data.generated} title={formatClock(data.generated)}><span className="web-upd-word">Updated </span>{formatAgo(data.generated)}</time></span> : null}
        {data.skills ? <Button size="sm" variant="ghost" aria-haspopup="dialog" title="Who runs each step" onClick={() => setSkillsOpen(project || 'default')}>Skills</Button> : null}
        <Button size="sm" variant="ghost" aria-haspopup="dialog" title="Set up the factory" onClick={() => setSetupOpen(true)}>Set up</Button>
        <ThemeToggle />
        {wide && (sel || runs.length) ? (
          <IconButton label={`${shown ? 'Hide' : 'Show'} run panel (])`} aria-expanded={shown} aria-controls="detail" onClick={() => setCollapsed(shown)}>
            <span className="web-pi" aria-hidden="true" />
          </IconButton>
        ) : null}
      </header>
      <div className="web-shell" data-panel={shown || undefined}>
        <main className="web-main" onClick={(e) => { // re-clicking the selected card fires no hashchange
          const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.web-board a');
          if (a && wide && collapsed && a.hash === location.hash && byId.has(readHash())) setCollapsed(false);
        }}>
          <Tabs label="Project" value={project} onChange={setProject} className="web-tabs"
            items={[{ id: '', label: 'All', count: data.runs.length }, ...projects.map((p) => ({ id: p, prefix: p.includes('/') ? p.split('/')[0] + '/' : undefined, label: p.split('/')[1] ?? p }))]}>
            <Board data={data} project={project} selected={sel?.id} />
          </Tabs>
        </main>
        {shown ? (
          <Panel run={sel} onClose={close}>
            {sel ? detail(sel) : (
              <div className="web-d-empty"><span className="sf-mark" aria-hidden="true" /><h2 id="d-title">Select a run</h2>
                <p>Pick a card on the board to see its pipeline, review and timeline. Press <Kbd>]</Kbd> to hide this panel.</p></div>
            )}
          </Panel>
        ) : null}
      </div>
      <SetupWizard open={setupOpen} onClose={() => { session('sf.onboardClosed', '1'); setSetupOpen(false); }} data={data} token={data.token}
        onSkills={(skills) => patch({ skills })} refresh={refresh} openSkills={(s) => setSkillsOpen(s)} />
      {data.skills ? <SkillsSheet open={!!skillsOpen} onClose={() => setSkillsOpen(false)} skills={data.skills} harnesses={data.harnesses} token={data.token} scope={skillsOpen || project} fCmd={data.fCmd} onSaved={(skills) => patch({ skills })} /> : null}
      {wide ? null : <Sheet open={!!sel} onClose={close} title={sel?.id ?? 'Run'}>{sel ? detail(sel) : null}</Sheet>}
    </>
  );
}
