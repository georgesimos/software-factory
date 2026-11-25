import { fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PipelineGraph, pipelineGraph, runOverlay, type Pipeline, type Run, type RunEvent } from '../src/index.ts';

const P: Pipeline = {
  host: 'github', tracker: 'github-issues', locked: ['intake', 'spec', 'build', 'review.code', 'review.security', 'verifier', 'gate', 'merge', 'watch'],
  optional: ['review.ui', 'review.docs'], steps: ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch'],
  intake: ['pass', 'split', 'needs-info', 'reject'], loops: ['spec', 'build'],
  axes: [{ axis: 'code', when: 'always' }, { axis: 'security', when: 'always' }, { axis: 'ui', when: 'ui' }, { axis: 'docs', when: 'docs' }], off: [], custom: {}, warnings: [],
};
const G = pipelineGraph(P);
let t = Date.parse('2026-11-20T09:00:00Z');
const e = (stage: string, status: string, p: Partial<RunEvent> = {}): RunEvent => ({ ts: new Date((t += 60_000)).toISOString(), run: 'acme/shop#7', stage, status, ...p });
const pass = (...axes: string[]) => axes.map((axis) => e('review', 'passed', { axis, findings: [] }));
const high = (route: 'spec' | 'build') => [{ severity: 'high' as const, issue: 'x', route }];
const status = (o: ReturnType<typeof runOverlay>) => Object.fromEntries(Object.entries(o.steps).map(([k, v]) => [k, v.status]));

// A loop-back: UI review fails, the gate sends it back to build, the second pass merges. docs is never due: skipped.
const LOOP = [
  e('intake', 'started'), e('intake', 'passed'), e('spec', 'passed'),
  e('build', 'started'), e('build', 'passed', { tokens: 1200 }),
  e('review', 'started', { axes: ['code', 'security', 'ui'] }), ...pass('code', 'security'),
  e('review', 'failed', { axis: 'ui', tokens: 900, findings: [...high('build'), { severity: 'low', issue: 'y', route: 'build' }, { severity: 'medium', issue: 'z', route: 'build', dismissed: 'not real' }] }),
  e('review', 'passed', { role: 'verifier', tokens: 300 }), e('gate', 'failed', { next: 'build' }),
  e('build', 'started'), e('build', 'passed'),
  e('review', 'started', { axes: ['code', 'security', 'ui'] }), ...pass('code', 'security', 'ui'),
  e('gate', 'passed', { next: 'approve' }), e('approve', 'decided', { action: 'merge' }), e('approve', 'merged'),
];
// An escalation: security fails twice, the gate runs out of loops and hands it to a person.
const ESCALATE = [
  e('intake', 'started'), e('intake', 'passed'), e('spec', 'passed'), e('build', 'started'), e('build', 'passed'),
  e('review', 'started', { axes: ['code', 'security'] }), ...pass('code'), e('review', 'failed', { axis: 'security', findings: high('build') }),
  e('gate', 'failed', { next: 'build' }), e('build', 'started'), e('build', 'passed'),
  e('review', 'started', { axes: ['code', 'security'] }), ...pass('code'), e('review', 'failed', { axis: 'security', findings: high('build') }),
  e('gate', 'failed', { next: 'approve' }), e('approve', 'decided', { action: 'escalate' }), e('approve', 'escalated'),
];

