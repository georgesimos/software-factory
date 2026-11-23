import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import type { SkillsData } from '../src/data.ts';
import { SkillsSheet } from '../src/Skills.tsx';
import { editStep, keepModel, pickResult, presetCommand, skillCommand } from '../src/skillsModel.ts';

const S = state.skills as unknown as SkillsData; // default sets review.code {opus, high} and an a11y axis; acme/shop sets build {sonnet}
const F = 'node ~/.claude/skills/software-factory/factory.mjs';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('skills rules (ported from dashboard.html)', () => {
  it('a new model keeps effort and resets fallback; inheriting the model drops effort; a bare default unsets', () => {
    expect(editStep(S, 'default', 'review.code', 'model', 'sonnet')).toEqual({ use: 'default', effort: 'high', model: 'sonnet' });
    expect(editStep(S, 'default', 'review.code', 'model', '')).toBeNull();
    expect(editStep(S, 'default', 'spec', 'effort', 'max')).toEqual({ use: 'default', effort: 'max' });
    expect(editStep(S, 'default', 'spec', 'fallback', 'opus,sonnet')).toEqual({ use: 'default', fallback: ['opus', 'sonnet'] });
  });
  it('a project step it does not set starts from the global one', () => {
    expect(editStep(S, 'acme/shop', 'review.code', 'effort', 'low')).toEqual({ use: 'default', model: 'opus', effort: 'low' });
    expect(editStep(S, 'acme/shop', 'build', 'model', 'opus')).toEqual({ use: 'default', model: 'opus' });
  });
  it('a new runner keeps the step’s model, effort and fallback, unless it moves to another harness', () => {
    const old = { use: 'default', model: 'opus', effort: 'high', fallback: ['sonnet'] };
    expect(keepModel(old, { use: 'skill', name: 'x' })).toEqual({ use: 'skill', name: 'x', model: 'opus', effort: 'high', fallback: ['sonnet'] });
    expect(keepModel(old, { use: 'provider', harness: 'codex' })).toEqual({ use: 'provider', harness: 'codex' });
    expect(keepModel({ use: 'provider', harness: 'claude-code', name: 'a', model: 'haiku' }, { use: 'provider', harness: 'claude-code', name: 'b' })).toEqual({ use: 'provider', harness: 'claude-code', name: 'b', model: 'haiku' });
    expect(keepModel(undefined, { use: 'skill', name: 'x' })).toEqual({ use: 'skill', name: 'x' });
  });
  it('builds the CLI command with every argument single-quoted', () => {
    expect(skillCommand('default', 'spec', { use: 'skill', name: "it's" })).toBe(`${F} skills set 'default' 'spec' '{"use":"skill","name":"it'\\''s"}'`);
    expect(skillCommand('acme/shop', 'build', null)).toBe(`${F} skills unset 'acme/shop' 'build'`);
    expect(presetCommand('all-claude-lean', 'default')).toBe(`${F} skills preset 'all-claude-lean' 'default'`);
  });
  it('checks a picked runner and an extra axis before saving', () => {
    expect(pickResult({ runner: null })).toMatch(/Pick a runner/);
    const skill = { use: 'skill', name: 'a11y-review' };
    expect(pickResult({ runner: skill, axis: { name: 'A11y', globs: '**/*.tsx' } })).toMatch(/lowercase/);
    expect(pickResult({ runner: skill, axis: { name: 'a11y', globs: ' , ' } })).toMatch(/file pattern/);
    expect(pickResult({ runner: { use: 'default' }, axis: { name: 'a11y', globs: '*.tsx' } })).toMatch(/no built-in brief/);
    expect(pickResult({ runner: skill, axis: { name: 'perf', globs: 'src/**, *.ts' } })).toEqual({ runner: skill, axis: 'perf', when: ['src/**', '*.ts'] });
  });
});

const sheet = (p: Partial<Parameters<typeof SkillsSheet>[0]> = {}) =>
  <SkillsSheet open onClose={() => {}} skills={S} harnesses={state.harnesses} onSaved={() => {}} {...p} />;

