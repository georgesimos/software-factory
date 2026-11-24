import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { normData, type FactoryData } from '../src/data.ts';
import { RunDetail } from '../src/RunDetail.tsx';

const data = normData(state as unknown as FactoryData);
const run = data.runs.find((r) => r.id === 'acme/shop#45') ?? data.runs[0]; // two sessions: claude-code 0f3c9a7e…, codex 019a6f2e…
const CC = '0f3c9a7e-52d1-4c5e-9a43-7e1d2b6c8f10', CX = '019a6f2e-3b4c-7d8e-9f01-2a3b4c5d6e7f';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const rows = () => [...document.querySelectorAll('.sf-sessions > li')] as HTMLElement[];
const serve = (open: (body: { id: string; harness: string }) => Response, running: string[] = []) => {
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sessions') return new Response(JSON.stringify({ sessions: running.map((id) => ({ state: 'running', harnessSession: id })) }));
    const body = JSON.parse(String(init?.body));
    posts.push([url, (init?.headers as Record<string, string>)['x-factory-token'], body]);
    return open(body);
  }));
  return posts;
};

describe('Open in Claude on run-detail sessions (#22)', () => {
  it('posts the session id and harness; a desktop link opens, else the terminal resume command is shown to copy', async () => {
    const posts = serve((b) => new Response(JSON.stringify(b.id === CC ? { opened: true } : { resume: { command: `codex resume ${b.id}`, cwd: '/home/dev/shop' } })));
    render(<RunDetail run={run} cap={3} costCap={5} token="tok" />);
    const [cc, cx] = rows();
    await userEvent.click(within(cc).getByRole('button', { name: 'Open in Claude' }));
    expect(await within(cc).findByText('Opened in the Claude app.')).toBeTruthy();
    expect(within(cx).queryByRole('button', { name: 'Open in Claude' })).toBeNull(); // a Codex session can only resume in a terminal
    await userEvent.click(within(cx).getByRole('button', { name: 'Resume…' }));
    expect(await within(cx).findByText(/No desktop link for this session\. Resume it in a terminal in \/home\/dev\/shop:/)).toBeTruthy();
    expect(within(cx).getByText(`codex resume ${CX}`, { selector: '.web-ob-cmd code' })).toBeTruthy(); // the row's own tooltip has it too
    expect(within(cx).getByRole('button', { name: 'Copy command' })).toBeTruthy();
    expect(posts).toEqual([['/api/sessions/open', 'tok', { harness: 'claude-code', id: CC }], ['/api/sessions/open', 'tok', { harness: 'codex', id: CX }]]);
  });

  it('shows the refusal, and hides the button for a session this app is running', async () => {
    serve(() => new Response(JSON.stringify({ error: 'acme/shop#45 is claimed by pid 4242' }), { status: 400 }), [CX]);
    render(<RunDetail run={run} cap={3} costCap={5} token="tok" />);
    await waitFor(() => expect(within(rows()[1]).queryByRole('button', { name: 'Resume…' })).toBeNull());
    await userEvent.click(within(rows()[0]).getByRole('button', { name: 'Open in Claude' }));
    expect(await within(rows()[0]).findByText(/claimed by pid 4242/)).toHaveAttribute('data-bad');
  });

  it('re-reads the running sessions on every poll, so a session that crashed without an event gets its button back', async () => {
    const running = [CC];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessions: running.map((id) => ({ state: 'running', harnessSession: id })) }))));
    const { rerender } = render(<RunDetail run={run} cap={3} costCap={5} token="tok" />);
    await waitFor(() => expect(within(rows()[0]).queryByRole('button', { name: 'Open in Claude' })).toBeNull());
    running.length = 0; // it died; the run's events are unchanged
    rerender(<RunDetail run={{ ...run }} cap={3} costCap={5} token="tok" />); // the next poll's copy of the same run
    expect(await within(rows()[0]).findByRole('button', { name: 'Open in Claude' })).toBeTruthy();
  });

  it('no token: no Open button on any session row, and no request', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<RunDetail run={run} cap={3} costCap={5} />);
    expect(rows()).toHaveLength(2);
    for (const r of rows()) expect(within(r).queryByRole('button', { name: /Open in Claude|Resume…/ })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
