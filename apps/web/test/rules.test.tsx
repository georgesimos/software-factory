import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { normData, type FactoryData } from '../src/data.ts';
import { RuleChips, fitCount } from '../src/Rules.tsx';

const data = normData(state as unknown as FactoryData);
afterEach(() => { vi.restoreAllMocks(); });

describe('rule chips on one row (#9)', () => {
  it('fitCount keeps room for the +N chip only when not everything fits', () => {
    expect(fitCount([100, 100, 100], 320, 6, 30)).toBe(3); // 312: all fit, no +N
    expect(fitCount([100, 100, 100], 300, 6, 30)).toBe(2); // 30 + 106 + 106 = 242, a third would be 348
    expect(fitCount([100, 100, 100], 130, 6, 30)).toBe(0); // not even one beside the +N chip
    expect(fitCount([], 0, 6, 30)).toBe(0);
  });

  it('chips that do not fit collapse into a focusable +N chip that names them; each chip shows its full rule on focus', async () => {
    // jsdom has no layout: every chip is 100px, the +N chip 30px, the header has 250px.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(250);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { width: this.textContent?.startsWith('+') ? 30 : 100 } as DOMRect;
    });
    render(<RuleChips data={data} project="" today="2026-11-24" />);
    const row = screen.getByRole('group', { name: 'Active rules' });
    expect([...row.querySelectorAll('.sf-badge')].map((x) => x.textContent))
      .toEqual(['shop: Expired: Diff cap 800 · Large refactor week', 'shop: CI advisory · GitHub Actions billing is…', '+1']); // warnings first: never the hidden one
    const more = within(row).getByRole('button', { name: '1 more rule: all: Local checks ×2 · Run checks locally' });
    fireEvent.focus(more);
    await waitFor(() => expect(document.getElementById(more.getAttribute('aria-describedby') ?? '')).toHaveAttribute('data-open'));
    fireEvent.blur(more);
    const chip = within(row).getByText('shop: CI advisory · GitHub Actions billing is…');
    expect(chip).toHaveAttribute('tabindex', '0');
    const tip = document.getElementById(chip.getAttribute('aria-describedby') ?? '');
    expect(tip?.textContent).toMatch(/^ci="advisory" for acme\/shop, set by dev on 2026-11-18: GitHub Actions billing is failing\. Until 2099-01-01/);
    fireEvent.focus(chip);
    await waitFor(() => expect(tip).toHaveAttribute('data-open'));
  });

  it('everything fits: no +N chip', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: 100 }) as DOMRect);
    render(<RuleChips data={data} project="" today="2026-11-24" />);
    expect(within(screen.getByRole('group', { name: 'Active rules' })).queryByRole('button')).toBeNull();
  });
});
