import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { App } from '../src/App.tsx';
import type { FactoryData } from '../src/data.ts';
import { SetupWizard } from '../src/Setup.tsx';

const data = state as unknown as FactoryData; // projects acme/shop and acme/budget
const F = 'node ~/.claude/skills/software-factory/factory.mjs';
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const wizard = (p: Partial<Parameters<typeof SetupWizard>[0]> = {}) =>
  render(<SetupWizard open onClose={() => {}} data={data} onSkills={() => {}} refresh={() => {}} openSkills={() => {}} {...p} />);
const step = (name: RegExp) => userEvent.click(screen.getByRole('button', { name }));
const status = () => within(screen.getByRole('dialog', { name: 'Set up the factory' })).getAllByRole('status').at(-1)!;

describe('Setup wizard', () => {
  it('read-only: each step shows the command to run, quoted', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    wizard();
    expect(screen.getByText(/Read-only page/)).toBeTruthy();
    expect(screen.getByText(`${F} onboard`)).toBeTruthy();
    await step(/^What you ship/);
    await userEvent.click(screen.getByRole('button', { name: 'acme/budget' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Web/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Database/ }));
    expect(screen.getByText(`${F} onboard ship 'acme/budget' web,database`)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rules: a rule change needs a reason, then shows its commands', async () => {
    wizard();
    await step(/^Rules/);
    await userEvent.click(screen.getByRole('button', { name: 'acme/budget' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'CI' }), 'skip');
    await userEvent.click(screen.getByRole('button', { name: 'Show commands' }));
    expect(status()).toHaveTextContent('A reason is required');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Reason (required)' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (required)' }), "CI's down");
    await userEvent.click(screen.getByRole('button', { name: 'Show commands' }));
    expect(screen.getByText(`${F} rules set 'acme/budget' 'ci' 'skip' --reason 'CI'\\''s down'`)).toBeTruthy();
  });

  it('live: reads POST /api/onboard once, and warns once before leaving unsaved rule edits', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ harnesses: [], repos: [], projects: { 'acme/app': { path: '/x', autoMerge: true } }, rules: {} }), { status: 200 });
    }));
    wizard({ token: 'tok' });
    expect(await screen.findByText('No harness adapters are registered.')).toBeTruthy();
    await step(/^Rules/);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'CI' }), 'advisory');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(status()).toHaveTextContent('Unsaved rule changes');
    expect(screen.getByRole('heading', { name: 'Rules' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Review and start' })).toBeTruthy();
    expect(calls).toEqual(['/api/onboard']);
  });

  it('Alt+Arrow moves between steps, but not from a field', async () => {
    wizard();
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Local AI' }), { key: 'ArrowRight', altKey: true });
    expect(screen.getByRole('heading', { name: 'Repo' })).toBeTruthy();
    await step(/^Rules/);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reason (required)' }), { key: 'ArrowLeft', altKey: true });
    expect(screen.getByRole('heading', { name: 'Rules' })).toBeTruthy();
  });
});

describe('Setup auto-open', () => {
  const app = (d: Partial<FactoryData>) => render(<App load={async () => ({ ...data, ...d })} />);
  it('opens when no project is attached, and stays closed for the tab once closed', async () => {
    const { unmount } = app({ projects: [] });
    expect(await screen.findByRole('dialog', { name: 'Set up the factory' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Set up the factory' })).getByRole('button', { name: /Close/ }));
    unmount();
    app({ projects: [] });
    await screen.findByRole('tab', { name: /All/ });
    expect(screen.queryByRole('dialog', { name: 'Set up the factory' })).toBeNull();
  });
  it('stays closed when the data has no projects list', async () => {
    app({ projects: undefined });
    await screen.findByRole('tab', { name: /All/ });
    expect(screen.queryByRole('dialog', { name: 'Set up the factory' })).toBeNull();
  });
});
