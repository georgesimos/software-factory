import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { App } from '../src/App.tsx';
import { normData, type FactoryData } from '../src/data.ts';
import { RunDetail } from '../src/RunDetail.tsx';

const data = normData(state as unknown as FactoryData);
const run = (id: string) => data.runs.find((r) => r.id === id)!;
const detail = (id: string, start?: (id: string) => Promise<string>) => render(<RunDetail run={run(id)} cap={3} costCap={5} start={start} />);
const wide = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1100'), addEventListener() {}, removeEventListener() {} }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

describe('run actions (#27)', () => {
  it('without F ui: the Claude Code prompt to copy, no Run button', () => {
    detail('acme/shop#44');
    expect(screen.getByText('/software-factory acme/shop#44')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run factory' })).toBeNull();
  });

  it('merged, split and awaiting-approval runs offer no start; approving stays human-only', () => {
    for (const id of ['acme/shop#43', 'acme/shop#46', 'acme/shop#49']) {
      const { unmount } = detail(id);
      expect(screen.queryByText(`/software-factory ${id}`)).toBeNull();
      unmount();
    }
  });

  it('shows progress, then the session or the server’s refusal', async () => {
    let done!: (s: string) => void;
    const start = vi.fn(() => new Promise<string>((r) => { done = r; }));
    detail('acme/shop#44', start);
    await userEvent.click(screen.getByRole('button', { name: 'Run factory' }));
    expect(start).toHaveBeenCalledWith('acme/shop#44');
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    done('0f3c9a1e-1111-2222-3333-444455556666');
    expect(await screen.findByText('Started session 0f3c9a1e. It shows here as it runs.')).toBeTruthy();
    start.mockRejectedValueOnce(new Error('acme/shop#44 already has a running session'));
    await userEvent.click(screen.getByRole('button', { name: 'Run factory' }));
    expect(await screen.findByText('acme/shop#44 already has a running session')).toHaveAttribute('data-bad');
  });

  it('under F ui: POST /api/sessions with the token, the repo and the issue number only', async () => {
    wide();
    history.replaceState(null, '', '/?t=tok#' + encodeURIComponent('acme/shop#41'));
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(JSON.stringify({ session: 'abcdef12-0000' }), { status: 200 }); }));
    render(<App load={async () => ({ ...data, token: 'tok' })} />);
    const panel = await screen.findByRole('complementary');
    await userEvent.click(within(panel).getByRole('button', { name: 'Run factory' }));
    expect(await within(panel).findByText(/Started session abcdef12/)).toBeTruthy();
    expect(calls[0]![0]).toBe('/api/sessions');
    expect(calls[0]![1].headers).toMatchObject({ 'x-factory-token': 'tok' });
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ repo: 'acme/shop', issue: 41 });
  });
});
