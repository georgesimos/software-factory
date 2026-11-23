import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import demo from '../../playground/src/fixtures/demo.json';
import { App } from '../src/App.tsx';
import type { FactoryData } from '../src/data.ts';

const data = demo as unknown as FactoryData;

describe('Board', () => {
  it('renders the stage columns and metrics, and opens a run in the detail sheet', async () => {
    render(<App load={async () => data} />);
    const done = await screen.findByRole('region', { name: /^Done, \d+ runs$/ });
    expect(screen.getByRole('region', { name: /^Intake, / })).toBeTruthy();
    expect(screen.getByText('Merge rate')).toBeTruthy();

    const merged = data.runs.find((r) => r.outcome === 'merged')!;
    await userEvent.click(within(done).getByText(merged.title!));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText(merged.id)).toBeTruthy();
    expect(within(sheet).getByRole('heading', { name: merged.title })).toBeTruthy();
    expect(within(sheet).getByText('Pipeline')).toBeTruthy();
  });

  it('shows the load error instead of a board', async () => {
    render(<App load={async () => { throw new Error('GET /api/runs answered 403.'); }} />);
    expect(await screen.findByText('GET /api/runs answered 403.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Done/ })).toBeNull();
  });

  it('shows a non-Error rejection instead of loading forever', async () => {
    render(<App load={() => Promise.reject('offline')} />);
    expect(await screen.findByText('offline')).toBeTruthy();
  });
});
