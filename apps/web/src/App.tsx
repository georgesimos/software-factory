import { Dot, EmptyState, Skeleton, ThemeToggle, formatAgo } from '@software-factory/design-system';
import { useEffect, useState } from 'react';
import { Board } from './Board.tsx';
import { loadData, type FactoryData } from './data.ts';

export function App({ load = loadData }: { load?: () => Promise<FactoryData> }) {
  const [state, setState] = useState<{ data?: FactoryData; error?: string }>({});
  useEffect(() => { load().then((data) => setState({ data }), (e: Error) => setState({ error: e.message })); }, [load]);
  const { data, error } = state;
  return (
    <>
      <header className="web-top">
        <span className="web-brand"><span className="sf-mark" aria-hidden="true" />Software Factory</span>
        {data?.generated ? <span className="web-updated"><Dot tone="ok" />Updated {formatAgo(data.generated)}</span> : null}
        <ThemeToggle />
      </header>
      <main className="web-main" aria-busy={!data && !error}>
        {data ? <Board data={data} /> : error ? <EmptyState title="Could not load runs">{error}</EmptyState>
          : <><span className="sf-sr-only">Loading runs…</span><Skeleton height={240} width="100%" /></>}
      </main>
    </>
  );
}
