import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IngestProgress, ProjectPicker, type DiscoveredRepo } from '../src/index.ts';

const repos: DiscoveredRepo[] = [
  { repo: 'acme/shop', path: '/home/me/dev/shop', attached: true, lastCommit: '2026-11-21T10:00:00Z', worktrees: 2 },
  { repo: 'acme/app', path: '/home/me/dev/app', attached: false, lastCommit: '2026-11-20T10:00:00Z', worktrees: 0 },
  { repo: 'acme/docs', path: '/home/me/dev/docs', attached: false, lastCommit: null, worktrees: 0, otherClones: ['/tmp/docs'] },
];

describe('onboarding', () => {
  it('ProjectPicker selects all unattached repos and submits with ⌘↵', async () => {
    const submit = vi.fn();
    function P() { const [sel, setSel] = useState<string[]>([]); return <ProjectPicker repos={repos} selected={sel} onChange={setSel} onSubmit={submit} />; }
    render(<P />);
    expect(screen.getByRole('checkbox', { name: /acme\/shop/ })).toBeDisabled();
    expect(screen.getByText(/~\/dev\/docs · no commits · \+1 other clone/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByRole('button', { name: /attach 2 projects/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /acme\/docs/ }));
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toHaveProperty('indeterminate', true);
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    expect(submit).toHaveBeenCalledWith(['acme/app']);
  });

  it('ProjectPicker shows a busy skeleton while discovering', () => {
    render(<ProjectPicker repos={null} selected={[]} onChange={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole('region', { name: 'Choose projects to attach' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: /attach projects/i })).toBeDisabled();
  });

  it('IngestProgress totals counts and retries failures', async () => {
    const retry = vi.fn();
    render(<IngestProgress onRetry={retry} items={[
      { repo: 'acme/shop', status: 'done', prs: 4, sessions: 3 },
      { repo: 'acme/app', status: 'syncing', prs: 1 },
      { repo: 'acme/docs', status: 'failed', error: 'gh: not authenticated' },
    ]} />);
    expect(screen.getByText('2 of 3 projects · 5 PRs · 3 sessions')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Projects imported' })).toHaveAttribute('value', '2');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledWith('acme/docs');
  });
});
