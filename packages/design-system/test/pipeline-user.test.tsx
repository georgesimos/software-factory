import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PipelineGraph, pipelineGraph, runOverlay, slotProblems, type Pipeline, type RunEvent } from '../src/index.ts';
import BASELINE from './pipeline-graph.baseline.json';

// The user's own steps (a design not in docs/plans/pipelines.md yet): slots before spec, build, review and merge; a step
// ends in an outcome, and `next` sends each outcome on.
const P: Pipeline = {
  host: 'github', tracker: 'github-issues', locked: ['intake', 'spec', 'build', 'review.code', 'review.security', 'verifier', 'gate', 'merge', 'watch'],
  optional: ['review.ui', 'review.docs'], steps: ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch'],
  intake: ['pass', 'split', 'needs-info', 'reject'], loops: ['spec', 'build'],
  axes: [{ axis: 'code', when: 'always' }, { axis: 'security', when: 'always' }, { axis: 'ui', when: 'ui' }, { axis: 'docs', when: 'docs' }], off: [], custom: {}, warnings: [],
};
const U: Pipeline = {
  ...P,
  beforeBuild: { first: 'plan', steps: [{ id: 'plan', kind: 'step', label: 'Write a plan', next: { passed: 'build', failed: 'escalate' } }] },
  beforeReview: { first: 'lint', steps: [
    { id: 'lint', kind: 'check', label: 'Lint', run: 'pnpm lint', next: { passed: 'types', failed: 'build' } },
    { id: 'types', kind: 'check', label: 'Typecheck', run: 'pnpm typecheck', next: { passed: 'review', failed: 'build' } },
  ] },
  beforeMerge: { first: 'oncall', steps: [{ id: 'oncall', kind: 'human', label: 'On-call approves', next: { approved: 'merge', rejected: 'escalate' } }] },
};
const G = pipelineGraph(U), col = (id: string) => G.nodes.find((n) => n.id === id)!.col;
const edge = (from: string, to: string) => G.edges.find((e) => e.from === from && e.to === to);

describe('pipelineGraph with the user’s own steps', () => {
  it('without any slot, draws exactly what it drew before', () => {
    expect(JSON.parse(JSON.stringify(pipelineGraph(P)))).toEqual(BASELINE);
  });
  it('puts each slot between its stages, with an outcome on every branch and one escalate exit', () => {
    expect(col('spec')).toBeLessThan(col('user:plan'));
    expect(col('user:plan')).toBeLessThan(col('build'));
    expect(col('user:lint')).toBeLessThan(col('user:types'));
    expect(col('user:types')).toBeLessThan(col('review.code'));
    expect(col('gate')).toBeLessThan(col('user:oncall'));
    expect(col('user:oncall')).toBeLessThan(col('merge'));
    expect(edge('spec', 'build')).toBeUndefined();
    expect(edge('build', 'review.code')).toBeUndefined();
    expect(edge('gate', 'merge')).toBeUndefined();
    expect(edge('spec', 'user:plan')).toEqual({ from: 'spec', to: 'user:plan' });
    expect(edge('user:plan', 'build')).toEqual({ from: 'user:plan', to: 'build', label: 'passed' });
    expect(edge('user:lint', 'user:types')).toEqual({ from: 'user:lint', to: 'user:types', label: 'passed' });
    expect(edge('user:lint', 'build')).toEqual({ from: 'user:lint', to: 'build', label: 'failed', loop: true });
    expect(edge('user:types', 'review.docs')).toEqual({ from: 'user:types', to: 'review.docs', label: 'passed' });
    expect(edge('user:oncall', 'escalate')).toEqual({ from: 'user:oncall', to: 'escalate', label: 'rejected' });
    expect(G.nodes.filter((n) => n.id === 'escalate')).toHaveLength(1);
    expect(G.nodes.find((n) => n.id === 'user:lint')).toMatchObject({ kind: 'user', label: 'Lint', sub: 'shell check', locked: false, slot: 'beforeReview' });
  });
  it('joins two outcomes that go to the same place into one labelled edge', () => {
    const g = pipelineGraph({ ...P, beforeSpec: { first: 'note', steps: [{ id: 'note', kind: 'step', next: { passed: 'spec', failed: 'spec' } }] } });
    expect(g.edges.filter((e) => e.from === 'user:note')).toEqual([{ from: 'user:note', to: 'spec', label: 'passed, failed' }]);
    expect(g.edges).toContainEqual({ from: 'intake', to: 'user:note', label: 'pass' });
  });
  it('a user id never collides with F’s own nodes', () => {
    const g = pipelineGraph({ ...P, beforeSpec: { first: 'gate', steps: [{ id: 'gate', kind: 'step', next: { passed: 'spec', failed: 'escalate' } }] } });
    expect(g.nodes.filter((n) => n.id === 'gate')).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === 'user:gate')).toMatchObject({ kind: 'user', label: 'gate' });
  });
});

