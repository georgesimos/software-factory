// Realistic fixture data. demo.json is `factory.mjs demo` output (acme/shop, every outcome);
// the acme/app runs below add the imported/tracked runs `sync` creates, which the demo has none of.
import type { DiscoveredRepo, Metrics, Run, RunEvent } from '@software-factory/design-system';
import demo from './demo.json';

const T0 = Date.parse('2026-11-20T09:00:00Z');
let t = T0 + 40 * 60e3;
const at = () => new Date((t += 61_000)).toISOString();
const ev = (stage: RunEvent['stage'], status: string, p: Partial<RunEvent> = {}): RunEvent => ({ ts: at(), stage, status, ...p });

function tracked(id: string, title: string, source: string, pr?: string): Run {
  const events = [ev('intake', 'started'), ev('intake', 'passed', { summary: `Imported open PR from a ${source} session; not built by the factory.` }), ev('build', 'started'), ev('build', 'passed')];
  return { id, title, source, imported: true, pr, stage: 'build', status: 'passed', outcome: 'in-progress', iteration: 1, events, started: events[0]!.ts, updated: events.at(-1)!.ts, reviews: {}, loopbacks: [] };
}

const building: Run = (() => {
  const events = [
    ev('intake', 'started'), ev('intake', 'passed', { summary: 'Small, clear, owner-filed.' }),
    ev('spec', 'passed', { spec: 'Debounce the search input by 200 ms and cancel stale requests.' }),
    ev('build', 'started'), ev('build', 'passed'),
    ev('review', 'started', { axes: ['code', 'security', 'ux'] }),
    ev('review', 'failed', { axis: 'code', findings: [{ severity: 'medium', file: 'lib/search.ts', line: 31, issue: 'AbortController is created but never passed to fetch.', route: 'build' }] }),
    ev('review', 'passed', { axis: 'security' }), ev('review', 'passed', { axis: 'ux' }),
    ev('gate', 'failed', { next: 'build', reasons: ['code: 1 blocking finding'] }),
    ev('build', 'started', { costUsd: 0.38, tokens: 61000 }),
  ];
  return {
    id: 'acme/app#20', title: 'Debounce product search', url: 'https://github.com/acme/app/issues/20', branch: 'factory/issue-20',
    stage: 'build', status: 'started', outcome: 'in-progress', iteration: 2, costUsd: 0.38, tokens: 61000, author: 'acme', association: 'OWNER',
    spec: 'Debounce the search input by 200 ms and cancel stale requests.',
    axes: { '1': ['code', 'security', 'ux'] },
    reviews: { '1': { code: { verdict: 'failed', findings: [{ severity: 'medium', file: 'lib/search.ts', line: 31, issue: 'AbortController is created but never passed to fetch.', route: 'build' }] }, security: { verdict: 'passed', findings: [] }, ux: { verdict: 'passed', findings: [] } } },
    loopbacks: [{ iteration: 1, route: 'build', reasons: ['code: 1 blocking finding'] }],
    events, started: events[0]!.ts, updated: events.at(-1)!.ts,
  };
})();

const extra: Run[] = [
  building,
  tracked('acme/app#12', 'Migrate settings page to the new form primitives', 'codex', 'https://github.com/acme/app/pull/12'),
  tracked('acme/app#10', 'Add retry with backoff to the webhook client', 'claude-code', 'https://github.com/acme/app/pull/10'),
  { ...tracked('acme/app:simos/wip-9', 'simos/wip-9', 'claude-code+codex'), stage: 'build', status: 'started', events: [ev('intake', 'started'), ev('intake', 'passed'), ev('build', 'started')] },
  tracked('acme/app#11', 'Bump eslint to v10', 'none', 'https://github.com/acme/app/pull/11'),
  tracked('acme/app#15', 'Rewrite onboarding copy', 'human', 'https://github.com/acme/app/pull/15'),
];

/** Shift every timestamp so the newest event is `ago` ms before now; relative times then read naturally. */
function rebase(runs: Run[], ago = 3 * 60e3): Run[] {
  const latest = Math.max(...runs.map((r) => Date.parse(r.updated ?? '') || 0));
  const d = Date.now() - ago - latest;
  const s = (ts?: string) => (ts ? new Date(Date.parse(ts) + d).toISOString() : ts);
  return runs.map((r) => ({ ...r, started: s(r.started), updated: s(r.updated), events: (r.events ?? []).map((e) => ({ ...e, ts: s(e.ts) })) }));
}

export const CAP: number = demo.cap;
export const COST_CAP: number = demo.costCap;
export const RUNS: Run[] = rebase([...(demo.runs as Run[]), ...extra]).sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
export const PROJECTS = ['acme/shop', 'acme/app'];
export const METRICS: Record<string, Metrics> = {
  '': { ...demo.metrics.all, runs: RUNS.length, inProgress: RUNS.filter((r) => r.outcome === 'in-progress').length, costUsd: 1.13 },
  'acme/shop': demo.metrics.byProject['acme/shop'] as Metrics,
  'acme/app': { runs: 6, inProgress: 6, merged: 0, escalated: 0, mergeRate: null, avgIterations: null, medianCycleMs: null, reverts: 0, revertRate: null, costUsd: 0.38 },
};

const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
export const DISCOVERED: DiscoveredRepo[] = [
  { repo: 'acme/shop', path: '/Users/dev/Development/acme/shop', attached: true, lastCommit: daysAgo(0.1), worktrees: 3 },
  { repo: 'acme/app', path: '/Users/dev/Development/acme/app', attached: false, lastCommit: daysAgo(0.4), worktrees: 2, otherClones: ['/Users/dev/code/app-old'] },
  { repo: 'acme/api', path: '/Users/dev/Development/acme/api', attached: false, lastCommit: daysAgo(1), worktrees: 0 },
  { repo: 'acme/design', path: '/Users/dev/Development/acme/design', attached: false, lastCommit: daysAgo(3), worktrees: 1 },
  { repo: 'oss-lab/parser-kit', path: '/Users/dev/code/parser-kit', attached: false, lastCommit: daysAgo(12), worktrees: 0 },
  { repo: 'oss-lab/dotfiles', path: '/Users/dev/dotfiles', attached: false, lastCommit: daysAgo(40), worktrees: 0 },
  { repo: 'acme/empty-starter', path: '/Users/dev/Development/acme/empty-starter', attached: false, lastCommit: null, worktrees: 0 },
];
/** What `sync` would report per repo, used by the onboarding simulation. */
export const SYNC: Record<string, { prs: number; sessions: number; closed?: number; error?: string }> = {
  'acme/app': { prs: 5, sessions: 3, closed: 1 }, 'acme/api': { prs: 2, sessions: 4 }, 'acme/design': { prs: 0, sessions: 1 },
  'oss-lab/parser-kit': { prs: 1, sessions: 0 }, 'oss-lab/dotfiles': { prs: 0, sessions: 0 }, 'acme/empty-starter': { prs: 0, sessions: 0, error: 'origin has no default branch yet' },
};
