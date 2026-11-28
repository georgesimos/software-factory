// Pipelines slice 5: custom steps drawn after spec and after build, a "+" on those connections only, a pipeline's added
// reviews marked, a custom step's removal requested with a reason, and a run's custom results on the graph.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PipelineGraph, pipelineGraph, runOverlay, type Pipeline } from '../src/index.ts';

const P: Pipeline = {
  host: 'git', tracker: 'local', locked: ['intake', 'spec', 'build', 'review.code', 'review.security', 'verifier', 'gate', 'merge', 'watch'],
  optional: ['review.ui'], steps: ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch'], intake: ['pass'], loops: ['spec', 'build'],
  axes: [{ axis: 'code', when: 'always' }, { axis: 'security', when: 'always' }, { axis: 'ux', when: 'always' }], off: [], warnings: [], on: ['review.ux'],
  custom: { 'spec.after': [{ id: 'lint', slot: 'spec.after', use: 'skill', name: 'spec-lint' }], 'build.after': [{ id: 'e2e', slot: 'build.after', use: 'skill', name: 'e2e', when: ['apps/web/**'] }, { id: 'smoke', slot: 'build.after', use: 'skill', name: 'smoke' }] },
};

describe('custom steps on the graph', () => {
  it('draws spec.after between spec and build and build.after between build and the reviews, in order', () => {
    const { nodes, edges } = pipelineGraph(P), e = edges.filter((x) => !x.loop).map((x) => `${x.from}>${x.to}`);
    expect(e).toEqual(expect.arrayContaining(['spec>custom.lint', 'custom.lint>build', 'build>custom.e2e', 'custom.e2e>custom.smoke', 'custom.smoke>review.code']));
    expect(e).not.toContain('spec>build');
    const c = nodes.find((n) => n.id === 'custom.e2e')!;
    expect([c.kind, c.label, c.sub, c.runner?.name]).toEqual(['custom', 'e2e', 'when apps/web/** change', 'e2e']);
    expect(nodes.find((n) => n.id === 'custom.lint')!.col).toBeLessThan(nodes.find((n) => n.id === 'build')!.col);
    expect(nodes.find((n) => n.id === 'review.ux')!.sub).toBe('added by this pipeline · every change');
  });
  it('a "+" only on the connections a custom step can go on, at the slots the host allows; it says where', () => {
    const onAdd = vi.fn();
    const { unmount } = render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} adds={{ slots: ['spec.after', 'build.after'], onAdd }} />);
    const plus = screen.getAllByRole('button', { name: /^Add a custom step/ }).map((b) => b.getAttribute('aria-label'));
    expect(plus).toEqual(['Add a custom step between Spec and lint', 'Add a custom step between lint and Build', 'Add a custom step between Build and e2e', 'Add a custom step between e2e and smoke', 'Add a custom step between smoke and Review']);
    fireEvent.click(screen.getByRole('button', { name: 'Add a custom step between e2e and smoke' }));
    expect(onAdd).toHaveBeenLastCalledWith('build.after', 1);
    fireEvent.click(screen.getByRole('button', { name: 'Add a custom step between Spec and lint' }));
    expect(onAdd).toHaveBeenLastCalledWith('spec.after', 0);
    unmount();
    render(<PipelineGraph name="acme/shop@hot" pipeline={{ ...P, custom: {} }} cap={3} costCap={5} adds={{ slots: ['build.after'], onAdd }} />);
    expect(screen.getAllByRole('button', { name: /^Add a custom step/ }).map((b) => b.getAttribute('aria-label'))).toEqual(['Add a custom step between Build and Review']);
  });
  it('no adds: no "+"', () => {
    render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} />);
    expect(screen.queryByRole('button', { name: /^Add a custom step/ })).toBeNull();
  });
  it('a custom step\'s panel removes it with a reason: the host only gets the request', () => {
    const onRemove = vi.fn(), edit = { for: () => null, onModel: vi.fn(), onEffort: vi.fn(), onRunner: vi.fn(), onRemove };
    render(<PipelineGraph name="acme/shop" pipeline={P} cap={3} costCap={5} edit={edit} />);
    fireEvent.click(screen.getByRole('button', { name: /^smoke/ }));
    const panel = screen.getByRole('complementary', { name: 'smoke step' });
    expect(panel).toHaveTextContent('Your custom step, after build');
    const rm = within(panel).getByRole('button', { name: 'Remove' });
    expect(rm).toBeDisabled();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Why remove smoke' }), { target: { value: 'flaky' } });
    fireEvent.click(rm);
    expect(onRemove).toHaveBeenCalledWith('smoke', 'flaky');
  });
  it('a run shows each custom step\'s result; a build loop-back keeps spec.after\'s and resets build.after\'s', () => {
    const g = pipelineGraph(P);
    const ev = [{ stage: 'intake', status: 'started' }, { stage: 'intake', status: 'passed' }, { stage: 'spec', status: 'started' }, { stage: 'spec', status: 'passed' },
      { stage: 'custom', status: 'started', slot: 'spec.after', ids: ['lint'] }, { stage: 'custom', status: 'passed', id: 'lint' },
      { stage: 'build', status: 'started' }, { stage: 'build', status: 'passed' },
      { stage: 'custom', status: 'started', slot: 'build.after', ids: ['smoke'] }, { stage: 'custom', status: 'failed', id: 'smoke' }];
    let o = runOverlay(g, ev);
    expect([o.steps['custom.lint']!.status, o.steps['custom.smoke']!.status, o.steps['custom.e2e']!.status]).toEqual(['passed', 'failed', 'skipped']);
    expect(o.taken).toEqual(expect.arrayContaining(['spec>custom.lint', 'custom.lint>build']));
    o = runOverlay(g, [...ev, { stage: 'gate', status: 'failed', next: 'build' }, { stage: 'build', status: 'started' }]);
    expect([o.steps['custom.lint']!.status, o.steps['custom.smoke']!.status]).toEqual(['passed', 'pending']);
    o = runOverlay(g, [...ev, { stage: 'gate', status: 'failed', next: 'spec' }]);
    expect(o.steps['custom.lint']!.status).toBe('pending');
  });
});
