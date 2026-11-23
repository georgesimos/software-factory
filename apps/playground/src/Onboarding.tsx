import { Button, IngestProgress, ProjectPicker, useToast, type IngestItem } from '@software-factory/design-system';
import { useEffect, useState } from 'react';
import { DISCOVERED, SYNC } from './fixtures/index.ts';

/** Discover → pick → import, simulated with timers. The app replaces the timers with `factory.mjs discover` / `sync`. */
export function Onboarding() {
  const toast = useToast();
  const [repos, setRepos] = useState<typeof DISCOVERED | null>(null);
  const [selected, setSelected] = useState(['acme/app', 'acme/api', 'acme/design']);
  const [items, setItems] = useState<IngestItem[] | null>(null);

  useEffect(() => { const t = setTimeout(() => setRepos(DISCOVERED), 900); return () => clearTimeout(t); }, []);

  // One project syncs at a time, like `sync` does; each finishes after ~1s.
  useEffect(() => {
    if (!items) return;
    const i = items.findIndex((x) => x.status === 'queued' || x.status === 'syncing');
    if (i < 0) { toast({ title: `${items.filter((x) => x.status === 'done').length} projects attached`, tone: 'ok', description: 'Imported runs are tracked, never driven.' }); return; }
    const it = items[i]!, s = SYNC[it.repo] ?? { prs: 0, sessions: 0 };
    const t = setTimeout(() => setItems((xs) => xs!.map((x, k) => k !== i ? x
      : x.status === 'queued' ? { ...x, status: 'syncing', prs: Math.ceil(s.prs / 2) }
      : s.error ? { ...x, status: 'failed', error: s.error } : { ...x, status: 'done', ...s })), it.status === 'queued' ? 300 : 900);
    return () => clearTimeout(t);
  }, [items, toast]);

  const start = (sel: string[]) => setItems(sel.map((repo) => ({ repo, status: 'queued' })));
  return (
    <div className="pg-onboarding">
      {items ? (
        <div className="pg-stack">
          <IngestProgress items={items} onRetry={(repo) => setItems((xs) => xs!.map((x) => x.repo === repo ? { repo, status: 'queued' } : x))} />
          <div><Button variant="ghost" onClick={() => setItems(null)}>← Back to projects</Button></div>
        </div>
      ) : (
        <ProjectPicker repos={repos} selected={selected} onChange={setSelected} onSubmit={start} scannedRoots={['/home/dev/Development', '/home/dev/code']} />
      )}
      <div className="pg-stack">
        <div className="sf-label">Step 2, mid-import (static)</div>
        <IngestProgress items={[
          { repo: 'acme/app', status: 'done', prs: 5, sessions: 3, closed: 1 },
          { repo: 'acme/api', status: 'done', prs: 2, sessions: 4 },
          { repo: 'acme/design', status: 'syncing', prs: 0 },
          { repo: 'acme/empty-starter', status: 'failed', error: 'origin has no default branch yet' },
          { repo: 'oss-lab/parser-kit', status: 'queued' },
        ]} onRetry={() => {}} />
      </div>
    </div>
  );
}
