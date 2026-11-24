import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { App } from '../src/App.tsx';
import { normData, type FactoryData } from '../src/data.ts';
import { RunDetail, openInClaude } from '../src/RunDetail.tsx';

const data = normData(state as unknown as FactoryData);
const run = (id: string) => data.runs.find((r) => r.id === id)!;
const wide = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('1100'), addEventListener() {}, removeEventListener() {} }));

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); history.replaceState(null, '', '/'); });

describe('board parity with dashboard.html', () => {
  it('shows rule chips (expired first), the rule log, the idea project and a Done toggle', async () => {
    render(<App load={async () => data} />);
    const rules = await screen.findByRole('group', { name: 'Active rules' });
    expect([...rules.querySelectorAll('.sf-badge')].map((x) => x.textContent)).toEqual(['shop: Expired: Diff cap 800 · Large refactor week', 'shop: CI advisory · GitHub Actions billing is…', 'all: Local checks ×2 · Run checks locally']);
    expect(screen.getByRole('region', { name: 'Rule changes' })).toHaveTextContent('set ci = "advisory" · acme/shop · by dev');
    const idea = screen.getByRole('region', { name: 'Project acme/budget' });
    expect(within(idea).getByText('Loop running')).toBeTruthy();
    expect(within(idea).getByRole('region', { name: 'Dependency order' })).toHaveTextContent('after #2');
    const toggle = screen.getByRole('button', { name: 'Done' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem('sf.doneOpen')).toBe('0');
  });

  it('a link to a run opens it on a wide screen, and re-clicking the selected card reopens a hidden panel', async () => {
    wide(true);
    history.replaceState(null, '', '/#' + encodeURIComponent('acme/shop#43'));
    render(<App load={async () => data} />);
    const panel = await screen.findByRole('complementary');
    expect(within(panel).getByRole('heading', { name: 'Add newsletter signup to footer' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: ']' });
    expect(screen.queryByRole('complementary')).toBeNull();
    const card = document.querySelector<HTMLAnchorElement>(`.web-board a[href="#${CSS.escape(encodeURIComponent('acme/shop#43'))}"]`)!;
    fireEvent.click(card);
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: 'Add newsletter signup to footer' })).toBeTruthy();
  });

  it('docks the run panel on wide screens: hash selection, Focus, keyboard resize, ] and Esc', async () => {
    wide(true);
    render(<App load={async () => data} />);
    await screen.findByRole('region', { name: /^Done/ });
    expect(screen.queryByRole('complementary')).toBeNull(); // closed until a run is chosen
    act(() => { location.hash = encodeURIComponent('acme/shop#43'); dispatchEvent(new HashChangeEvent('hashchange')); });
    const panel = await screen.findByRole('complementary'); // the hashchange listener attaches in an effect, which can land after the first paint
    expect(within(panel).getByRole('heading', { name: 'Add newsletter signup to footer' })).toBeTruthy();
    expect(document.title).toMatch(/Add newsletter signup to footer · Software Factory$/);
    await userEvent.click(within(panel).getByRole('button', { name: 'Focus' }));
    expect(panel).toHaveAttribute('data-focus');
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' }); // a manual width ends focus mode
    expect(panel).not.toHaveAttribute('data-focus');
    expect(Number(localStorage.getItem('sf.panelW'))).toBeGreaterThanOrEqual(420);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(location.hash).toBe('');
    expect(within(screen.getByRole('complementary')).getByText('Select a run')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: ']' });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show run panel (])' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('run detail parity', () => {
  it('shows runners with the used model, burn, deploys, a note and the sessions', () => {
    render(<RunDetail run={run('acme/shop#43')} cap={3} costCap={5} />);
    expect(screen.getByTitle('Run by the built-in brief on opus (high effort)')).toHaveTextContent('Opus');
    expect(screen.getByRole('img', { name: /^Tokens by stage: intake 18k, spec 52k, build 236k/ })).toBeTruthy();
    expect(screen.getByText(/Measured from session transcripts · subagents reported 301k/)).toBeTruthy();
    const deploy = screen.getByRole('heading', { name: 'Deploy' }).parentElement!;
    expect(within(deploy).getAllByRole('link', { name: /Open/ }).map((a) => a.getAttribute('href'))).toEqual(['https://shop.acme.dev', 'https://shop-git-newsletter-acme.vercel.app']);
    expect(screen.getByRole('link', { name: /Preview/ })).toHaveAttribute('href', 'https://shop-git-newsletter-acme.vercel.app');
    expect(screen.getByText('for build: Use the existing Button, not a new one.')).toBeTruthy();
  });

  it('links an escalated run to GitHub for review, never to an approve action', () => {
    render(<RunDetail run={run('acme/shop#44')} cap={3} costCap={5} />);
    expect(screen.getByRole('link', { name: /Review and merge on GitHub/ })).toHaveAttribute('href', 'https://github.com/acme/shop/pull/91');
    expect(screen.queryByRole('button', { name: /approve|merge/i })).toBeNull();
  });

  it('renders https links only, and Open in Claude only for a safe worktree path', () => {
    render(<RunDetail run={{ ...run('acme/shop#45'), pr: 'javascript:alert(1)', url: 'http://x' }} cap={3} costCap={5} />);
    expect(screen.queryByRole('link', { name: /Pull request|Issue/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open in Claude' }).getAttribute('href'))
      .toBe("claude-cli://open?cwd=%2Fhome%2Fdev%2FDevelopment%2Facme%2Fshop%2F.worktrees%2Fissue-45&q=Continue%20factory%20run%20acme%2Fshop%2345.%20Run%20F%20state%20'acme%2Fshop%2345'%20first.");
    const r = run('acme/shop#45');
    expect(openInClaude({ ...r, worktree: '/a/../b', sessions: [] })).toBeNull();
    expect(openInClaude({ ...r, worktree: '//server/share', sessions: [] })).toBeNull();
    expect(openInClaude({ ...r, id: "a/b#1'; rm" })).toBeNull();
  });
});