describe('runOverlay (a run drawn on its pipeline, from its events only)', () => {
  it('a loop-back: counted on the gate’s edge, the last pass shown, the path lit, an optional axis never due skipped', () => {
    const o = runOverlay(G, LOOP);
    expect(o.loops).toEqual({ build: 1 });
    expect(status(o)).toMatchObject({ ready: 'passed', intake: 'passed', spec: 'passed', build: 'passed', 'review.code': 'passed', 'review.ui': 'passed',
      'review.docs': 'skipped', verifier: 'skipped', gate: 'passed', merge: 'passed', watch: 'pending', children: 'pending', ask: 'pending', close: 'pending' });
    expect(o.steps.verifier!.note).toMatch(/nothing blocking/); // the second pass had no blocking finding to verify
    expect(o.taken).toEqual(expect.arrayContaining(['ready>intake', 'intake>spec', 'spec>build', 'build>review.ui', 'review.ui>verifier', 'verifier>gate', 'gate>merge']));
    expect(o.taken).not.toContain('build>review.docs');
    expect(o.taken).not.toContain('intake>close');
    expect(o.taken).not.toContain('merge>watch'); // a passing check after the merge records nothing
  });
  it('mid-loop: the failure that sent it back, then the downstream steps reset while build runs again', () => {
    const atGate = runOverlay(G, LOOP.slice(0, LOOP.findIndex((x) => x.stage === 'gate') + 1));
    expect(status(atGate)).toMatchObject({ 'review.ui': 'failed', verifier: 'passed', gate: 'failed', build: 'running' });
    expect(atGate.steps.gate!.note).toBe('back to build');
    expect(atGate.steps['review.ui']!.review).toEqual({ verdict: 'failed', findings: 3, blocking: 1, dismissed: 1 });
    expect(atGate.steps['review.ui']).toMatchObject({ tokens: 900, ms: 3 * 60_000 }); // from review started to its verdict
    expect(atGate.steps.verifier!.tokens).toBe(300);
    const rebuilding = runOverlay(G, LOOP.slice(0, LOOP.findIndex((x) => x.stage === 'gate') + 2));
    expect(status(rebuilding)).toMatchObject({ build: 'running', 'review.ui': 'pending', verifier: 'pending', gate: 'pending', merge: 'pending' });
    expect(rebuilding.taken).toContain('build>review.ui'); // the path taken so far stays lit
  });
  it('an escalation: the review that blocked, the gate out of loops, and no merge', () => {
    const o = runOverlay(G, ESCALATE);
    expect(o.loops).toEqual({ build: 1 });
    expect(status(o)).toMatchObject({ 'review.security': 'failed', 'review.code': 'passed', 'review.ui': 'skipped', gate: 'failed', merge: 'failed', watch: 'pending' });
    expect(o.steps.gate!.note).toBe('to you');
    expect(o.steps.merge!.note).toBe('escalated to you');
    expect(o.steps.verifier).toMatchObject({ status: 'skipped', note: 'no record' }); // a blocking finding and no verifier record: never "nothing blocking"
    expect(o.taken).toContain('gate>merge');
    expect(Object.values(o.steps).some((s) => s.status === 'running')).toBe(false); // a finished run has nothing running
  });
  it('intake’s outcomes, a spec waiting for approval, a revert, and events for steps the graph doesn’t draw', () => {
    expect(runOverlay(G, [e('intake', 'started'), e('intake', 'rejected')]).taken).toEqual(['ready>intake', 'intake>close']);
    const asked = runOverlay(G, [e('intake', 'started'), e('intake', 'passed'), e('spec', 'awaiting-approval')]);
    expect(asked.steps.spec).toMatchObject({ status: 'running', note: 'waiting for approval' });
    const reverted = runOverlay(G, [...LOOP, e('approve', 'reverted')]);
    expect(reverted.steps.watch).toMatchObject({ status: 'failed', note: 'reverted' });
    const odd = runOverlay(G, [e('intake', 'started'), e('review', 'started', { axes: ['seo'] }), e('review', 'passed', { axis: 'seo' }), e('note', 'pending'), e('ship', 'passed')]);
    expect(odd.steps['review.seo']).toBeUndefined();
    expect(runOverlay(G, []).taken).toEqual([]);
    expect(status(runOverlay(G, [])).ready).toBe('pending');
  });
});

const run = (id: string, events: RunEvent[], p: Partial<Run> = {}): Run => ({ id, events, title: 'Fix the footer', outcome: 'merged', ...p });
describe('PipelineGraph run overlay', () => {
  it('“Show a run…” lists the runs; picking one marks each step, counts the loop-back and shows spend against the cap', () => {
    render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} runs={[run('acme/shop#7', LOOP, { costUsd: 1.25 }), run('acme/shop#8', ESCALATE, { outcome: 'escalated' })]} />);
    const pick = screen.getByRole('combobox', { name: 'Show a run' });
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Show a run…', '#7 · Fix the footer · Merged', '#8 · Fix the footer · Escalated']);
    fireEvent.change(pick, { target: { value: 'acme/shop#7' } });
    const graph = screen.getByRole('list', { name: 'acme/shop pipeline' });
    expect(within(graph).getByRole('listitem', { name: /^UI review/ })).toHaveAttribute('data-status', 'passed');
    expect(screen.getByRole('button', { name: /^Gate/ })).toHaveAccessibleName(/Passed/); // the status is read out, not only coloured
    expect(within(graph).getByRole('listitem', { name: /^Docs review/ })).toHaveTextContent('Skipped');
    expect(within(graph).getByRole('listitem', { name: /^Watch main/ })).toHaveTextContent('Not reached');
    expect(screen.getByText('×1')).toBeInTheDocument(); // on the gate → build loop-back
    expect(screen.getByText('#7 · Merged · $1.25 of $5 · 1 of 3 loops')).toBeInTheDocument();
    fireEvent.change(pick, { target: { value: '' } });
    expect(within(graph).getByRole('listitem', { name: /^UI review/ })).not.toHaveAttribute('data-status');
  });
});

