import { Button, Dot, EmptyState, IconButton, Kbd, Sheet, Skeleton, Tabs, ThemeToggle, formatAgo, formatClock, repoOf } from '@software-factory/design-system';
import { useCallback, useEffect, useState } from 'react';
import { Board, runHref } from './Board.tsx';
import { loadData, projectsOf, CAP, COST_CAP, type FactoryData } from './data.ts';
import { Panel } from './Panel.tsx';
import { RuleChips } from './Rules.tsx';
import { RunDetail } from './RunDetail.tsx';
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

export function App({ load = loadData }: { load?: () => Promise<FactoryData> }) {
  const [state, setState] = useState<{ data?: FactoryData; error?: string }>({});
  useEffect(() => {
    let ignore = false, timer: ReturnType<typeof setTimeout> | undefined;
    const go = (first: boolean) => load().then((data) => {
      if (ignore) return;
      setState({ data });
      if (data.token) timer = setTimeout(() => go(false), 10_000); // F ui: live; injected data is a snapshot
    }, (e: unknown) => {
      if (ignore) return;
      if (first) setState({ error: String((e as Error)?.message ?? e ?? 'Unknown error') });
      else timer = setTimeout(() => go(false), 10_000); // keep the last good data through a blip
    });
    go(true);
    return () => { ignore = true; clearTimeout(timer); };
  }, [load]);
  const { data, error } = state;
  const patch = useCallback((p: Partial<FactoryData>) => setState((s) => (s.data ? { data: { ...s.data, ...p } } : s)), []); // a write's reply, until the next poll
  return data ? <Shell data={data} patch={patch} /> : (
    <>
      <header className="web-top"><span className="web-brand"><span className="sf-mark" aria-hidden="true" />Software Factory</span><ThemeToggle /></header>
      <main className="web-main" aria-busy={!error}>
        {error ? <EmptyState title="Could not load runs">{error}</EmptyState> : <><span className="sf-sr-only">Loading runs…</span><Skeleton height={240} width="100%" /></>}
      </main>
    </>
  );
}

function Shell({ data, patch }: { data: FactoryData; patch: (p: Partial<FactoryData>) => void }) {
  const projects = projectsOf(data);
  const [project, setProjectState] = useState(() => { const p = store('sf.project') ?? ''; return projects.includes(p) ? p : ''; });
  const setProject = (p: string) => { setProjectState(p); store('sf.project', p); if (readHash()) history.replaceState(null, '', location.pathname + location.search); setHash(''); };
  const [hash, setHash] = useState(readHash);
  const [collapsed, setCollapsedState] = useState(() => (store('sf.panelCollapsed') ?? '1') === '1'); // closed until a run is chosen
  const setCollapsed = (c: boolean) => { store('sf.panelCollapsed', c ? '1' : '0'); setCollapsedState(c); };
  const wide = useMedia(WIDE);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const byId = new Map(data.runs.map((r) => [r.id, r]));
  const sel = byId.get(hash) ?? null;
  const runs = data.runs.filter((r) => !project || repoOf(r.id) === project);
  const shown = wide && !collapsed && (!!sel || runs.length > 0);

  useEffect(() => {
    const f = () => { const h = readHash(); setHash(h); if (byId.has(h)) setCollapsed(false); }; // choosing a run always opens the panel
    addEventListener('hashchange', f); addEventListener('popstate', f);
    return () => { removeEventListener('hashchange', f); removeEventListener('popstate', f); };
  });
  const close = useCallback(() => { const id = readHash(); history.pushState(null, '', location.pathname + location.search); setHash(''); setTimeout(() => document.querySelector<HTMLElement>(`a[href="${CSS.escape(runHref(id))}"]`)?.focus(), 0); }, []);
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
  const detail = (r: NonNullable<typeof sel>) => <RunDetail run={r} cap={data.cap ?? CAP} costCap={data.costCap ?? COST_CAP} find={(id) => byId.get(id)} href={runHref} />;
  return (
    <>
      <header className="web-top">
        <span className="web-brand"><span className="sf-mark" aria-hidden="true" /><span className="web-brand-t">Software Factory</span></span>
        <RuleChips data={data} project={project} />
        {data.generated ? <span className="web-updated"><Dot tone={fresh ? 'ok' : 'idle'} /><time dateTime={data.generated} title={formatClock(data.generated)}><span className="web-upd-word">Updated </span>{formatAgo(data.generated)}</time></span> : null}
        {data.skills ? <Button size="sm" variant="ghost" aria-haspopup="dialog" title="Who runs each step" onClick={() => setSkillsOpen(true)}>Skills</Button> : null}
        <ThemeToggle />
        {wide && (sel || runs.length) ? (
          <IconButton label={`${shown ? 'Hide' : 'Show'} run panel (])`} aria-expanded={shown} aria-controls="detail" onClick={() => setCollapsed(shown)}>
            <span className="web-pi" aria-hidden="true" />
          </IconButton>
        ) : null}
      </header>
      <div className="web-shell" data-panel={shown || undefined}>
        <main className="web-main">
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
      {data.skills ? <SkillsSheet open={skillsOpen} onClose={() => setSkillsOpen(false)} skills={data.skills} harnesses={data.harnesses} token={data.token} scope={project} onSaved={(skills) => patch({ skills })} /> : null}
      {wide ? null : <Sheet open={!!sel} onClose={close} title={sel?.id ?? 'Run'}>{sel ? detail(sel) : null}</Sheet>}
    </>
  );
}
