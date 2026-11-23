import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { App } from '../src/App.tsx';
import type { FactoryData } from '../src/data.ts';
import { LiveSessions, type LiveSession } from '../src/Live.tsx';

// xterm.js draws on a canvas jsdom doesn't have: a stand-in records what the pane writes and lets a test type.
const term = vi.hoisted(() => ({ written: [] as string[], type: (_: string) => {}, disposed: 0 }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 120; rows = 32;
    loadAddon() {} open() {} focus() {}
    write(s: string) { term.written.push(s); }
    onData(f: (s: string) => void) { term.type = f; return { dispose() {} }; }
    dispose() { term.disposed++; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const running: LiveSession = { id: '00000000-0000-4000-8000-000000000001', harness: 'claude-code', mode: 'terminal', label: 'acme/app#7', state: 'running', started: new Date().toISOString() };
const exited: LiveSession = { id: '00000000-0000-4000-8000-000000000002', harness: 'claude-code', mode: 'headless', label: 'acme/app#8', state: 'exited', exit: 1, started: new Date().toISOString(), harnessSession: 'abc-1' };
const sse = (...events: object[]) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }));
let calls: [string, unknown][];
const serve = (reply: (url: string, body: Record<string, unknown>) => Response | undefined = () => undefined) => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push([url, body]);
    expect((init.headers as Record<string, string>)['x-factory-token']).toBe('tok');
    if (url === '/api/sessions') return new Response(JSON.stringify({ sessions: [running, exited] }));
    if (url.endsWith('/events')) return sse({ type: 'output', data: 'hello\r\n' }, { type: 'exit', code: 0 });
    return reply(url, body) ?? new Response('{}');
  }));
};
beforeEach(() => { term.written = []; term.disposed = 0; vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Sessions sheet (#58)', () => {
  const sheet = (terminal = true) => render(<LiveSessions open onClose={() => {}} token="tok" repos={['acme/app', 'acme/two']} terminal={terminal} />);

  it('lists the live sessions, newest first; Stop only for a running one, Resume and Open in Claude for one with a harness session', async () => {
    serve();
    sheet();
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('acme/app#8'), expect.stringContaining('acme/app#7')]);
    expect(within(rows[0]!).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(rows[1]!).getByRole('button', { name: 'Stop' })).toBeTruthy();
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Resume' }));
    expect(calls.find(([u]) => u === '/api/sessions/terminal')![1]).toEqual({ repo: 'acme/app', issue: 8, harness: 'claude-code', resume: 'abc-1' });
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Stop' }));
    expect(calls.find(([u]) => u === '/api/sessions/stop')![1]).toEqual({ id: running.id });
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Open in Claude' }));
    expect(calls.find(([u]) => u === '/api/sessions/open')![1]).toEqual({ harness: 'claude-code', id: 'abc-1' });
  });

  it('New terminal starts one in the chosen repo and shows it: output in, keystrokes and size out', async () => {
    serve((url) => (url === '/api/sessions/terminal' ? new Response(JSON.stringify({ session: running.id })) : undefined));
    sheet();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Repo' }), 'acme/two');
    await userEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(calls.find(([u]) => u === '/api/sessions/terminal')![1]).toEqual({ repo: 'acme/two' });
    await waitFor(() => expect(term.written).toEqual(['hello\r\n', '\r\n[exited: 0]\r\n']));
    expect(calls).toContainEqual(['/api/sessions/input', { id: running.id, cols: 120, rows: 32 }]);
    term.type('ls\r');
    expect(calls).toContainEqual(['/api/sessions/input', { id: running.id, data: 'ls\r' }]);
  });

  it('a refusal is shown; without node-pty (F ui in a browser) there is no New terminal', async () => {
    serve((url) => (url === '/api/sessions/stop' ? new Response(JSON.stringify({ error: 'no running session with that id' }), { status: 400 }) : undefined));
    sheet(false);
    expect(screen.queryByRole('button', { name: 'New terminal' })).toBeNull();
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0]!).queryByRole('button', { name: 'Resume' })).toBeNull();
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('no running session with that id')).toHaveAttribute('data-bad');
  });

  it('the header offers Sessions only under F ui (a token)', async () => {
    const data = state as unknown as FactoryData;
    const { unmount } = render(<App load={async () => data} />);
    await screen.findByRole('tab', { name: /All/ });
    expect(screen.queryAllByRole('button', { name: 'Sessions' })).toEqual([]);
    unmount();
    serve();
    render(<App load={async () => ({ ...data, token: 'tok', terminal: true })} />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Sessions' }))[0]!); // the header's, and a phone's above the board (CSS picks)
    expect(await screen.findByRole('dialog', { name: 'Sessions' })).toBeTruthy();
  });
});