describe('the step panel', () => {
  const edit = { for: vi.fn((step: string) => (step === 'build' ? { from: 'set for this project', model: { value: 'sonnet', inherit: 'Preset (opus)', options: ['opus', 'sonnet'] }, effort: { value: '', inherit: 'high', options: ['low', 'high'] } } : null)),
    onModel: vi.fn(), onEffort: vi.fn(), onRunner: vi.fn() };
  const graph = (p: Partial<Parameters<typeof PipelineGraph>[0]> = {}) => render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} edit={edit}
    plan={{ build: { use: 'brief', path: '/Users/someone/briefs/careful-build.md', model: 'sonnet', effort: 'high', fallback: ['opus', 'haiku'] }, 'review.ui': { use: 'provider', harness: 'codex' } }} {...p} />);

  it('opens on a node: label, locked, its runner without the path, and the model and effort the dashboard lists', () => {
    graph();
    fireEvent.click(screen.getByRole('button', { name: /^Build/ }));
    const panel = screen.getByRole('complementary', { name: 'Build step' });
    expect(panel).toHaveTextContent('Locked');
    expect(panel).toHaveTextContent('careful-build.md');
    expect(panel).not.toHaveTextContent('/Users/');
    expect(panel).toHaveTextContent('opus → haiku');
    expect(within(panel).getByText('set for this project')).toBeInTheDocument();
    const model = within(panel).getByRole('combobox', { name: 'Model for Build' });
    expect(within(model).getAllByRole('option').map((o) => o.textContent)).toEqual(['Preset (opus)', 'opus', 'sonnet']);
    fireEvent.change(model, { target: { value: 'opus' } });
    expect(edit.onModel).toHaveBeenCalledWith('build', 'opus');
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Effort for Build' }), { target: { value: 'low' } });
    expect(edit.onEffort).toHaveBeenCalledWith('build', 'low');
    fireEvent.click(within(panel).getByRole('button', { name: 'Change runner' }));
    expect(edit.onRunner).toHaveBeenCalledWith('build');
  });
  it('an optional axis shows its condition and harness; the gate is F’s own, read-only', () => {
    graph();
    fireEvent.click(screen.getByRole('button', { name: /^UI review/ }));
    const ui = screen.getByRole('complementary', { name: 'UI review step' });
    expect(ui).toHaveTextContent('Optional');
    expect(ui).toHaveTextContent('when UI files change');
    expect(ui).toHaveTextContent('codex');
    fireEvent.click(screen.getByRole('button', { name: /^Gate/ }));
    const gate = screen.getByRole('complementary', { name: 'Gate step' });
    expect(within(gate).queryByRole('combobox')).toBeNull();
    expect(within(gate).queryByRole('button', { name: 'Change runner' })).toBeNull();
    expect(gate).toHaveTextContent(/F’s own check, not a runner/);
  });
  it('Escape closes it and focus goes back to the node; the pipeline’s own panel returns', () => {
    graph();
    const node = screen.getByRole('button', { name: /^Spec/ });
    fireEvent.click(node);
    const panel = screen.getByRole('complementary', { name: 'Spec step' });
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Escape' })).toBe(false); // prevented: the sheet's <dialog> must not close too
    expect(screen.queryByRole('complementary', { name: 'Spec step' })).toBeNull();
    expect(document.activeElement).toBe(node);
    expect(screen.getByRole('complementary', { name: 'About this pipeline' })).toBeInTheDocument();
  });
  it('with a run shown, the step’s result for it: verdict, findings, tokens and time, read-only', () => {
    graph({ runs: [run('acme/shop#7', LOOP.slice(0, LOOP.findIndex((x) => x.stage === 'gate') + 1), { outcome: 'in-progress' })] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Show a run' }), { target: { value: 'acme/shop#7' } });
    fireEvent.click(screen.getByRole('button', { name: /^UI review/ }));
    const panel = screen.getByRole('complementary', { name: 'UI review step' });
    expect(panel).toHaveTextContent('In #7');
    expect(panel).toHaveTextContent('Failed');
    expect(panel).toHaveTextContent('3 findings · 1 blocking · 1 dismissed');
    expect(panel).toHaveTextContent('900 tokens');
    expect(panel).toHaveTextContent('3m');
  });
});

