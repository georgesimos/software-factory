import { repoOf, type Metrics, type Run } from '@software-factory/design-system';

/** The JSON `page()` in packages/factory/factory.mjs injects. `GET /api/runs` gives only `runs`. */
export interface FactoryData {
  runs: Run[];
  generated?: string;
  cap?: number;
  costCap?: number;
  projects?: string[];
  metrics?: { all: Metrics; byProject: Record<string, Metrics> };
}

// factory.mjs defaults, for data that does not carry them (GET /api/runs).
export const CAP = 3;
export const COST_CAP = 5;

declare global { interface Window { __FACTORY_DATA__?: unknown } }

const isData = (d: unknown): d is FactoryData => !!d && typeof d === 'object' && Array.isArray((d as FactoryData).runs);

/** Every repo with a run, plus attached projects that have none yet. */
export const projectsOf = (d: FactoryData) => [...new Set([...(d.projects ?? []), ...d.runs.map((r) => repoOf(r.id))])];

/**
 * Injected data first (a host-set `window.__FACTORY_DATA__`, or the #data tag page() fills), then `GET /api/runs` with the
 * `F ui` token from `?t=`, then the playground fixture in dev. A production build never shows fixture runs.
 */
export async function loadData(): Promise<FactoryData> {
  // shortcut: the bundle contains the placeholder's name, and page() fills only the first occurrence; a single-file build (W3)
  // must inline this script after the #data tag or rename the placeholder.
  if (isData(window.__FACTORY_DATA__)) return window.__FACTORY_DATA__;
  const tag = document.getElementById('data')?.textContent?.trim() ?? '';
  if (tag.startsWith('{')) {
    const d: unknown = JSON.parse(tag);
    if (isData(d)) return d;
  }

  let why = 'No run data was injected and no `F ui` token is in the URL.';
  const token = new URLSearchParams(location.search).get('t');
  if (token) {
    try {
      const res = await fetch('./api/runs', { headers: { 'x-factory-token': token } });
      const body: unknown = res.ok ? await res.json().catch(() => null) : null; // a dev server may answer with index.html
      if (isData(body)) return { runs: body.runs };
      why = `GET /api/runs answered ${res.status}${res.ok ? ' without a run list' : ''}.`;
    } catch (e) {
      why = `GET /api/runs failed: ${(e as Error).message}`;
    }
  }
  if (import.meta.env.DEV) {
    const f = await import('../../playground/src/fixtures/index.ts');
    return { runs: f.RUNS, cap: f.CAP, costCap: f.COST_CAP, projects: f.PROJECTS, metrics: { all: f.METRICS['']!, byProject: f.METRICS } };
  }
  throw new Error(why);
}
