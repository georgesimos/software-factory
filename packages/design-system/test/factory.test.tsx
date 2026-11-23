import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommandMenu, ReviewMatrix, RunCard, StageTrack, Timeline, runnerLabel, stageState, syncCounts, type Run } from '../src/index.ts';

const run: Run = {
  id: 'acme/shop#43', title: 'Add newsletter signup to footer', stage: 'review', outcome: 'in-progress', iteration: 2,
  updated: '2026-11-20T09:40:00Z',
  axes: { '1': ['ux', 'security'], '2': ['ux', 'security', 'seo'] },
  reviews: {
    '1': { ux: { verdict: 'failed', findings: [{ severity: 'high', issue: 'No already-subscribed state.', route: 'spec' }] }, security: { verdict: 'passed', findings: [] } },
    '2': { security: { verdict: 'failed', findings: [{ severity: 'high', issue: 'Possible SSRF via webhook URL.', dismissed: 'URL is a constant.' }] } },
  },
  loopbacks: [{ iteration: 1, route: 'spec', reasons: ['ux: spec gap'] }],
  events: [
    { stage: 'intake', status: 'passed' }, { stage: 'spec', status: 'passed' }, { stage: 'build', status: 'passed' },
    { stage: 'review', status: 'started', axes: ['ux', 'security', 'seo'] },
  ],
};