describe('slotProblems', () => {
  const one = (slot: 'beforeSpec' | 'beforeBuild', ...steps: NonNullable<Pipeline['beforeSpec']>['steps']) => slotProblems({ ...P, [slot]: { first: steps[0]!.id, steps } });
  it('has none for a valid pipeline', () => { expect(slotProblems(U)).toEqual([]); });
  it('refuses a branch that skips a stage, a missing outcome, a check with no command, a bad id, a repeated id and a circle', () => {
    expect(one('beforeSpec', { id: 'a', kind: 'step', next: { passed: 'merge', failed: 'escalate' } })).toEqual(['Before spec: “a” can’t go to “merge” when passed']);
    expect(one('beforeSpec', { id: 'a', kind: 'step', next: { passed: 'build', failed: 'escalate' } })).toEqual(['Before spec: “a” can’t go to “build” when passed']); // build is after spec: not a loop-back
    expect(one('beforeBuild', { id: 'a', kind: 'human', next: { approved: 'build' } })).toEqual(['Before build: “a” has nowhere to go when rejected']);
    expect(one('beforeBuild', { id: 'a', kind: 'check', next: { passed: 'build', failed: 'spec' } })).toEqual(['Before build: the check “a” has no command']);
    expect(one('beforeBuild', { id: 'A b', kind: 'step', next: { passed: 'build', failed: 'escalate' } })).toEqual(['Before build: “A b” must be lowercase letters, digits and dashes']);
    expect(slotProblems({ ...P, beforeSpec: { first: 'x', steps: [] } })).toEqual(['Before spec: the first step “x” isn’t one of its steps']);
    expect(slotProblems({ ...U, beforeSpec: { first: 'lint', steps: [{ id: 'lint', kind: 'step', next: { passed: 'spec', failed: 'spec' } }] } })).toEqual(['Before review: “lint” is used twice']);
    expect(one('beforeBuild', { id: 'a', kind: 'step', next: { passed: 'b', failed: 'escalate' } }, { id: 'b', kind: 'step', next: { passed: 'a', failed: 'build' } }))
      .toEqual(['Before build: its steps go round in a circle; loop back to spec or build instead']);
  });
});

let t = Date.parse('2026-11-20T09:00:00Z');
const e = (stage: string, status: string, p: Partial<RunEvent> = {}): RunEvent => ({ ts: new Date((t += 60_000)).toISOString(), run: 'acme/shop#9', stage, status, ...p });
const step = (id: string, outcome: string, p: Partial<RunEvent> = {}) => [e('step', 'started', { step: id }), e('step', outcome, { step: id, ...p })];
const pass = (...axes: string[]) => axes.map((axis) => e('review', 'passed', { axis, findings: [] }));
const status = (o: ReturnType<typeof runOverlay>) => Object.fromEntries(Object.entries(o.steps).map(([k, v]) => [k, v.status]));
// Typecheck fails once and loops back to build; the second time through, on-call approves and it merges.
const RUN = [
  e('intake', 'started'), e('intake', 'passed'), e('spec', 'passed'), ...step('plan', 'passed'), e('build', 'started'), e('build', 'passed'),
  ...step('lint', 'passed'), ...step('types', 'failed', { tokens: 50 }),
  e('build', 'started'), e('build', 'passed'), ...step('lint', 'passed'), ...step('types', 'passed'),
  e('review', 'started', { axes: ['code', 'security'] }), ...pass('code', 'security'), e('gate', 'passed', { next: 'approve' }),
  ...step('oncall', 'approved'), e('approve', 'decided', { action: 'merge' }), e('approve', 'merged'),
];

