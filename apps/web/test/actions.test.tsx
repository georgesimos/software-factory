import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { App } from '../src/App.tsx';
import { normData, type FactoryData } from '../src/data.ts';
import { RunDetail } from '../src/RunDetail.tsx';

const data = normData(state as unknown as FactoryData);
const run = (id: string) => data.runs.find((r) => r.id === id)!;
const wide = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1100'), addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

describe('run actions (#27)', () => {
  it('an active run: the Claude Code prompt to copy; no button without F ui', () => {
    render(<RunDetail run={run('acme/shop#45')} cap={3} costCap={5} />);
    expect(screen.getByText('/software-factory acme/shop#45')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Resume factory/ })).toBeNull();
  });

  it('under F ui, an active run that is not resumable keeps the prompt to copy and says why there is no Start (#22)', () => {
    const { unmount } = render(<RunDetail run={run('acme/shop#45')} cap={3} costCap={5} />);
    expect(screen.queryByText(/No Start here/)).toBeNull(); // the read-only page needs no explanation
    unmount();
    render(<RunDetail run={run('acme/shop#45')} cap={3} costCap={5} token="tok" />);
    expect(screen.getByText(/No Start here: its session is still running, here or in Claude Code/)).toBeTruthy();
    expect(screen.getByText('/software-factory acme/shop#45')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Start|Resume factory/ })).toBeNull();
  });

  it('escalated, rejected, merged, split and awaiting-approval runs offer neither: those are a human’s call', () => {
    for (const id of ['acme/shop#44', 'acme/shop#41', 'acme/shop#43', 'acme/shop#46', 'acme/shop#49']) {
      const { unmount } = render(<RunDetail run={run(id)} cap={3} costCap={5} />);
      expect(screen.queryByText(`/software-factory ${id}`), id).toBeNull();
      unmount();
    }
  });

  const served = (reply: () => Promise<Response>, hash: string) => {
    wide();
    history.replaceState(null, '', '/?t=tok#' + encodeURIComponent(hash));
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { // writes only: the run detail also reads GET /api/sessions
      if (init?.method !== 'POST') return new Response(JSON.stringify({ sessions: [] }));
      calls.push([url, init]); return reply();
    }));
    render(<App load={async () => ({ ...data, token: 'tok', resumable: ['acme/shop#45'] })} />);
    return calls;
  };

  it('under F ui: Resume only for a run the server says it can resume; POST /api/sessions with the token, repo and issue only', async () => {
    let done!: (r: Response) => void;
    const calls = served(() => new Promise((r) => { done = r; }), 'acme/shop#45');
    const panel = await screen.findByRole('complementary');
    await userEvent.click(within(panel).getByRole('button', { name: 'Resume factory' }));
    expect(within(panel).getByRole('button', { name: 'Resuming…' })).toBeDisabled();
    expect(calls[0]![0]).toBe('/api/sessions');
    expect(calls[0]![1].headers).toMatchObject({ 'x-factory-token': 'tok' });
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ repo: 'acme/shop', issue: 45 });
    done(new Response(JSON.stringify({}), { status: 200 })); // no session id: still a success
    expect(await within(panel).findByText('Resumed. It shows here as it runs.')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /Resum/ })).toBeNull(); // no second resume of a live run
  });

  it('under F ui: an active run the server would refuse gets the prompt, not a button', async () => {
    served(async () => new Response('{}'), 'acme/shop#48');
    const panel = await screen.findByRole('complementary');
    expect(within(panel).getByText('/software-factory acme/shop#48')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: /Resume factory/ })).toBeNull();
  });

  it('shows the server’s refusal, and keeps a run’s result when you switch away and back', async () => {
    served(async () => new Response(JSON.stringify({ error: 'run budget exceeded' }), { status: 400 }), 'acme/shop#45');
    const panel = await screen.findByRole('complementary');
    await userEvent.click(within(panel).getByRole('button', { name: 'Resume factory' }));
    expect(await within(panel).findByText('run budget exceeded')).toHaveAttribute('data-bad');
    await userEvent.click(document.querySelector<HTMLAnchorElement>(`.web-board a[href="#${CSS.escape(encodeURIComponent('acme/shop#48'))}"]`)!);
    expect(within(await screen.findByRole('complementary')).queryByText('run budget exceeded')).toBeNull();
    await userEvent.click(document.querySelector<HTMLAnchorElement>(`.web-board a[href="#${CSS.escape(encodeURIComponent('acme/shop#45'))}"]`)!);
    expect(await within(await screen.findByRole('complementary')).findByText('run budget exceeded')).toBeTruthy();
  });
});
