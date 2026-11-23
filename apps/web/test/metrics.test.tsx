import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import demo from '../../playground/src/fixtures/demo.json';
import { App } from '../src/App.tsx';
import type { FactoryData } from '../src/data.ts';
import { MetricsSheet, dayBars, normMetrics, rows, sinceFor, type LogMetrics } from '../src/Metrics.tsx';

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
    expect(within(sheet).getByRole('img', { name: /^Tokens per day, .* to 2026-11-22; peak 5\.1M tokens on 2026-11-20$/ })).toBeTruthy();
    const models = within(sheet).getByRole('region', { name: 'Burn by model' });
    expect(within(models).getByText('—')).toBeTruthy(); // the unpriced model has no cost
    expect(within(sheet).getByRole('region', { name: 'Burn by project' })).toBeTruthy();

    await userEvent.click(within(sheet).getByRole('button', { name: 'Cost' }));
    expect(within(sheet).getByRole('img', { name: /^Cost per day, .*; peak \$8\.60 on 2026-11-20$/ })).toBeTruthy();

    await userEvent.selectOptions(within(sheet).getByLabelText('Project'), 'acme/b');
    await userEvent.selectOptions(within(sheet).getByLabelText('Range'), '');
    expect(load).toHaveBeenLastCalledWith('t', 'acme/b', '');
    expect(await within(sheet).findByText('$0.01')).toBeTruthy();
    expect(within(sheet).queryByRole('region', { name: 'Burn by project' })).toBeNull(); // one project: no project split
  });

  it('shows the API error, and an empty range plainly', async () => {
    const { unmount } = render(<MetricsSheet open onClose={() => {}} token="t" projects={[]} project="" load={async () => { throw new Error('missing or wrong token'); }} />);
    expect(await screen.findByText('missing or wrong token')).toBeTruthy();
    unmount();
    render(<MetricsSheet open onClose={() => {}} token="t" projects={[]} project="" load={async () => normMetrics({})} />);
    expect(await screen.findByText('Nothing in this range')).toBeTruthy();
  });

  it('is offered under F ui only: F render’s file and the Artifact have no API', async () => {
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
});
