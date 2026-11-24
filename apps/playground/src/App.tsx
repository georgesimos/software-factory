import { Button, CommandMenu, Kbd, ThemeToggle, applyTheme, type Command, type Run, type ThemeChoice } from '@software-factory/design-system';
import { useMemo, useState, type ReactNode } from 'react';
import { Board } from './Board.tsx';
import { RUNS } from './fixtures/index.ts';
import { Basics, FactoryParts } from './Gallery.tsx';
import { Onboarding } from './Onboarding.tsx';
import { RunDetail } from './RunDetail.tsx';
import { Tokens } from './Tokens.tsx';

const SECTIONS = [['tokens', 'Tokens'], ['basics', 'Basics'], ['factory', 'Factory'], ['onboarding', 'Onboarding'], ['board', 'Board'], ['detail', 'Run detail']] as const;

const Sec = ({ id, title, lede, children }: { id: string; title: string; lede: string; children: ReactNode }) => (
  <section id={id} className="pg-section" aria-labelledby={`${id}-h`}>
    <h2 id={`${id}-h`} className="pg-h2">{title}</h2><p className="pg-lede">{lede}</p>{children}
  </section>
);

export function App() {
  const [themeKey, setThemeKey] = useState(0); // remount the toggle when ⌘K changes the theme
  const [menu, setMenu] = useState(false);
  const [selected, setSelected] = useState<Run | null>(null);
  const pick = (t: ThemeChoice) => { applyTheme(t); setThemeKey((k) => k + 1); };
  const commands = useMemo<Command[]>(() => [
    ...SECTIONS.map(([id, label]) => ({ id: `go-${id}`, label: `Go to ${label}`, group: 'Navigate', onRun: () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }) })),
    { id: 'theme-light', label: 'Use light theme', group: 'Theme', onRun: () => pick('light') },
    { id: 'theme-dark', label: 'Use dark theme', group: 'Theme', onRun: () => pick('dark') },
    { id: 'theme-system', label: 'Follow system theme', group: 'Theme', onRun: () => pick('system') },
    ...RUNS.map((r) => ({ id: `run-${r.id}`, label: r.title || r.id, hint: r.id, keywords: r.id, group: 'Runs', onRun: () => setSelected(r) })),
  ], []);
  const detail = RUNS.find((r) => r.id === 'acme/shop#43')!;

  return (
    <>
      <header className="pg-top">
        <span className="pg-brand"><span className="sf-mark" aria-hidden="true" /><span className="pg-brand-text">Design system</span></span>
        <nav className="pg-nav" aria-label="Sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>
        <div className="pg-top-end">
          <Button size="sm" variant="secondary" onClick={() => setMenu(true)} aria-keyshortcuts="Meta+K" className="pg-search">Search <Kbd>⌘K</Kbd></Button>
          <ThemeToggle key={themeKey} />
        </div>
      </header>
      <main className="pg-main">
        <Sec id="tokens" title="Tokens" lede="tokens.ts is the source; tokens.css is generated. Every colour pair passes WCAG AA in both themes (pnpm contrast)."><Tokens /></Sec>
        <Sec id="basics" title="Basics" lede="Plain CSS on tokens. Native elements where the platform already does the keyboard and screen-reader work."><Basics /></Sec>
        <Sec id="factory" title="Factory components" lede="Take factory.mjs run objects directly; presentational, no fetching."><FactoryParts /></Sec>
        <Sec id="onboarding" title="Onboarding" lede="Discover every local git clone, pick several, attach them in one go."><Onboarding /></Sec>
        <Sec id="board" title="Board" lede="The dashboard, rebuilt from components. Click a card for its detail sheet; ⌘K jumps to any run."><Board selected={selected} onSelect={setSelected} /></Sec>
        <Sec id="detail" title="Run detail" lede="acme/shop#43: two loop-backs, a dismissed finding, merged then reverted."><div className="pg-detail-frame"><RunDetail run={detail} /></div></Sec>
      </main>
      <CommandMenu open={menu} onOpenChange={setMenu} commands={commands} />
    </>
  );
}