describe('moving around the canvas (n8n’s patterns: drag to pan, a map of the whole graph)', () => {
  const view = () => render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} runs={[run('acme/shop#7', ESCALATE, { outcome: 'escalated' })]} />).container;
  it('a mouse drag on the background pans; a drag from a step, or a touch, leaves the scroll alone', () => {
    const c = view(), scroll = c.querySelector('.sf-pl-scroll') as HTMLElement;
    expect(scroll.scrollTop).toBeGreaterThan(0); // it opens centred on the start, not on the top of the tall review column
    scroll.scrollTop = 0;
    fireEvent.pointerDown(scroll, { clientX: 300, clientY: 200, button: 0, pointerType: 'mouse', pointerId: 1 });
    fireEvent.pointerMove(scroll, { clientX: 260, clientY: 170, pointerId: 1, buttons: 1 });
    expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([40, 30]);
    fireEvent.pointerMove(scroll, { clientX: 0, clientY: 0, pointerId: 1, buttons: 0 }); // the button came up where no pointerup reached us: the drag ends
    fireEvent.pointerMove(scroll, { clientX: 0, clientY: 0, pointerId: 1, buttons: 1 });
    expect(scroll.scrollLeft).toBe(40);
    fireEvent.pointerUp(scroll, { pointerId: 1 });
    fireEvent.pointerDown(screen.getByRole('button', { name: /^Gate/ }), { clientX: 300, clientY: 200, button: 0, pointerType: 'mouse', pointerId: 2 });
    fireEvent.pointerMove(scroll, { clientX: 200, clientY: 100, pointerId: 2, buttons: 1 });
    fireEvent.pointerUp(scroll, { pointerId: 2 });
    fireEvent.pointerDown(scroll, { clientX: 300, clientY: 200, button: 0, pointerType: 'touch', pointerId: 3 }); // the platform scrolls a touch
    fireEvent.pointerMove(scroll, { clientX: 200, clientY: 100, pointerId: 3, buttons: 1 });
    expect(scroll.scrollLeft).toBe(40);
  });
  it('the map draws every step, in the run’s colours, and a click or drag on it moves the view there', () => {
    const c = view(), scroll = c.querySelector('.sf-pl-scroll') as HTMLElement, map = c.querySelector('svg.sf-pl-map') as SVGSVGElement;
    expect(map.querySelectorAll('rect[data-node]')).toHaveLength(pipelineGraph(P).nodes.length);
    fireEvent.change(screen.getByRole('combobox', { name: 'Show a run' }), { target: { value: 'acme/shop#7' } });
    expect(map.querySelector('rect[data-node="review.security"]')).toHaveAttribute('data-status', 'failed');
    const [, , gw] = map.getAttribute('viewBox')!.split(' ').map(Number), mw = Number(map.getAttribute('width'));
    fireEvent.pointerDown(map, { clientX: 80, clientY: 10, button: 0, pointerId: 4 });
    expect(scroll.scrollLeft).toBeCloseTo((80 / mw) * gw!, 0); // centred on that point (a zero-size view in jsdom)
    fireEvent.pointerMove(map, { clientX: 40, clientY: 10, pointerId: 4 });
    expect(scroll.scrollLeft).toBeCloseTo((40 / mw) * gw!, 0);
    fireEvent.pointerUp(map, { pointerId: 4 });
  });
});

