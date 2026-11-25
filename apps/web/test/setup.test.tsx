import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    await userEvent.click(screen.getByRole('checkbox', { name: /Desktop/ }));
    expect(screen.getByText(`${F} onboard ship 'acme/budget' web,desktop`)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('no F on this machine (the desktop app, nothing installed): says how to install it', () => {
    const { unmount } = wizard();
    expect(screen.queryByRole('note')).toBeNull();
    unmount();
    wizard({ data: { ...data, fMissing: true } });
    expect(screen.getByRole('note')).toHaveTextContent('/plugin install software-factory@software-factory');
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

  it('live: Local AI leads with each desktop app, then its CLI under Background runs', async () => {
    const hs = [
      { id: 'claude-code', label: 'Claude Code', install: 'curl x', installed: false, version: null, login: null, notes: [], app: { installed: true, path: '/Applications/Claude.app', sessions: true, opens: true } },
      { id: 'codex', label: 'Codex', install: 'npm i codex', installed: true, version: '0.141.0', login: { ok: false, hint: 'codex login' }, notes: [], app: { installed: false, sessions: true, opens: false } },
      { id: 'other', label: 'Other', install: 'x', installed: true, version: '1.0.0', login: { ok: true, hint: 'signed in' }, notes: [], app: null },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ harnesses: hs, repos: [], projects: {}, rules: {} }), { status: 200 })));
    wizard({ token: 'tok' });
    const card = async (id: string) => (await screen.findByText(hs.find((h) => h.id === id)!.label)).closest('[data-harness]')!.textContent;
    expect(await card('claude-code')).toMatch(/Claude CodeDesktop app installed \/Applications\/Claude\.appThe factory reads its sessions and can open a run in the app\.Background runs Not installedcurl x/);
    expect(await card('codex')).toMatch(/CodexDesktop app not foundThe factory reads its sessions\.Background runs 0\.141\.0InstalledNot signed incodex login/);
    expect(await card('other')).toMatch(/^ OtherBackground runs 1\.0\.0InstalledSigned in · signed in/); // no desktop(): CLI only
  });

  const live = (reply: (url: string, body: { ship?: string[] }) => Response | Promise<Response>) => vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/onboard') return new Response(JSON.stringify({ harnesses: [], repos: [], projects: { 'acme/app': { path: '/x' }, 'acme/two': { path: '/y' } }, rules: {} }), { status: 200 });
    return reply(url, JSON.parse(String(init.body)));
  }));

  it('live: the saved scope survives the onboard read; a refused ship write leaves the box as stored', async () => {
    localStorage.setItem('sf.onboard', JSON.stringify({ step: 2, scope: 'acme/two' }));
    live(() => new Response(JSON.stringify({ error: 'disk full' }), { status: 400 }));
    wizard({ token: 'tok' });
    expect(await screen.findByRole('button', { name: 'acme/two' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('checkbox', { name: /Web/ }));
    expect(await screen.findByText('disk full')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Web/ })).not.toBeChecked();
  });

  it('live: two refused ship toggles roll back to what the server last stored', async () => {
    localStorage.setItem('sf.onboard', JSON.stringify({ step: 2, scope: 'acme/app' }));
    const pending: (() => void)[] = [];
    live(() => new Promise<Response>((r) => { pending.push(() => r(new Response(JSON.stringify({ error: 'refused' }), { status: 400 }))); }));
    wizard({ token: 'tok' });
    await userEvent.click(await screen.findByRole('checkbox', { name: /Web/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Desktop/ }));
    expect(screen.getByRole('checkbox', { name: /Desktop/ })).toBeChecked();
    await act(async () => { pending.shift()!(); });
    await act(async () => { pending.shift()!(); });
    expect(screen.getByRole('checkbox', { name: /Web/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Desktop/ })).not.toBeChecked();
  });

  it('live: after Save rules, a later edit is guarded again', async () => {
    localStorage.setItem('sf.onboard', JSON.stringify({ step: 4, scope: 'acme/app' }));
    live(() => new Response('{}', { status: 200 }));
    wizard({ token: 'tok' });
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'CI' }), 'advisory');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(status()).toHaveTextContent('Unsaved rule changes');
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (required)' }), 'why');
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Rules saved for acme/app.')).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'CI' }), 'skip');
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(status()).toHaveTextContent('Unsaved rule changes');
    expect(screen.getByRole('heading', { name: 'Rules' })).toBeTruthy();
  });

  it('live: turning auto-merge on gives the command to confirm at your terminal, and posts nothing', async () => {
    localStorage.setItem('sf.onboard', JSON.stringify({ step: 4, scope: 'acme/app' }));
    const posted: string[] = [];
    live((url) => { posted.push(url); return new Response('{}', { status: 200 }); });
    wizard({ token: 'tok' });
    await userEvent.click(await screen.findByRole('checkbox', { name: /auto-merge/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText(`${F} automerge 'acme/app' on`)).toBeTruthy();
    expect(status()).toHaveTextContent('Auto-merge is turned on at your own terminal: run the command above, then type the project name it asks for.');
    expect(posted).toEqual([]);
    expect(screen.getByRole('checkbox', { name: /auto-merge/ })).not.toBeChecked(); // still off until the terminal says so
  });

  it('live: once the terminal turned auto-merge on, the box follows the stored state and a later save never posts off', async () => {
    localStorage.setItem('sf.onboard', JSON.stringify({ step: 4, scope: 'acme/app' }));
    const posted: string[] = [];
    live((url) => { posted.push(url); return new Response(JSON.stringify({ projects: { 'acme/app': { path: '/x', autoMerge: true } }, rules: {} }), { status: 200 }); });
    wizard({ token: 'tok' });
    await userEvent.click(await screen.findByRole('checkbox', { name: /auto-merge/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(screen.getByRole('checkbox', { name: /auto-merge/ })).not.toBeChecked();
    // the user ran F automerge at their terminal; the next write's reply carries it
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'CI' }), 'skip');
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason (required)' }), 'why');
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    expect(await screen.findByText('Rules saved for acme/app.')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /auto-merge/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(posted.filter((u) => u.includes('/onboard/rule'))).toHaveLength(2)); // the stub keeps no rules, so CI saves again
    expect(posted.filter((u) => u.includes('automerge'))).toEqual([]);
  });

  it('live: switching scope or closing warns once about unsaved rule edits', async () => {
    localStorage.setItem('sf.onboard', JSON.stringify({ step: 4, scope: 'acme/app' }));
    live(() => new Response('{}', { status: 200 }));
    const onClose = vi.fn();
    wizard({ token: 'tok', onClose });
    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'CI' }), 'advisory');
    await userEvent.click(screen.getByRole('button', { name: 'acme/two' }));
    expect(status()).toHaveTextContent('Unsaved rule changes');
    expect(screen.getByRole('button', { name: 'acme/app' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'acme/two' }));
    expect(screen.getByRole('combobox', { name: 'CI' })).toHaveValue('required');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'CI' }), 'skip');
    await userEvent.click(screen.getByRole('button', { name: /^Close/ }));
    expect(onClose).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent('Unsaved rule changes');
    await userEvent.click(screen.getByRole('button', { name: /^Close/ }));
    expect(onClose).toHaveBeenCalled();
  });

  it('read-only: auto-merge reads the page data', async () => {
    wizard({ data: { ...data, autoMerge: { 'acme/budget': true } } });
    await step(/^Rules/);
    await userEvent.click(screen.getByRole('button', { name: 'acme/budget' }));
    expect(screen.getByRole('checkbox', { name: /auto-merge/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'acme/shop' }));
    expect(screen.getByRole('checkbox', { name: /auto-merge/ })).not.toBeChecked(); // D1: no setting is off
    expect(screen.getByText(/^Off \(the default\): a run whose gates pass escalates, and you merge its PR in GitHub\./)).toBeInTheDocument();
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
    const { unmount } = app({ projects: [], runs: [], ideas: {} });
    expect(await screen.findByRole('dialog', { name: 'Set up the factory' })).toBeTruthy();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Set up the factory' })).getByRole('button', { name: /Close/ }));
    unmount();
    app({ projects: [], runs: [], ideas: {} });
    await screen.findByRole('tab', { name: /All/ });
    expect(screen.queryByRole('dialog', { name: 'Set up the factory' })).toBeNull();
  });
  it('stays closed over a board with runs, or data with no projects list', async () => {
    const { unmount } = app({ projects: [] });
    await screen.findByRole('tab', { name: /All/ });
    expect(screen.queryByRole('dialog', { name: 'Set up the factory' })).toBeNull();
    unmount();
    app({ projects: undefined });
    await screen.findByRole('tab', { name: /All/ });
    expect(screen.queryByRole('dialog', { name: 'Set up the factory' })).toBeNull();
  });

  // #22: under F ui, Review and start starts an issue through POST /api/runs; the read-only page keeps the prompt to copy.
  it('Review and start: an issue number starts a headless run, and a refusal shows inline', async () => {
    const calls: [string, unknown][] = [];
    let open = () => {}; const gate = new Promise<void>((y) => { open = y; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push([url, body]);
      if (url === '/api/runs') return body.issue === 'acme/app#7'
        ? new Response(JSON.stringify({ error: 'acme/app#7 is already running: its claim is held by pid 4242' }), { status: 400 })
        : gate.then(() => new Response(JSON.stringify({ pid: 99, log: '/x/run.log' }), { status: 200 }));
      return new Response(JSON.stringify({ harnesses: [], repos: [], projects: { 'acme/app': { path: '/x', autoMerge: true } }, rules: {} }), { status: 200 });
    }));
    wizard({ token: 'tok' });
    await screen.findByRole('button', { name: /^Review and start/ });
    await step(/^Review and start/);
    await userEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(screen.queryByRole('textbox', { name: /Issue number/ })).toBeNull(); // All projects: pick one first
    expect(screen.getByText(/pick a project above to start one here/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'acme/app' }));
    const n = screen.getByRole('textbox', { name: 'Issue number in acme/app' }), start = screen.getByRole('button', { name: 'Start' });
    await userEvent.type(n, '0');
    expect(start).toBeDisabled();
    await userEvent.clear(n); await userEvent.type(n, '7');
    await userEvent.click(start);
    const form = n.closest('form') as HTMLElement;
    expect(await within(form).findByText(/already running: its claim is held by pid 4242/)).toHaveAttribute('data-bad');
    await userEvent.clear(n); await userEvent.type(n, '8');
    await userEvent.click(start);
    await userEvent.clear(n); await userEvent.type(n, '9'); // edited while the request is out: the reply still names #8
    open();
    expect(await within(form).findByText(/Started acme\/app#8 headless \(pid 99\)/)).toBeTruthy();
    expect(calls.filter(([u]) => u === '/api/runs')).toEqual([['/api/runs', { issue: 'acme/app#7' }], ['/api/runs', { issue: 'acme/app#8' }]]);
  });

  it('Review and start without a token: the prompt to copy, no Start', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    wizard();
    await step(/^Review and start/);
    await userEvent.click(screen.getByRole('button', { name: 'acme/budget' }));
    expect(screen.getByText('/software-factory acme/budget#<issue>')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
