import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Checkbox, Dialog, IconButton, Input, Select, Tabs, ToastProvider, Tooltip, useToast } from '../src/index.ts';

describe('basics', () => {
  it('Button clicks and shows its shortcut', async () => {
    const fn = vi.fn();
    render(<Button shortcut="⌘↵" onClick={fn}>Attach</Button>);
    await userEvent.click(screen.getByRole('button', { name: /attach/i }));
    expect(fn).toHaveBeenCalledOnce();
    expect(screen.getByText('⌘↵').tagName).toBe('KBD');
  });

  it('IconButton is named by its label', async () => {
    const fn = vi.fn();
    render(<IconButton label="Close" onClick={fn}>x</IconButton>);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it('Input takes text and exposes invalid state', async () => {
    render(<Input aria-label="Repo" invalid />);
    const el = screen.getByRole('textbox', { name: 'Repo' });
    await userEvent.type(el, 'acme/shop');
    expect(el).toHaveValue('acme/shop');
    expect(el).toHaveAttribute('aria-invalid', 'true');
  });

  it('Select changes value from the keyboard', async () => {
    const fn = vi.fn();
    render(<Select aria-label="Sort" onChange={(e) => fn(e.target.value)}><option value="new">Newest</option><option value="old">Oldest</option></Select>);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'old');
    expect(fn).toHaveBeenCalledWith('old');
  });

  it('Checkbox toggles via its label and supports indeterminate', async () => {
    const fn = vi.fn();
    render(<Checkbox label="Select all" indeterminate onChange={fn} />);
    const box = screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    await userEvent.click(screen.getByText('Select all'));
    expect(fn).toHaveBeenCalledOnce();
  });

  it('Tooltip shows on focus, describes its trigger, hides on Escape', async () => {
    render(<Tooltip content="Dismissed: constant URL"><button>finding</button></Tooltip>);
    const btn = screen.getByRole('button');
    act(() => btn.focus());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(btn).toHaveAttribute('aria-describedby', tip.id);
    expect(tip).toHaveAttribute('data-open');
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(tip).not.toHaveAttribute('data-open');
  });

  it('Dialog opens modally and closes on Escape (cancel) and the close button', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open={false} onClose={onClose} title="Attach">body</Dialog>);
    expect(screen.queryByText('body')).toBeNull();
    rerender(<Dialog open onClose={onClose} title="Attach">body</Dialog>);
    const dlg = screen.getByRole('dialog', { name: 'Attach' });
    expect(dlg).toHaveAttribute('open');
    fireEvent(dlg, new Event('cancel', { cancelable: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Tabs move selection with arrow keys and keep one tab stop', async () => {
    function T() {
      const [v, setV] = useState('all');
      return <Tabs label="Project" value={v} onChange={setV} items={[{ id: 'all', label: 'All' }, { id: 'acme/shop', label: 'shop' }, { id: 'acme/app', label: 'app' }]}>panel {v}</Tabs>;
    }
    render(<T />);
    const [all, shop] = screen.getAllByRole('tab');
    act(() => all!.focus());
    await userEvent.keyboard('{ArrowRight}');
    expect(shop).toHaveAttribute('aria-selected', 'true');
    expect(shop).toHaveFocus();
    expect(all).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('panel acme/shop');
    await userEvent.keyboard('{End}{ArrowRight}');
    expect(all).toHaveAttribute('aria-selected', 'true');
  });

  it('Toast announces, runs its action and dismisses', async () => {
    const undo = vi.fn();
    function Fire() { const toast = useToast(); return <button onClick={() => toast({ title: '3 projects attached', action: { label: 'Undo', onClick: undo }, duration: 0 })}>go</button>; }
    render(<ToastProvider><Fire /></ToastProvider>);
    await userEvent.click(screen.getByText('go'));
    const region = screen.getByRole('list', { name: 'Notifications' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('3 projects attached');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(region).not.toHaveTextContent('3 projects attached');
  });
});