describe('runOverlay with the user’s own steps', () => {
  it('reads each step’s events: its outcome, the branch it took, and a loop-back it sent', () => {
    const atFail = runOverlay(G, RUN.slice(0, RUN.findIndex((x) => x.step === 'types' && x.status === 'failed') + 1));
    expect(status(atFail)).toMatchObject({ 'user:plan': 'passed', 'user:lint': 'passed', 'user:types': 'failed', build: 'running' });
    expect(atFail.steps.build!.note).toBe('sent back by Typecheck');
    expect(atFail.steps['user:types']).toMatchObject({ tokens: 50, ms: 60_000 });
    expect(atFail.loops).toEqual({ build: 1 });
    const o = runOverlay(G, RUN);
    expect(status(o)).toMatchObject({ 'user:lint': 'passed', 'user:types': 'passed', 'user:oncall': 'passed', merge: 'passed', escalate: 'pending' });
    expect(o.steps['user:oncall']!.note).toBe('approved');
    expect(o.loops).toEqual({ build: 1 });
    expect(o.taken).toEqual(expect.arrayContaining(['spec>user:plan', 'user:plan>build', 'build>user:lint', 'user:lint>user:types', 'user:types>review.code', 'gate>user:oncall', 'user:oncall>merge']));
    expect(o.taken).not.toContain('user:plan>escalate');
    expect(o.taken).not.toContain('user:oncall>escalate');
    expect(o.taken).not.toContain('user:types>review.ui'); // only the axes that ran
  });
  it('an escalation from a person’s step lights the escalate exit, not the merge', () => {
    const o = runOverlay(G, [...RUN.slice(0, RUN.findIndex((x) => x.step === 'oncall')), ...step('oncall', 'rejected'), e('approve', 'escalated')]);
    expect(status(o)).toMatchObject({ 'user:oncall': 'failed', escalate: 'passed', merge: 'pending' });
    expect(o.steps['user:oncall']!.note).toBe('rejected');
    expect(o.taken).toContain('user:oncall>escalate');
    expect(o.taken).not.toContain('user:oncall>merge');
  });
});

describe('PipelineGraph draws and opens the user’s steps', () => {
  it('a step is a button whose panel shows its kind, its slot, its command and where each outcome goes', () => {
    render(<PipelineGraph name="acme/shop" pipeline={U} cap={3} costCap={5} />);
    const graph = screen.getByRole('list', { name: 'acme/shop pipeline' });
    expect(within(graph).getByRole('listitem', { name: 'Escalate to you' })).toBeInTheDocument();
    fireEvent.click(within(graph).getByRole('button', { name: 'Lint' }));
    const panel = screen.getByRole('complementary', { name: 'Lint step' });
    expect(panel).toHaveTextContent('Yours');
    expect(within(panel).getByText('shell check')).toBeInTheDocument();
    expect(within(panel).getByText('Before review')).toBeInTheDocument();
    expect(within(panel).getByText('pnpm lint').tagName).toBe('CODE');
    expect(within(panel).getByRole('list', { name: 'Outcomes' })).toHaveTextContent('passed → Typecheckfailed → back to Build');
  });
  it('the about panel counts them, and a problem shows as a warning', () => {
    render(<PipelineGraph name="acme/shop" pipeline={{ ...U, beforeSpec: { first: 'x', steps: [] } }} cap={3} costCap={5} />);
    expect(screen.getByText('Your steps: 4')).toBeInTheDocument();
    expect(screen.getByText('Before spec: the first step “x” isn’t one of its steps')).toBeInTheDocument();
    expect(screen.getByText(/^1 warning ·/)).toBeInTheDocument();
  });
});