describe('factory', () => {
  it('stageState derives review progress and skipped stages', () => {
    expect(stageState(run, 'review')).toEqual({ state: 'active', sub: '1/3 axes' });
    expect(stageState(run, 'gate').state).toBe('pending');
    expect(stageState({ id: 'x', stage: 'build', events: [{ stage: 'build', status: 'started' }] }, 'spec').state).toBe('skipped');
  });

  it('syncCounts splits PRs from session-only branches', () => {
    expect(syncCounts({ repo: 'a/b', path: '/x', added: ['a/b#1', 'a/b#2', 'a/b:wip'], attached: ['a/b:old'], closed: [] })).toEqual({ prs: 2, sessions: 2, closed: 0 });
  });

  it('StageTrack marks the current step and draws loop-backs', () => {
    render(<StageTrack run={run} />);
    const cur = screen.getByRole('list', { name: 'Pipeline' }).querySelector('[aria-current="step"]')!;
    expect(cur).toHaveTextContent(/review: in progress/);
    expect(screen.getByText(/↺ spec · iter 1/)).toBeInTheDocument();
  });

  it('RunCard selects on click and reports the iteration', async () => {
    const fn = vi.fn();
    render(<RunCard run={run} onSelect={fn} showRepo now={Date.parse('2026-11-20T10:40:00Z')} />);
    const card = screen.getByRole('button', { name: /newsletter/i });
    expect(within(card).getByRole('img', { name: 'Iteration 2 of 3' })).toBeInTheDocument();
    expect(card).toHaveTextContent('1h ago');
    await userEvent.click(card);
    expect(fn).toHaveBeenCalledWith(run, expect.anything());
  });

  it('ReviewMatrix strikes dismissed findings and passes a review whose only blocker was dismissed', async () => {
    render(<ReviewMatrix run={run} />);
    const struck = screen.getByText('Possible SSRF via webhook URL.');
    expect(struck.tagName).toBe('S');
    const trigger = struck.parentElement!;
    act(() => trigger.focus());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Dismissed: URL is a constant.');
    const rows = screen.getAllByRole('row');
    expect(rows.find((r) => r.textContent?.startsWith('security'))).toHaveTextContent('✓ pass · 1');
    expect(rows.find((r) => r.textContent?.startsWith('seo'))).toHaveTextContent('… pending');
  });

  it('runnerLabel names who ran a step and on which model, and a fallback when the model changed', () => {
    expect(runnerLabel({ use: 'default', model: 'fable', effort: 'high' })).toEqual({ text: 'Fable · high', title: 'Run by the built-in brief on fable (high effort) (configured; no usage yet)' });
    expect(runnerLabel({ use: 'default', model: 'fable' }, true, undefined, 'claude-opus-5-5')?.text).toBe('Fable → Opus (fallback)');
    expect(runnerLabel({ use: 'skill', name: 'acme:brand-review' }, true)?.text).toBe('brand-review');
    expect(runnerLabel({ use: 'default', model: 'claude-opus-5-5' }, true, undefined, 'claude-opus-5-5')?.text).toBe('Opus'); // a full id is not a fallback
    expect(runnerLabel({ use: 'default', fallback: { from: { use: 'skill', name: 'x' }, reason: 'not installed' } })?.title).toBe('Configured skill: x was unavailable: not installed');
    expect(runnerLabel({ use: 'default' })).toBeNull();
  });

  it('shows runners, used models, burn and deploys where the dashboard did', () => {
    const r: Run = { ...run, runners: { build: { use: 'default', model: 'opus' }, gate: { use: 'default', model: 'fable' } },
      reviews: { ...run.reviews, '2': { ...run.reviews!['2'], ux: { verdict: 'passed', findings: [], runner: { use: 'default', model: 'sonnet' } } } },
      burn: { measured: true, total: { tokens: 120_000, costUsd: 1.5 }, byStage: { build: { tokens: 90_000, costUsd: 1, used: 'claude-opus-5-5' } },
        byAxis: { ux: { tokens: 20_000, costUsd: 0.3, used: 'claude-sonnet-5-5' }, verifier: { tokens: 10_000, costUsd: 0.2, used: 'claude-opus-5-5' } } },
      deploys: [{ connector: 'vercel', env: 'preview', state: 'ready', status: 'passed', url: 'https://x.vercel.app' }] };
    const { unmount } = render(<StageTrack run={r} />);
    expect(screen.getByTitle('Run by the built-in brief on opus')).toHaveTextContent('Opus');
    expect(screen.getByTitle(/^Verifier run by the built-in brief on opus; configured fable/)).toHaveTextContent('Fable → Opus (fallback)');
    unmount();
    render(<ReviewMatrix run={r} />);
    expect(screen.getAllByRole('row').find((x) => x.textContent?.startsWith('ux'))).toHaveTextContent('Sonnet20k');
    expect(screen.getByText('verifier 10k · $0.20')).toBeInTheDocument();
    render(<RunCard run={r} />);
    expect(screen.getByText('Preview ↗')).toHaveAttribute('title', 'Preview ready: https://x.vercel.app');
    expect(screen.getByText('120k tok')).toBeInTheDocument();
  });

  it('Timeline shows notes and local checks', () => {
    render(<Timeline events={[{ stage: 'note' as never, status: 'pending', step: 'build', text: 'use the v2 API' }, { stage: 'note' as never, status: 'applied', steps: ['build', 'review.code'] },
      { stage: 'gate', status: 'passed', localChecks: { state: 'passed' } }]} />);
    expect(screen.getByText('for build: use the v2 API')).toBeInTheDocument();
    cleanup();
    render(<Timeline events={[{ stage: 'note' as never, status: 'pending', step: 'next' }]} />); // F ui and the artifact send note events without their text
    expect(screen.getByText('for next')).toBeInTheDocument();
    cleanup();
    render(<Timeline events={[{ stage: 'note' as never, status: 'pending', step: 'build', text: 'use the v2 API' }, { stage: 'note' as never, status: 'applied', steps: ['build', 'review.code'] },
      { stage: 'gate', status: 'passed', localChecks: { state: 'passed' } }]} />);
    expect(screen.getByText('handed to build, review.code')).toBeInTheDocument(); // was dashboard.html's timeline test
    expect(screen.getByText(/local checks passed/)).toBeInTheDocument();
  });

  it('CommandMenu opens on ⌘K, filters, and runs with Enter', async () => {
    const openRun = vi.fn();
    function M() {
      const [open, setOpen] = useState(false);
      return <CommandMenu open={open} onOpenChange={setOpen} commands={[
        { id: 'a', label: 'Attach projects', group: 'Actions', onRun: vi.fn() },
        { id: 'r43', label: 'Add newsletter signup to footer', group: 'Runs', keywords: 'acme/shop#43', onRun: openRun },
      ]} />;
    }
    render(<M />);
    await userEvent.keyboard('{Meta>}k{/Meta}');
    const input = screen.getByRole('combobox', { name: 'Search commands' });
    await userEvent.type(input, '#43');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    expect(openRun).toHaveBeenCalledOnce();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
