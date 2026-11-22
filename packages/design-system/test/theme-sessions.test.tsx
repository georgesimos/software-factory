import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionLink, SessionList, SessionsChip, ThemeToggle, resumeCommand, themeInitScript } from '../src/index.ts';

afterEach(() => { delete document.documentElement.dataset.theme; localStorage.clear(); });

describe('ThemeToggle', () => {
  it('sets data-theme, persists the choice, and "system" clears it', async () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    await userEvent.click(screen.getByText('Dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('sf.theme')).toBe('dark');
    await userEvent.keyboard('{ArrowRight}'); // radio group: arrows wrap to System
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('init script applies the stored theme before React mounts', () => {
    localStorage.setItem('sf.theme', 'light');
    new Function(themeInitScript)();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('Sessions', () => {
  it('builds resume commands and quotes hostile paths', () => {
    expect(resumeCommand({ agent: 'codex', id: 'abc-123' })).toBe('codex resume abc-123');
    expect(resumeCommand({ agent: 'claude-code', id: 'a1b2', cwd: '/home/dev/acme shop' })).toBe('cd "/home/dev/acme shop" && claude --resume a1b2');
    expect(resumeCommand({ agent: 'claude-code', id: 'x;rm', cwd: '/tmp/$(boom)"`' })).toBe('cd "/tmp/\\$(boom)\\"\\`" && claude --resume "x;rm"');
  });

  it('SessionLink copies the resume command and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<SessionLink session={{ agent: 'claude-code', id: '0f3c9a7e-1111', cwd: '/home/dev/acme/app', last: new Date().toISOString() }} />);
    expect(screen.getByText('0f3c9a7e')).toBeInTheDocument();
    expect(screen.getByText(/just now · app/)).toBeInTheDocument();
    await act(() => userEvent.click(screen.getByRole('button', { name: 'Copy resume command' })));
    expect(writeText).toHaveBeenCalledWith('cd "/home/dev/acme/app" && claude --resume 0f3c9a7e-1111');
    expect(screen.getByRole('button', { name: 'Copied resume command' })).toBeInTheDocument();
  });

  it('SessionList sorts newest first; SessionsChip counts', () => {
    const ss = [{ agent: 'codex', id: 'old', last: '2026-11-01T00:00:00Z' }, { agent: 'claude-code', id: 'new', last: '2026-11-20T00:00:00Z' }];
    render(<><SessionList sessions={ss} /><SessionsChip sessions={ss} /></>);
    expect(screen.getAllByRole('listitem').map((li) => li.querySelector('code')?.textContent)).toEqual(['new', 'old']);
    expect(screen.getByText('2 sessions')).toBeInTheDocument();
  });
});
