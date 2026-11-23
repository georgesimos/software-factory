import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadData } from '../src/data.ts';

const RUN = { id: 'acme/app#7', title: 'Seven', stage: 'build' };
const win = window as unknown as Record<string, unknown>;

afterEach(() => {
  delete win.__FACTORY_DATA__;
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('loadData', () => {
  it('uses window.__FACTORY_DATA__ when a host injects it', async () => {
    win.__FACTORY_DATA__ = { runs: [RUN], cap: 4 };
    vi.stubGlobal('fetch', vi.fn());
    expect(await loadData()).toMatchObject({ runs: [RUN], cap: 4 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the #data tag page() fills, and skips it while it still holds the placeholder', async () => {
    document.body.innerHTML = `<script type="application/json" id="data">${JSON.stringify({ runs: [RUN], costCap: 9 })}</script>`;
    expect(await loadData()).toMatchObject({ runs: [RUN], costCap: 9 });
    document.body.innerHTML = '<script type="application/json" id="data">__FACTORY_DATA__</script>';
    expect((await loadData()).runs.length).toBeGreaterThan(1); // dev fixture
  });

  it('fetches GET /api/state with the F ui token from ?t=, and keeps the token for writes', async () => {
    history.replaceState(null, '', '/?t=tok123');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runs: [RUN], skills: { steps: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadData()).toMatchObject({ runs: [RUN], skills: { steps: [] }, token: 'tok123' });
    expect(fetchMock).toHaveBeenCalledWith('/api/state', { headers: { 'x-factory-token': 'tok123' } });
  });

  it('keeps only well-formed burn cells, deploys and sessions, newest session first', async () => {
    win.__FACTORY_DATA__ = { runs: [{ id: 'a/b#1', burn: { total: { tokens: 10, costUsd: 'x', used: 'bad model id!' }, byStage: { build: { tokens: 'no' }, spec: { tokens: 5 } } },
      deploys: [{ connector: 'vercel', env: 'preview', ts: '2026-01-01' }, { env: 'x' }], sessions: [{ id: 1, last: '2026-01-01' }, { id: 'b', last: '2026-02-01' }, {}] }] };
    const [r] = (await loadData()).runs;
    expect(r!.burn).toEqual({ measured: false, total: { tokens: 10, costUsd: null, unpriced: 0, used: null }, byStage: { spec: { tokens: 5, costUsd: null, unpriced: 0, used: null } }, byIteration: {}, byAxis: {}, reported: null });
    expect(r!.deploys).toEqual([{ connector: 'vercel', env: 'preview', state: '?', status: '', ts: '2026-01-01', at: '2026-01-01' }]);
    expect(r!.sessions!.map((x) => x.id)).toEqual(['b', '1']);
  });

  it('falls through to GET /api/state when the #data tag holds broken JSON', async () => {
    document.body.innerHTML = '<script type="application/json" id="data">{"runs": [</script>';
    history.replaceState(null, '', '/?t=tok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ runs: [RUN] }), { status: 200 })));
    expect(await loadData()).toMatchObject({ runs: [RUN] });
  });

  it('never fetches without a token, and falls back to the fixture in dev', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const d = await loadData();
    expect(fetch).not.toHaveBeenCalled();
    expect(d.runs.some((r) => r.id.startsWith('acme/shop#'))).toBe(true);
    expect(d.metrics?.all).toBeDefined();
  });

  it('in a production build, a bad API answer is an error, not fixture runs', async () => {
    vi.stubEnv('DEV', false);
    history.replaceState(null, '', '/?t=tok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200 })));
    await expect(loadData()).rejects.toThrow('GET /api/state answered 200 without a run list.');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"missing or wrong token"}', { status: 403 })));
    await expect(loadData()).rejects.toThrow('GET /api/state answered 403.');
    history.replaceState(null, '', '/');
    await expect(loadData()).rejects.toThrow(/no `F ui` token/);
  });
});
