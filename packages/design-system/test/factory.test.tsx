import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommandMenu, ReviewMatrix, RunCard, StageTrack, stageState, syncCounts, type Run } from '../src/index.ts';

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
