import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Badge } from '../components/Badge.tsx';
import { Button } from '../components/Button.tsx';
import { Checkbox } from '../components/Checkbox.tsx';
import { Input } from '../components/Input.tsx';
import { Skeleton } from '../components/Skeleton.tsx';
import { EmptyState } from '../components/EmptyState.tsx';
import { SearchIcon } from '../components/icons.tsx';
import { formatAgo, type DiscoveredRepo } from '../factory/model.ts';

export interface ProjectPickerProps {
  /** `factory.mjs discover` output; null while discovery runs. */
  repos: DiscoveredRepo[] | null;
  /** Selected repo names ("owner/name"). Attached repos are never selectable. */
  selected: string[];
  onChange: (selected: string[]) => void;
  onSubmit: (selected: string[]) => void;
  /** Where discovery looked, shown in the header, e.g. "~/Development". */
  scannedRoots?: string[];
  now?: number;
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, '~');

/** Step 1 of onboarding: every local git clone, multi-select, one "Attach" action. ⌘↵ submits. */
export function ProjectPicker({ repos, selected, onChange, onSubmit, scannedRoots, now }: ProjectPickerProps) {
  const titleId = useId();
  const [q, setQ] = useState('');
  const shown = useMemo(() => (repos ?? []).filter((r) => `${r.repo} ${r.path}`.toLowerCase().includes(q.trim().toLowerCase())), [repos, q]);
  const pickable = shown.filter((r) => !r.attached).map((r) => r.repo);
  const on = new Set(selected);
  const allOn = pickable.length > 0 && pickable.every((r) => on.has(r));
  const someOn = pickable.some((r) => on.has(r));
  const toggle = (repo: string) => onChange(on.has(repo) ? selected.filter((r) => r !== repo) : [...selected, repo]);
  const toggleAll = () => onChange(allOn ? selected.filter((r) => !pickable.includes(r)) : [...new Set([...selected, ...pickable])]);
  const submit = () => { if (selected.length) onSubmit(selected); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } };
  const attachedCount = (repos ?? []).filter((r) => r.attached).length;

  return (
    <section className="sf-picker" aria-labelledby={titleId} aria-busy={repos === null || undefined} onKeyDown={onKey}>
      <header className="sf-picker-head">
        <div>
          <h2 id={titleId} className="sf-picker-title">Choose projects to attach</h2>
          <p className="sf-picker-sub">
            {repos === null ? 'Looking for git clones…'
              : `${repos.length} repositories found${scannedRoots?.length ? ` in ${scannedRoots.map(home).join(', ')}` : ''}${attachedCount ? ` · ${attachedCount} already attached` : ''}`}
          </p>
        </div>
        <Input icon={<SearchIcon />} placeholder="Filter" aria-label="Filter repositories" value={q} onChange={(e) => setQ(e.target.value)} className="sf-picker-filter" />
      </header>

      {repos === null ? (
        <ul className="sf-picker-list" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => <li key={i} className="sf-picker-row"><Skeleton width={16} height={16} /><div className="sf-picker-main"><Skeleton width="40%" /><Skeleton width="65%" height={10} style={{ marginTop: 8 }} /></div></li>)}
        </ul>
      ) : !repos.length ? (
        <EmptyState title="No git clones found" compact>Clone a repository under one of the scanned folders, or attach one by path.</EmptyState>
      ) : (
        <>
          <div className="sf-picker-all">
            <Checkbox label={allOn ? 'Deselect all' : 'Select all'} checked={allOn} indeterminate={someOn && !allOn} onChange={toggleAll} disabled={!pickable.length} />
            <span className="sf-picker-count" aria-live="polite">{selected.length} selected</span>
          </div>
          <ul className="sf-picker-list" aria-label="Repositories">
            {shown.map((r) => {
              const [owner, name] = r.repo.split('/');
              const meta = [home(r.path), r.lastCommit ? `committed ${formatAgo(r.lastCommit, now)}` : 'no commits',
                r.worktrees ? `${r.worktrees} worktree${r.worktrees > 1 ? 's' : ''}` : null,
                r.otherClones?.length ? `+${r.otherClones.length} other clone${r.otherClones.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
              return (
                <li key={r.repo} className="sf-picker-row" data-attached={r.attached || undefined} data-on={on.has(r.repo) || undefined}>
                  <Checkbox checked={r.attached || on.has(r.repo)} disabled={r.attached} onChange={() => toggle(r.repo)}
                    label={<><span className="sf-picker-owner">{owner}/</span>{name}</>} description={meta} className="sf-picker-check" />
                  {r.attached ? <Badge tone="ok" dot>Attached</Badge> : null}
                </li>
              );
            })}
            {!shown.length ? <li className="sf-picker-none">No repositories match “{q}”.</li> : null}
          </ul>
        </>
      )}

      <footer className="sf-picker-foot">
        <p className="sf-picker-hint">Attaching imports open PRs and recent Claude Code / Codex sessions. Nothing is built or merged until you start a run.</p>
        <Button variant="primary" shortcut="⌘↵" disabled={!selected.length} onClick={submit}>
          {selected.length ? `Attach ${selected.length} project${selected.length > 1 ? 's' : ''}` : 'Attach projects'}
        </Button>
      </footer>
    </section>
  );
}