describe('Skills sheet', () => {
  it('read-only: a change copies the command instead of saving', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(sheet());
    expect(screen.getByText(/Read-only page/)).toBeTruthy();
    expect(screen.getByRole('row', { name: /Review · code/ })).toHaveTextContent('set globally');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Model for Spec' }), 'opus');
    const cmd = `${F} skills set 'default' 'spec' '{"use":"default","model":"opus"}'`;
    expect(writeText).toHaveBeenCalledWith(cmd);
    expect(screen.getByRole('status')).toHaveTextContent('Command copied.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('live: saves through POST /api/skills with the token, applies a preset, and shows the reply', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      const body = url.endsWith('/preset') ? { ...S, applied: ['intake', 'spec'], skipped: [], inherited: [] } : S;
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const onSaved = vi.fn();
    render(sheet({ token: 'tok', onSaved }));
    expect(screen.getByText(/Live: changes save/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Effort for Build' }), 'max');
    expect(calls[0]![0]).toBe('/api/skills');
    expect(calls[0]![1].headers).toMatchObject({ 'content-type': 'application/json', 'x-factory-token': 'tok' });
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ scope: 'default', step: 'build', runner: { use: 'default', effort: 'max' } });
    expect(onSaved).toHaveBeenCalledWith(S);
    await userEvent.click(screen.getByRole('button', { name: /Apply all-claude-lean/ }));
    expect(calls[1]![0]).toBe('/api/skills/preset');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ name: 'all-claude-lean', scope: 'default' });
    expect(screen.getByRole('status')).toHaveTextContent('Applied all-claude-lean to 2 steps.');
  });

  it('shows the server’s error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'effort must be one of low|high' }), { status: 400 })));
    render(sheet({ token: 'tok' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Effort for Spec' }), 'low');
    expect(screen.getByRole('status')).toHaveTextContent('effort must be one of low|high');
  });

  it('a project shows what it sets, what it takes from global, and the global axes read-only', async () => {
    render(sheet({ scope: 'acme/shop' }));
    expect(screen.getByRole('tab', { name: 'acme/shop' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('row', { name: /Build/ })).toHaveTextContent('set for this project');
    expect(screen.getByRole('button', { name: 'Use the global runner for Build' })).toBeTruthy();
    expect(screen.getByRole('row', { name: /Review · code/ })).toHaveTextContent('from global');
    expect(within(screen.getByRole('region', { name: 'Extra review axes' })).getByText('from global')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove the a11y axis' })).toBeNull();
  });

  it('the picker searches, keeps its state when new data arrives, and saves the picked runner', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { rerender } = render(sheet());
    await userEvent.click(screen.getByRole('button', { name: 'Change runner for Build' }));
    const pk = screen.getByRole('dialog', { name: 'Runner for Build' });
    expect(within(pk).getByRole('radio', { name: /Factory default/ })).toBeChecked();
    await userEvent.type(within(pk).getByRole('searchbox', { name: 'Search runners' }), 'wcag');
    await userEvent.click(within(pk).getByRole('radio', { name: /a11y-review/ }));
    rerender(sheet({ skills: structuredClone(S) })); // a poll's fresh data
    const again = screen.getByRole('dialog', { name: 'Runner for Build' });
    expect(within(again).getByRole('searchbox', { name: 'Search runners' })).toHaveValue('wcag');
    expect(within(again).getByRole('radio', { name: /a11y-review/ })).toBeChecked();
    await userEvent.click(within(again).getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(`${F} skills set 'default' 'build' '{"use":"skill","name":"a11y-review"}'`);
  });

  it('Escape in the runner picker closes the picker only; a model the list lacks still shows', async () => {
    const onClose = vi.fn();
    render(sheet({ onClose, skills: { ...S, models: ['fable', 'sonnet', 'haiku'] } }));
    expect(screen.getByRole('combobox', { name: 'Model for Review · code' })).toHaveValue('opus');
    await userEvent.click(screen.getByRole('button', { name: 'Change runner for Build' }));
    fireEvent(screen.getByRole('dialog', { name: 'Runner for Build' }), new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog', { name: 'Runner for Build' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with an empty catalog (the Artifact), a skill by name still works; a new axis is checked first', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(sheet({ skills: { ...S, catalog: { global: [], projects: {} } } }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add axis' }));
    const pk = screen.getByRole('dialog', { name: 'Runner for New review axis' });
    expect(within(pk).getByText(/Nothing matches/)).toBeTruthy();
    await userEvent.type(within(pk).getByRole('textbox', { name: 'Skill name' }), 'perf-review');
    await userEvent.click(within(pk).getByRole('button', { name: 'Copy command' }));
    expect(within(pk).getByRole('status')).toHaveTextContent(/Axis name/);
    await userEvent.type(within(pk).getByRole('textbox', { name: 'Axis name' }), 'perf');
    await userEvent.type(within(pk).getByRole('textbox', { name: /Review it when/ }), 'src/**');
    await userEvent.click(within(pk).getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(`${F} skills set 'default' 'axes.extra' '${JSON.stringify([
      { axis: 'a11y', when: ['**/*.tsx'], use: 'skill', name: 'a11y-review' }, { axis: 'perf', when: ['src/**'], use: 'skill', name: 'perf-review' }])}'`);
  });
});
