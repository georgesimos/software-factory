import { fireEvent, render, screen, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PipelineGraph, PipelineList, pipelineGraph, type Pipeline } from '../src/index.ts';

const P: Pipeline = {
  host: 'git', tracker: 'local', locked: ['intake', 'spec', 'build', 'review.code', 'review.security', 'verifier', 'gate', 'merge', 'watch'],
  optional: ['review.ui'], steps: ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch'], intake: ['pass', 'reject'], loops: ['build'],
  axes: [{ axis: 'code', when: 'always' }, { axis: 'security', when: 'always' }, { axis: 'ui', when: 'ui' }], off: ['review.ui'], custom: {}, warnings: [],
};

describe('PipelineGraph (the dashboard and the playground draw the same one)', () => {
  it('draws a pipeline from props alone: its tracker, its locked steps, an axis it turned off left out, and its own caps', () => {
    render(<PipelineGraph name="acme/shop · Hotfix" pipeline={P} plan={{ build: { use: 'skill', name: 'fast-build', model: 'sonnet' } }} cap={1} costCap={2} />);
    const graph = screen.getByRole('list', { name: 'acme/shop · Hotfix pipeline' });
    expect(within(graph).getByRole('listitem', { name: /Issue ready/ })).toHaveTextContent('Local');
    expect(within(graph).getByRole('listitem', { name: /^Gate/ })).toHaveTextContent('Locked');
    expect(within(graph).getByRole('listitem', { name: /^Build/ })).toHaveTextContent('fast-build · sonnet');
    expect(within(graph).queryByRole('listitem', { name: /^UI review/ })).toBeNull();
    const g = pipelineGraph(P);
    expect(screen.getByText(`Valid · ${g.nodes.length} steps · ${g.edges.length} connections`)).toBeInTheDocument();
    expect(screen.getByText('loops ≤ 1 · $2 / run')).toBeInTheDocument();
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
    for (const f of ['PipelineGraph.tsx', 'pipelineModel.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'factory', f), 'utf8');
      expect((src.match(/from '[^']+'/g) ?? []).filter((m) => !/^from '(react|\.\/[\w.]+|\.\.\/components\/[\w.]+)'$/.test(m)), f).toEqual([]);
    }
  });
});
