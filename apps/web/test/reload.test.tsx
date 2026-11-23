import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { App } from '../src/App.tsx';
import type { FactoryData } from '../src/data.ts';

const data = state as unknown as FactoryData;
const flush = () => act(async () => {}); // the load promise, then React
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); document.querySelectorAll('dialog[data-test]').forEach((d) => d.remove()); });

describe('F render’s file re-reads itself; F ui polls', () => {
  it('file data with reload: one reload after the interval, no polling', async () => {
    const load = vi.fn(async () => ({ ...data, reload: 10_000 })), reload = vi.fn();
    render(<App load={load} reload={reload} />);
    await flush();
    act(() => { vi.advanceTimersByTime(9_999); });
    expect(reload).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(reload).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });

  it('never under an open dialog: re-armed until it closes', async () => {
    const reload = vi.fn();
    render(<App load={async () => ({ ...data, reload: 10_000 })} reload={reload} />);
    await flush();
    const d = document.body.appendChild(document.createElement('dialog'));
    d.setAttribute('open', ''); d.dataset.test = '';
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(reload).not.toHaveBeenCalled();
    d.removeAttribute('open');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('with a token (F ui): polls every 10 s and never reloads, even if the data names an interval', async () => {
    const load = vi.fn(async () => ({ ...data, token: 'tok', reload: 10_000 })), reload = vi.fn();
    render(<App load={load} reload={reload} />);
    await flush();
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the board and panel scroll and the focused card across the reload', async () => {
    const set: Record<string, number> = {};
    const spy = (p: 'scrollLeft' | 'scrollTop') => Object.defineProperty(HTMLElement.prototype, p, { configurable: true, get() { return set[`${this.className}.${p}`] ?? 0; }, set(v: number) { set[`${this.className}.${p}`] = v; } });
    spy('scrollLeft'); spy('scrollTop');
    try {
      const first = render(<App load={async () => ({ ...data, reload: 10_000 })} reload={() => {}} />);
      await flush();
      const card = document.querySelector<HTMLAnchorElement>('.web-board a[href]')!;
      document.querySelector('.web-board-wrap')!.scrollLeft = 340;
      card.focus();
      act(() => { vi.advanceTimersByTime(10_000); }); // saves the view, then "reloads"
      first.unmount();
      for (const k of Object.keys(set)) delete set[k];
      render(<App load={async () => ({ ...data, reload: 10_000 })} reload={() => {}} />);
      await flush();
      expect(document.querySelector('.web-board-wrap')!.scrollLeft).toBe(340);
      expect(document.activeElement?.getAttribute('href')).toBe(card.getAttribute('href'));
      expect(sessionStorage.getItem('sf.view')).toBeNull(); // used once
      expect(screen.getAllByRole('link').length).toBeGreaterThan(0);
    } finally { delete (HTMLElement.prototype as { scrollLeft?: number }).scrollLeft; delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop; }
  });
});
