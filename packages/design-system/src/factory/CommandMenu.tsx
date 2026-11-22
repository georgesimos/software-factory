import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Dialog } from '../components/Dialog.tsx';
import { Kbd } from '../components/Kbd.tsx';
import { SearchIcon } from '../components/icons.tsx';

export interface Command {
  id: string;
  label: string;
  group?: string;
  /** Right-aligned mono hint, e.g. a repo or "Run". */
  hint?: string;
  shortcut?: string;
  /** Extra text to match on (ids, synonyms). */
  keywords?: string;
  onRun: () => void;
}
export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
  placeholder?: string;
  /** Bind ⌘K / Ctrl+K globally to toggle. Default true. */
  hotkey?: boolean;
}

export const filterCommands = (cs: Command[], q: string) => {
  const s = q.trim().toLowerCase();
  if (!s) return cs;
  const hay = (c: Command) => `${c.label} ${c.keywords ?? ''} ${c.group ?? ''}`.toLowerCase();
  const hits = cs.filter((c) => s.split(/\s+/).every((w) => hay(c).includes(w)));
  return [...hits.filter((c) => c.label.toLowerCase().startsWith(s)), ...hits.filter((c) => !c.label.toLowerCase().startsWith(s))];
};

/** ⌘K palette: a combobox over a listbox. Arrows move, Enter runs, Escape closes. */
export function CommandMenu({ open, onOpenChange, commands, placeholder = 'Search runs and commands…', hotkey = true }: CommandMenuProps) {
  useEffect(() => {
    if (!hotkey) return;
    const on = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); onOpenChange(!open); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [hotkey, open, onOpenChange]);
  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} title="Command menu" bare className="sf-cmdk">
      <Palette commands={commands} placeholder={placeholder} onDone={() => onOpenChange(false)} />
    </Dialog>
  );
}

function Palette({ commands, placeholder, onDone }: { commands: Command[]; placeholder: string; onDone: () => void }) {
  const id = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useMemo(() => filterCommands(commands, q), [commands, q]);
  const cur = list[Math.min(active, list.length - 1)];
  const run = (c: Command | undefined) => { if (!c) return; onDone(); c.onRun(); };
  const onKey = (e: KeyboardEvent) => {
    const n = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: list.length - 1 }[e.key];
    if (n !== undefined && list.length) { e.preventDefault(); setActive((n + list.length) % list.length); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(cur); }
  };
  useEffect(() => { document.getElementById(`${id}-${cur?.id}`)?.scrollIntoView({ block: 'nearest' }); }, [id, cur]);
  let group: string | undefined;
  return (
    <div className="sf-cmdk-in">
      <div className="sf-cmdk-search">
        <SearchIcon />
        <input autoFocus role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={cur ? `${id}-${cur.id}` : undefined} aria-label="Search commands"
          placeholder={placeholder} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} onKeyDown={onKey} />
        <Kbd>Esc</Kbd>
      </div>
      <ul id={`${id}-list`} role="listbox" aria-label="Commands" className="sf-cmdk-list">
        {list.map((c) => {
          const head = c.group && c.group !== group ? (group = c.group) : null;
          return [
            head ? <li key={`g-${head}`} role="presentation" className="sf-cmdk-group">{head}</li> : null,
            <li key={c.id} id={`${id}-${c.id}`} role="option" aria-selected={c === cur} className="sf-cmdk-item"
              onPointerMove={() => setActive(list.indexOf(c))} onClick={() => run(c)}>
              <span className="sf-cmdk-label">{c.label}</span>
              {c.hint ? <span className="sf-cmdk-hint">{c.hint}</span> : null}
              {c.shortcut ? <Kbd>{c.shortcut}</Kbd> : null}
            </li>,
          ];
        })}
      </ul>
      {!list.length ? <p className="sf-cmdk-empty" role="status">No results for “{q}”</p> : null}
    </div>
  );
}