describe('the overlay shows only what F recorded', () => {
  const start = [e('intake', 'started'), e('intake', 'passed'), e('spec', 'passed')];
  it('build opened is running while CI is pending, never passed', () => {
    const o = runOverlay(G, [...start, e('build', 'started'), e('build', 'opened', { pr: '12' })]);
    expect(o.steps.build).toMatchObject({ status: 'running', note: 'change request open, CI pending' });
  });
  it('spec decided is a person’s approval, not a pass', () => {
    const o = runOverlay(G, [e('intake', 'started'), e('intake', 'passed'), e('spec', 'awaiting-approval'), e('spec', 'decided', { decision: 'approve' })]);
    expect(o.steps.spec).toMatchObject({ status: 'running', note: 'approved by a person' });
  });
  it('the verifier passes only on passed', () => {
    const before = LOOP.slice(0, LOOP.findIndex((x) => x.role === 'verifier'));
    expect(runOverlay(G, [...before, e('review', 'failed', { role: 'verifier' })]).steps.verifier!.status).toBe('failed');
    expect(runOverlay(G, [...before, e('review', 'started', { role: 'verifier' })]).steps.verifier!.status).toBe('running');
  });
  it('an unknown status never shows as passed', () => {
    expect(runOverlay(G, [...start, e('build', 'started'), e('build', 'paused')]).steps.build).toMatchObject({ status: 'running', note: 'paused' });
  });
  it('a run resumed after needs-info, or reopened after a reject, runs again', () => {
    const asked = runOverlay(G, [e('intake', 'started'), e('intake', 'needs-info'), e('intake', 'started'), e('intake', 'passed'), e('spec', 'started')]);
    expect(status(asked)).toMatchObject({ intake: 'passed', spec: 'running' });
    const reopened = runOverlay(G, [e('intake', 'started'), e('intake', 'rejected'), e('intake', 'started'), e('intake', 'passed'), e('spec', 'started')]);
    expect(status(reopened)).toMatchObject({ intake: 'passed', spec: 'running' });
  });
  it('a rejected run: intake failed, with its outcome as the note', () => {
    expect(runOverlay(G, [e('intake', 'started'), e('intake', 'rejected')]).steps.intake).toMatchObject({ status: 'failed', note: 'rejected' });
  });
  it('build recorded twice (its checks, then its PR) adds up its tokens', () => {
    expect(runOverlay(G, [...start, e('build', 'started'), e('build', 'passed', { tokens: 100 }), e('build', 'passed', { tokens: 50 })]).steps.build!.tokens).toBe(150);
  });
  it('the gate sending a run back to spec resets build and every step after it', () => {
    const o = runOverlay(G, [...LOOP.slice(0, LOOP.findIndex((x) => x.stage === 'gate')), e('gate', 'failed', { next: 'spec' })]);
    expect(status(o)).toMatchObject({ spec: 'running', build: 'pending', 'review.ui': 'pending', verifier: 'pending', gate: 'pending' });
    expect(o.loops).toEqual({ spec: 1 });
  });
  it('archived runs (only their last events kept) are not offered; the footer counts F’s loop-backs and says when spend is unpriced', () => {
    render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} runs={[
      run('acme/shop#7', LOOP, { loopbacks: [{ iteration: 1, ts: 'x' }, { iteration: 2, ts: 'y' }] }), run('acme/shop#5', LOOP.slice(-5), { archived: true })]} />);
    const pick = screen.getByRole('combobox', { name: 'Show a run' });
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Show a run…', '#7 · Fix the footer · Merged']);
    fireEvent.change(pick, { target: { value: 'acme/shop#7' } });
    expect(screen.getByText('#7 · Merged · unpriced · cap $5 · 2 of 3 loops')).toBeInTheDocument();
  });
});

describe('the graph’s accessibility and ids', () => {
  it('a step button is named by everything on it: its label, “Locked”, its status and its runner', () => {
    render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} plan={{ build: { use: 'skill', name: 'fast-build', model: 'sonnet' } }} runs={[run('acme/shop#7', LOOP)]} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Show a run' }), { target: { value: 'acme/shop#7' } });
    expect(screen.getByRole('button', { name: /^Build/ })).toHaveAccessibleName('Build Locked Passed fast-build · sonnet');
  });
  it('two graphs on one page share no ids', () => {
    const { container } = render(<><PipelineGraph name="a" pipeline={P} cap={3} costCap={5} /><PipelineGraph name="b" pipeline={P} cap={3} costCap={5} /></>);
    const ids = [...container.querySelectorAll('[id]')].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    fireEvent.click(within(screen.getByRole('list', { name: 'a pipeline' })).getByRole('button', { name: /^Gate/ }));
    fireEvent.click(within(screen.getByRole('list', { name: 'b pipeline' })).getByRole('button', { name: /^Gate/ }));
    const panels = screen.getAllByRole('complementary', { name: 'Gate step' });
    expect(panels[0]!.id).not.toBe(panels[1]!.id);
  });
  it('opening a step tells the host, so it can clear the last save’s status', () => {
    const onOpen = vi.fn();
    render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} edit={{ for: () => null, onModel: vi.fn(), onEffort: vi.fn(), onRunner: vi.fn(), onOpen }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Gate/ }));
    expect(onOpen).toHaveBeenCalledWith('gate');
  });
  it('a step not reached or skipped keeps full-contrast text: dashed, never faded', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'factory', 'PipelineGraph.css'), 'utf8');
    const rule = css.split('\n').find((l) => l.includes('li[data-status="pending"]'))!;
    expect(rule).toContain('dashed');
    expect(rule).not.toMatch(/opacity/);
  });
});
