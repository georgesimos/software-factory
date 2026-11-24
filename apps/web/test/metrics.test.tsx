import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import demo from '../../playground/src/fixtures/demo.json';
import { App } from '../src/App.tsx';
import type { FactoryData } from '../src/data.ts';
import { MetricsSheet, dayBars, dayOf, normMetrics, rows, sinceFor, type LogMetrics } from '../src/Metrics.tsx';

const c = (tokens: number, costUsd: number | null, more: Record<string, unknown> = {}) => ({ tokens, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd, unpriced: 0, reported: 0, source: 'measured', ...more });
// The shape GET /api/metrics returns (packages/core/src/metrics.ts logMetrics).
const reply = {
  project: null, since: '2026-11-20', total: c(5_107_500, 9.1142, { input: 2_003_000, cacheRead: 3_002_000, unpriced: 2000, reported: 6500, source: 'mixed' }), cacheHitRatio: 0.6,
  byDay: { '2026-11-22': c(6500, 0.0142), '2026-11-20': c(5_100_000, 8.6) },
  byProject: { 'acme/a': c(5_107_000, 9.1), 'acme/b': c(500, 0.01) },
  byStage: { review: c(1_002_000, 2), intake: c(1_000_000, 4), build: c(3_105_000, 3.1) },
  byAxis: { code: c(1_002_000, 2) }, byModel: { 'claude-opus-5-5': c(4_100_000, 6.6), 'claude-mystery-9': c(2000, null, { unpriced: 2000, source: 'reported' }) },
  byHarness: { 'claude-code': c(5_100_500, 9.1), codex: c(6000, 0.0042, { source: 'reported' }) },
  outcomes: { merged: 2, humanMerged: 1, escalated: 2, rejected: 0, closed: 0, split: 0, reverted: 1 },
  costPerMergedPrUsd: 4.56, loopsPerRun: 0.333, capHitShare: 0.333, medianIntakeToMergeMs: 84_600_000, measuredRuns: 2,
};

