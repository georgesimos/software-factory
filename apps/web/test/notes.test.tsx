import type { Run } from '@software-factory/design-system';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunDetail } from '../src/RunDetail.tsx';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const R: Run = {
  id: 'acme/app#7', title: 'Seven', stage: 'build', outcome: 'in-progress',
  notes: [
    { id: 'n-1', step: 'next', text: '<b>keep</b> the old route', by: 'ana', ts: '2026-11-01T10:00:00Z', state: 'pending' },
    { id: 'n-0', step: 'next', text: 'already taken', by: 'ana', ts: '2026-11-01T09:00:00Z', state: 'applied' },
  ],
};
const box = () => screen.getByRole('heading', { name: 'Note for next step' }).parentElement as HTMLElement;

describe('Note for next step (#17)', () => {
  it('the static page lists pending notes read-only, as text', () => {
    render(<RunDetail run={R} cap={3} costCap={5} />);
    const b = box();
    expect(b.textContent).toMatch(/applies from the next step or iteration/i);
    const items = within(within(b).getByRole('list', { name: 'Pending notes' })).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.web-note-t')?.textContent)).toEqual(['<b>keep</b> the old route']); // applied notes left out
    expect(b.querySelector('b')).toBeNull(); // never HTML
    expect(within(b).queryByRole('textbox')).toBeNull();
    expect(within(b).queryByRole('button')).toBeNull();
  });

  it('no box on the static page when nothing is pending, nor under F ui for a finished or imported run', () => {
    const { unmount } = render(<RunDetail run={{ ...R, notes: [] }} cap={3} costCap={5} />);
    expect(screen.queryByRole('heading', { name: 'Note for next step' })).toBeNull();
    unmount();
    for (const r of [{ ...R, notes: [], outcome: 'merged' as const }, { ...R, notes: [], imported: true }]) {
      const { unmount: u } = render(<RunDetail run={r} cap={3} costCap={5} token="tok" />);
      expect(screen.queryByRole('heading', { name: 'Note for next step' })).toBeNull();
      u();
    }
  });

  it('under F ui: POST /api/note with the token, then the note is listed as pending', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ id: 'n-2', step: 'next', text: 'ship behind a flag', by: 'ana' }), { status: 200 });
    }));
    render(<RunDetail run={R} cap={3} costCap={5} token="tok" />);
    const b = box(), add = within(b).getByRole('button', { name: 'Add note' });
    expect((add as HTMLButtonElement).disabled).toBe(true); // nothing typed
    const ta = within(b).getByRole('textbox', { name: 'Note for the next step' });
    expect(ta.getAttribute('maxlength')).toBe('1000');
    await userEvent.type(ta, '  ship behind a flag ');
    await userEvent.click(add);
    expect(calls.map(([u, i]) => [u, i.method, (i.headers as Record<string, string>)['x-factory-token'], JSON.parse(String(i.body))]))
      .toEqual([['/api/note', 'POST', 'tok', { run: 'acme/app#7', text: '  ship behind a flag ' }]]);
    expect(await within(b).findByText('ship behind a flag')).toBeTruthy();
    expect((ta as HTMLTextAreaElement).value).toBe('');
    expect(within(b).getByRole('status').textContent).toMatch(/next step to start takes it/);
  });

  it('shows the server’s refusal and keeps the text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'acme/app#7 is merged: notes steer a running issue' }), { status: 400 })));
    render(<RunDetail run={R} cap={3} costCap={5} token="tok" />);
    const b = box(), ta = within(b).getByRole('textbox');
    await userEvent.type(ta, 'x');
    await userEvent.click(within(b).getByRole('button', { name: 'Add note' }));
    expect((await within(b).findByRole('status')).textContent).toMatch(/notes steer a running issue/);
    expect((ta as HTMLTextAreaElement).value).toBe('x');
  });
});
