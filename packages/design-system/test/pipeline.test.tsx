import { fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PipelineGraph, PipelineList, pipelineGraph, type Pipeline } from '../src/index.ts';

const P: Pipeline = {
  host: 'git', tracker: 'local', locked: ['intake', 'spec', 'build', 'review.code', 'review.security', 'verifier', 'gate', 'merge', 'watch'],
  optional: ['review.ui'], steps: ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch'], intake: ['pass', 'reject'], loops: ['build'],
  axes: [{ axis: 'code', when: 'always' }, { axis: 'security', when: 'always' }, { axis: 'ui', when: 'ui' }], off: [{ step: 'review.ui', scope: 'acme/shop', reason: 'a CLI tool', by: 'acme' }], custom: {}, warnings: [],
};

describe('PipelineGraph (the dashboard and the playground draw the same one)', () => {
  it('draws a pipeline from props alone: its tracker, its locked steps, an axis it turned off greyed in place, and its own caps', () => {
    render(<PipelineGraph name="acme/shop · Hotfix" pipeline={P} plan={{ build: { use: 'skill', name: 'fast-build', model: 'sonnet' } }} cap={1} costCap={2} />);
    const graph = screen.getByRole('list', { name: 'acme/shop · Hotfix pipeline' });
    expect(within(graph).getByRole('listitem', { name: /Issue ready/ })).toHaveTextContent('Local');
    expect(within(graph).getByRole('listitem', { name: /^Gate/ })).toHaveTextContent('Locked');
    expect(within(graph).getByRole('listitem', { name: /^Build/ })).toHaveTextContent('fast-build · sonnet');
    const ui = within(graph).getByRole('listitem', { name: 'UI review, turned off' });
    expect([ui.getAttribute('data-off'), ui.textContent]).toEqual(['true', 'UI review Off · by acme']);
    expect(screen.getByText('Steps off: UI review (by acme: a CLI tool)')).toBeInTheDocument();
    const g = pipelineGraph(P);
    expect(screen.getByText(`Valid · ${g.nodes.length} steps · ${g.edges.length} connections`)).toBeInTheDocument();
    expect(screen.getByText('loops ≤ 1 · $2 / run')).toBeInTheDocument();
  });
  it('an optional step turns off or back on from its panel, with a reason; a locked one can’t; the host only gets the request', () => {
    const onOff = vi.fn(), edit = { for: () => null, onModel: vi.fn(), onEffort: vi.fn(), onRunner: vi.fn(), onOff };
    const Q: Pipeline = { ...P, optional: ['review.ui', 'review.docs'], axes: [...P.axes, { axis: 'docs', when: 'docs' }] };
    render(<PipelineGraph name="acme/shop" pipeline={Q} cap={3} costCap={5} edit={edit} />);
    fireEvent.click(screen.getByRole('button', { name: /^UI review/ }));
    let panel = screen.getByRole('complementary', { name: 'UI review step' });
    expect(panel).toHaveTextContent('Turned off by rule steps.off, set by acme: a CLI tool');
    fireEvent.click(within(panel).getByRole('button', { name: 'Turn back on' }));
    expect(onOff).toHaveBeenLastCalledWith('review.ui', false, '');
    fireEvent.click(screen.getByRole('button', { name: /^Docs review/ }));
    panel = screen.getByRole('complementary', { name: 'Docs review step' });
    const turn = within(panel).getByRole('button', { name: 'Turn off' });
    expect(turn).toBeDisabled();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Why turn Docs review off' }), { target: { value: 'no docs here' } });
    fireEvent.click(turn);
    expect(onOff).toHaveBeenLastCalledWith('review.docs', true, 'no docs here');
    expect(panel).toHaveTextContent('Turning a review off is yours alone: the desktop app asks you to confirm it');
    fireEvent.click(screen.getByRole('button', { name: /^Security review/ }));
    expect(within(screen.getByRole('complementary', { name: 'Security review step' })).queryByRole('button', { name: /Turn/ })).toBeNull();
    expect(onOff).toHaveBeenCalledTimes(2);
  });
  it('PipelineList marks the current pipeline and reports a pick', () => {
    const onPick = vi.fn();
    render(<PipelineList items={[{ id: 'hotfix', name: 'Hotfix', meta: 'label hotfix', pipeline: P }, { id: 'default', name: 'Factory default', pipeline: P }]} current="hotfix" onPick={onPick} />);
    const [a, b] = within(screen.getByRole('navigation', { name: 'Pipelines' })).getAllByRole('button');
    expect([a!.getAttribute('aria-current'), b!.getAttribute('aria-current')]).toEqual(['true', null]);
    fireEvent.click(b!);
    expect(onPick).toHaveBeenCalledWith('default');
  });
  it('imports nothing from core or the dashboard', () => {
    for (const f of ['PipelineGraph.tsx', 'PipelineStepPanel.tsx', 'pipelineModel.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'factory', f), 'utf8');
      expect((src.match(/from '[^']+'/g) ?? []).filter((m) => !/^from '(react|\.\/[\w.]+|\.\.\/components\/[\w.]+)'$/.test(m)), f).toEqual([]);
    }
  });
});