describe('metrics data shaping', () => {
  it('normMetrics keeps well-formed numbers only', () => {
    const m = normMetrics({ ...reply, total: { tokens: '9', costUsd: 'x' }, byDay: { 'not-a-day': c(1, 1), '2026-11-20': c(5, 1) }, outcomes: { merged: 'lots' }, loopsPerRun: NaN });
    expect(m.total).toMatchObject({ tokens: 0, costUsd: null, unpriced: 0 });
    expect(Object.keys(m.byDay)).toEqual(['2026-11-20']);
    expect(m.outcomes.merged).toBe(0);
    expect(m.loopsPerRun).toBeNull();
    expect(normMetrics(null).byStage).toEqual({});
  });
  it('sinceFor counts today as one of the days', () => {
    const now = Date.parse('2026-11-23T15:00:00Z');
    expect([sinceFor('7', now), sinceFor('30', now), sinceFor('', now)]).toEqual(['2026-11-17', '2026-10-25', '']);
  });
  it('dayBars fills quiet days with zero bars and starts at since', () => {
    const m = normMetrics(reply);
    expect(dayBars(m.byDay).map((b) => [b.day, b.cell?.tokens ?? 0])).toEqual([['2026-11-20', 5_100_000], ['2026-11-21', 0], ['2026-11-22', 6500]]);
    expect(dayBars(m.byDay, '2026-11-19')[0]).toEqual({ day: '2026-11-19', cell: null });
    expect(dayBars({})).toEqual([]);
    // A range runs to today: quiet days at the end are zero bars too.
    expect(dayBars(m.byDay, '2026-11-19', '2026-11-24').map((b) => b.day)).toEqual(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
    expect(dayBars(m.byDay, '', '2026-11-21').at(-1)!.day).toBe('2026-11-22'); // never cuts burn off
  });
  it('rows: pipeline order for stages, most tokens first otherwise, with shares', () => {
    const m = normMetrics(reply);
    expect(rows(m.byStage, ['intake', 'spec', 'build', 'review']).map((r) => r.key)).toEqual(['intake', 'build', 'review']);
    const byModel = rows(m.byModel);
    expect(byModel.map((r) => r.key)).toEqual(['claude-opus-5-5', 'claude-mystery-9']);
    expect(byModel[0]!.share + byModel[1]!.share).toBeCloseTo(1);
  });
});

describe('Metrics sheet', () => {
  it('shows tiles, outcomes, the chart and breakdowns, and refetches on a filter', async () => {
    const load = vi.fn(async (_t: string, project: string): Promise<LogMetrics> => normMetrics(project ? { ...reply, total: c(500, 0.01), byProject: {} } : reply));
    render(<MetricsSheet open onClose={() => {}} token="t" projects={['acme/a', 'acme/b']} project="" load={load} />);
    const sheet = screen.getByRole('dialog', { name: 'Metrics' });
    const burn = await within(sheet).findByRole('region', { name: 'Burn and cost' });
    expect(load).toHaveBeenCalledWith('t', '', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)); // the 30-day default
    expect(within(burn).getByText('$9.11+')).toBeTruthy(); // some tokens unpriced
    expect(within(burn).getByText('60')).toBeTruthy(); // cache hits, %
    expect(within(burn).getByText('$4.56+')).toBeTruthy();
    const out = within(sheet).getByRole('region', { name: 'Outcomes' });
    expect(within(out).getByText('Human-merged').parentElement!.textContent).toContain('1');
    expect(within(sheet).getByRole('img', { name: new RegExp(`^Tokens per day, ${sinceFor('30')} to ${dayOf(Date.now())}; peak 5\\.1M tokens on 2026-11-20$`) })).toBeTruthy(); // the range, to today
    const models = within(sheet).getByRole('region', { name: 'Burn by model' });
    expect(within(models).getByText('—')).toBeTruthy(); // the unpriced model has no cost
    expect(within(models).getByText('100% of tokens', { exact: false })).toBeTruthy(); // the share, as text for screen readers
    expect(within(sheet).getByRole('region', { name: 'Burn by project' })).toBeTruthy();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Cost' }));
    expect(within(sheet).getByRole('img', { name: /^Cost per day, .*; peak \$8\.60 on 2026-11-20$/ })).toBeTruthy();

    // While the next filter loads, the old numbers stay but are marked busy and dimmed.
    let release = () => {};
    load.mockImplementationOnce((_t, project) => new Promise((ok) => { release = () => ok(normMetrics(project ? { ...reply, total: c(500, 0.01), byProject: {} } : reply)); }));
    await userEvent.selectOptions(within(sheet).getByLabelText('Project'), 'acme/b');
    expect(sheet.querySelector('.web-mx-data')!.getAttribute('aria-busy')).toBe('true');
    release();
    await waitFor(() => expect(sheet.querySelector('.web-mx-data')!.hasAttribute('aria-busy')).toBe(false));
    await userEvent.selectOptions(within(sheet).getByLabelText('Range'), '');
    expect(load).toHaveBeenLastCalledWith('t', 'acme/b', '');
    expect(await within(sheet).findByText('$0.01')).toBeTruthy();
    expect(within(sheet).queryByRole('region', { name: 'Burn by project' })).toBeNull(); // one project: no project split
  });

  it('shows the API error, and an empty range plainly', async () => {
    const { unmount } = render(<MetricsSheet open onClose={() => {}} token="t" projects={[]} project="" load={async () => { throw new Error('missing or wrong token'); }} />);
    expect(await screen.findByText('missing or wrong token')).toBeTruthy();
    unmount();
    const { unmount: u2 } = render(<MetricsSheet open onClose={() => {}} token="t" projects={[]} project="" load={async () => normMetrics({ outcomes: { closed: 2, split: 1 } })} />);
    expect(await screen.findByText('Nothing in this range')).toBeTruthy(); // closed and split have no tile, so they don't fill the page
    u2();
    // A filter change while empty: the message keeps the filter it was loaded for and goes busy until the new one answers; a
    // late answer for the old filter, after a newer one landed, is dropped.
    const pending: Record<string, (m: LogMetrics) => void> = {};
    const lazy = vi.fn((_t: string, project: string) => (project ? new Promise<LogMetrics>((ok) => { pending[project] = ok; }) : Promise.resolve(normMetrics({}))));
    const { unmount: u3 } = render(<MetricsSheet open onClose={() => {}} token="t" projects={['acme/a', 'acme/b']} project="" load={lazy} />);
    await screen.findByText(/^No run spent tokens or finished in the last 30 days\.$/);
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'acme/a');
    expect(screen.queryByText(/in acme\/a/)).toBeNull();
    expect(screen.getByText(/^No run spent tokens or finished in the last 30 days\.$/).closest('.web-mx-data')!.getAttribute('aria-busy')).toBe('true');
    await userEvent.selectOptions(screen.getByLabelText('Project'), 'acme/b');
    pending['acme/b']!(normMetrics({}));
    expect(await screen.findByText(/in acme\/b\.$/)).toBeTruthy();
    pending['acme/a']!(normMetrics(reply)); // A's late answer
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/in acme\/b\.$/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Burn and cost' })).toBeNull();
    u3();
    // A 200 that isn't JSON (a dev server's index.html) is an error, not an empty range.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200 })));
    try {
      render(<MetricsSheet open onClose={() => {}} token="t" projects={[]} project="" />);
      expect(await screen.findByText('GET /api/metrics answered 200 without JSON')).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });

  it('is offered under F ui and on the Artifact (embedded numbers), not on F render’s file', async () => {
    const { unmount } = render(<App load={async () => demo as unknown as FactoryData} />);
    await screen.findByText('Merge rate');
    expect(screen.queryAllByRole('button', { name: 'Metrics' })).toEqual([]);
    unmount();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 })));
    try {
      render(<App load={async () => ({ ...(demo as unknown as FactoryData), token: 'tok' })} />);
      const [top, alt] = await screen.findAllByRole('button', { name: 'Metrics' }); // the header's, and the one phones get under it
      expect([top!.className, alt!.className]).toEqual([expect.stringContaining('web-mx-top'), expect.stringContaining('web-mx-alt')]);
      await userEvent.click(top!);
      expect(await screen.findByRole('region', { name: 'Burn and cost' })).toBeTruthy();
      expect(vi.mocked(fetch).mock.calls[0]![0]).toMatch(/^\/api\/metrics\?since=\d{4}-\d{2}-\d{2}$/);
      expect(vi.mocked(fetch).mock.calls[0]![1]).toEqual({ headers: { 'x-factory-token': 'tok' } });
    } finally { vi.unstubAllGlobals(); }
  });

  // #82 PR C: the Artifact's page embeds logMetrics() per project and range (server.ts sheetMetrics); only all-time keeps byDay.
  const { byDay, byProject, ...ranged } = reply, generated = '2026-11-22T12:00:00.000Z';
  const metricsLog = {
    '': { '': { ...ranged, byDay, byProject }, '90': { ...ranged, byProject }, '30': { ...ranged, byProject }, '7': { ...ranged, byProject } },
    'acme/b': { '': { ...ranged, total: c(500, 0.01), byStage: { spec: c(500, 0.01) } }, '90': {}, '30': {}, '7': {} },
  };
  it('without a token, renders from the page’s embedded data, as of when it was published, and never fetches', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      render(<App load={async () => ({ ...(demo as unknown as FactoryData), generated, metricsLog })} />);
      const [top] = await screen.findAllByRole('button', { name: 'Metrics' });
      await userEvent.click(top!);
      const sheet = await screen.findByRole('dialog', { name: 'Metrics' });
      expect(within(sheet).getByText(/as of 2026-11-22/)).toBeTruthy();
      expect(await within(sheet).findByRole('img', { name: /^Tokens per day, 2026-10-24 to 2026-11-22/ })).toBeTruthy(); // 30 days to the publish day
      await userEvent.selectOptions(within(sheet).getByRole('combobox', { name: 'Range' }), '7');
      await waitFor(() => expect(within(sheet).getByRole('img', { name: /^Tokens per day, 2026-11-16 to 2026-11-22; peak [^;]* tokens on 2026-11-20$/ })).toBeTruthy()); // the all-time days from since on
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('embedded: a project’s own entry, an empty one says so, and unknown keys read as nothing', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      render(<MetricsSheet open onClose={() => {}} projects={['acme/b', '__proto__']} project="acme/b" metricsLog={metricsLog} generated={generated} />);
      expect(await screen.findByText(/No run spent tokens or finished in the last 30 days in acme\/b\./)).toBeTruthy();
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Range' }), '');
      const strip = await screen.findByRole('region', { name: 'Burn and cost' });
      expect(within(strip).getByText('500 tokens')).toBeTruthy();
      expect(screen.queryByRole('region', { name: 'Burn by project' })).toBeNull();
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project' }), '__proto__');
      expect(await screen.findByText(/^No run spent tokens or finished yet in __proto__\./)).toBeTruthy();
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
