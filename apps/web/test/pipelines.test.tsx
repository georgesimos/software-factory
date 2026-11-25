import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import state from '../fixtures/state.json';
import { App } from '../src/App.tsx';
import { pipelineGraph } from '@software-factory/design-system';
import { normData, type FactoryData, type Pipeline } from '../src/data.ts';
import { PipelinesSheet } from '../src/Pipelines.tsx';

const data = normData(state as unknown as FactoryData);
const P = data.skills!.plans!['acme/shop']!.pipeline!;
const plan = data.skills!.plans!['acme/shop']!.plan!;
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('pipeline graph (generated from F’s pipeline, never drawn by hand)', () => {
  it('chains F’s steps, fans the review axes out of build and into the verifier, branches intake, and loops the gate back', () => {
    const g = pipelineGraph(P, plan);
    expect(g.nodes.map((n) => n.id)).toEqual(['ready', 'intake', 'children', 'ask', 'close', 'spec', 'build',
      'review.code', 'review.security', 'review.ux', 'review.ui', 'review.seo', 'review.docs', 'review.a11y', 'verifier', 'gate', 'merge', 'watch']);
    expect(g.edges.filter((e) => e.from === 'intake').map((e) => [e.to, e.label])).toEqual([['children', 'split'], ['ask', 'needs-info'], ['close', 'reject'], ['spec', 'pass']]);
    expect(g.edges.filter((e) => e.to === 'verifier')).toHaveLength(7);
    expect(g.edges.filter((e) => e.loop).map((e) => [e.from, e.to])).toEqual([['gate', 'spec'], ['gate', 'build']]);
    expect(g.nodes.filter((n) => n.locked).map((n) => n.id)).toEqual(P.locked);
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.col]))).toMatchObject({ ready: 0, intake: 1, spec: 2, close: 2, build: 3, 'review.a11y': 4, verifier: 5, watch: 8 });
  });
  it('follows F, not a list of its own: another locked set, an axis off, an outcome it doesn’t know', () => {
    const g = pipelineGraph({ ...P, locked: ['intake', 'gate'], off: [{ step: 'review.seo' }], intake: ['pass', 'defer'] }, plan);
    expect(g.nodes.filter((n) => n.locked).map((n) => n.id)).toEqual(['intake', 'gate']);
    expect(g.nodes.find((n) => n.id === 'review.seo')?.off).toEqual({ step: 'review.seo' }); // in place, marked off
    expect(g.nodes.find((n) => n.id === 'defer')).toMatchObject({ label: 'defer', kind: 'outcome' });
  });
});

describe('Pipelines sheet', () => {
  it('names the project’s tracker and host, marks locked steps, and counts what it drew', () => {
    render(<PipelinesSheet open onClose={() => {}} data={data} project="acme/shop" />);
    const graph = screen.getByRole('list', { name: 'acme/shop pipeline' });
    expect(within(screen.getByRole('navigation', { name: 'Pipelines' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['acme/shop9 runs']); // attached projects only, never default
    expect(within(graph).getByRole('listitem', { name: /Issue ready/ })).toHaveTextContent('GitHub Issues');
    expect(within(graph).getByRole('listitem', { name: /^Security review/ })).toHaveTextContent('Locked');
    expect(within(graph).getByRole('listitem', { name: /^UI review/ })).toHaveTextContent('when UI files change');
    expect(within(graph).getByRole('listitem', { name: /^UI review/ })).not.toHaveTextContent('Locked');
    expect(within(graph).getByRole('listitem', { name: /^A11y review/ })).toHaveTextContent('a11y-review');
    expect(within(graph).getByRole('listitem', { name: /^Build/ })).toHaveTextContent('sonnet');
    const g = pipelineGraph(P, plan);
    expect(screen.getByText(`Valid · ${g.nodes.length} steps · ${g.edges.length} connections`)).toBeInTheDocument();
    expect(screen.getByText('loops ≤ 3 · $5 / run')).toBeInTheDocument();
    expect(screen.getByText(/host github/)).toBeInTheDocument();
    expect(screen.getByText('pipeline.json').closest('details')).toHaveTextContent('"tracker": "github-issues"');
    const canvas = graph.closest('.sf-pl-canvas') as HTMLElement;
    expect(canvas.style.transform).toBe('scale(1)'); // opens readable, at zoom 1; Fit is a button
    expect(screen.getByText(/Issues labelled factory:ready in GitHub Issues start here\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(canvas.style.transform).toBe('scale(0.9)');
    fireEvent.click(screen.getByRole('button', { name: 'Fit' })); // no layout in jsdom: the smallest zoom, never 0
    expect(canvas.style.transform).toBe('scale(0.3)');
  });
  it('a git project shows git and no tracker; F’s warnings replace "Valid"', () => {
    const git: Pipeline = { ...P, host: 'git', tracker: null, warnings: ['steps.off on default is ignored'] };
    const d = { ...data, skills: { ...data.skills, plans: { ...data.skills!.plans, 'acme/shop': { ...data.skills!.plans!['acme/shop'], pipeline: git } } } };
    render(<PipelinesSheet open onClose={() => {}} data={d} project="acme/shop" />);
    expect(screen.getByRole('listitem', { name: /Issue ready/ })).toHaveTextContent('no tracker yet');
    expect(screen.getByText(/host git/)).toBeInTheDocument();
    expect(screen.getByText(/1 warning ·/)).toBeInTheDocument();
    expect(screen.getByText('steps.off on default is ignored')).toBeInTheDocument();
    expect(screen.getByText(/Issues labelled factory:ready start here\./)).toBeInTheDocument();
  });
  it('opens from the header', async () => {
    render(<App load={async () => data} />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Pipelines' }))[0]!); // the header's; a phone gets one above the board
    expect(screen.getByRole('dialog', { name: 'Pipelines' })).toBeInTheDocument();
  });
  it('has no header button when F sent no pipeline (older data): the page never draws one of its own', async () => {
    const { pipeline: _p, ...old } = data.skills!.plans!['acme/shop']!;
    const { pipeline: _d, ...oldDefault } = data.skills!.plans!.default!;
    render(<App load={async () => ({ ...data, skills: { ...data.skills, plans: { default: oldDefault, 'acme/shop': old } } })} />);
    await screen.findByRole('button', { name: 'Skills' });
    expect(screen.queryAllByRole('button', { name: 'Pipelines' })).toHaveLength(0);
  });
});

describe('Pipelines sheet: a step’s panel writes as the Skills sheet does; a run drawn on the graph', () => {
  const sheet = (d: FactoryData = data, onSaved = vi.fn()) => render(<PipelinesSheet open onClose={() => {}} data={d} project="acme/shop" onSaved={onSaved} />);
  const F = 'node ~/.claude/skills/software-factory/factory.mjs';
  it('under F ui, a model change saves through POST /api/skills with {scope, step, runner}', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(data.skills), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn();
    sheet({ ...data, token: 'tok' }, onSaved);
    await userEvent.click(screen.getByRole('button', { name: /^Build/ }));
    const panel = screen.getByRole('complementary', { name: 'Build step' });
    expect(panel).toHaveTextContent('set for this project');
    await userEvent.selectOptions(within(panel).getByRole('combobox', { name: 'Model for Build' }), 'opus');
    expect(fetch).toHaveBeenCalledWith('/api/skills', expect.objectContaining({ method: 'POST', body: JSON.stringify({ scope: 'acme/shop', step: 'build', runner: { use: 'default', model: 'opus' } }) }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('Saved.');
    expect(onSaved).toHaveBeenCalledWith(data.skills);
  });
  it('steps off (slice 3): under the desktop app a review is only requested off, and the page waits for the dialog', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ skills: data.skills, requested: 'turning a pipeline step off' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn(), refresh = vi.fn();
    render(<PipelinesSheet open onClose={() => {}} data={{ ...data, token: 'tok' }} project="acme/shop" onSaved={onSaved} refresh={refresh} />);
    await userEvent.click(screen.getByRole('button', { name: /^Docs review/ }));
    const panel = screen.getByRole('complementary', { name: 'Docs review step' });
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Why turn Docs review off' }), 'no docs here');
    await userEvent.click(within(panel).getByRole('button', { name: 'Turn off' }));
    expect(fetch).toHaveBeenCalledWith('/api/onboard/rule', expect.objectContaining({ method: 'POST', body: JSON.stringify({ scope: 'acme/shop', key: 'steps.off', value: ['review.docs'], reason: 'no docs here' }) }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('Confirm it in the app’s dialog: nothing changes until you do.');
    expect(onSaved).toHaveBeenCalledWith(data.skills);
    expect(refresh).toHaveBeenCalled(); // then again every few seconds, until the dialog's answer shows
  });
  it('steps off under plain F ui: refused, and the command to run in a terminal is copied, reason and all', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'turning a pipeline step off needs your confirmation outside the page: confirm it in the desktop app, or run in your own terminal: F rules set acme/shop steps.off \'["review.docs"]\' --reason "…"' }), { status: 400 })));
    sheet({ ...data, token: 'tok' });
    await userEvent.click(screen.getByRole('button', { name: /^Docs review/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Why turn Docs review off' }), "it's a CLI");
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    const cmd = `${F} rules set 'acme/shop' 'steps.off' '["review.docs"]' --reason 'it'\\''s a CLI'`;
    expect(writeText).toHaveBeenCalledWith(cmd);
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Turning a review off needs your confirmation outside the page, and this is plain F ui. Command copied: run it in your own terminal:');
    expect(status.querySelector('code')!.textContent).toBe(cmd);
  });
  it('steps off on a read-only page copies the command; turning the last one back on unsets the rule, which only tightens', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const withOff = (d: FactoryData, off: Pipeline['off']) => ({ ...d, skills: { ...d.skills, plans: { ...d.skills!.plans, 'acme/shop': { ...d.skills!.plans!['acme/shop'], pipeline: { ...P, off } } } } });
    const one = withOff(data, [{ step: 'review.seo', scope: 'acme/shop', reason: 'no pages', by: 'acme' }]);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { unmount } = sheet(one);
    expect(screen.getByRole('listitem', { name: 'SEO review, turned off' })).toHaveTextContent('Off · by acme');
    await userEvent.click(screen.getByRole('button', { name: /^Docs review/ }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Why turn Docs review off' }), 'no docs');
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(writeText).toHaveBeenLastCalledWith(`${F} rules set 'acme/shop' 'steps.off' '["review.seo","review.docs"]' --reason 'no docs'`);
    expect(fetch).not.toHaveBeenCalled();
    unmount();
    const ok = vi.fn(async () => new Response(JSON.stringify({ skills: data.skills }), { status: 200 }));
    vi.stubGlobal('fetch', ok);
    sheet({ ...one, token: 'tok' });
    await userEvent.click(screen.getByRole('button', { name: /^SEO review/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Turn back on' }));
    expect(ok).toHaveBeenCalledWith('/api/onboard/rule', expect.objectContaining({ body: JSON.stringify({ scope: 'acme/shop', key: 'steps.off', unset: true }) }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });
  it('read-only page: an effort change copies the CLI command instead', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    sheet();
    await userEvent.click(screen.getByRole('button', { name: /^Build/ }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Effort for Build' }), 'max');
    expect(writeText).toHaveBeenCalledWith(`${F} skills set 'acme/shop' 'build' '{"use":"default","model":"sonnet","effort":"max"}'`);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Command copied.');
  });
  it('opening another step clears the last save’s status, which was about the step before', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    sheet();
    await userEvent.click(screen.getByRole('button', { name: /^Build/ }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Effort for Build' }), 'max');
    expect(screen.getByRole('status')).toHaveTextContent('Command copied.');
    await userEvent.click(screen.getByRole('button', { name: /^Spec/ }));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('Change runner opens the Skills picker, and the pick keeps the step’s model', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(data.skills), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    sheet({ ...data, token: 'tok' });
    await userEvent.click(screen.getByRole('button', { name: /^Build/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Change runner' }));
    const pick = screen.getByRole('dialog', { name: 'Runner for Build' });
    await userEvent.type(within(pick).getByRole('textbox', { name: 'Skill name' }), 'fast-build');
    await userEvent.click(within(pick).getByRole('button', { name: 'Save' }));
    expect(fetch).toHaveBeenCalledWith('/api/skills', expect.objectContaining({ body: JSON.stringify({ scope: 'acme/shop', step: 'build', runner: { use: 'skill', name: 'fast-build', model: 'sonnet' } }) }));
  });
  it('the gate is F’s own and an extra axis changes in Skills: both read-only here', async () => {
    sheet();
    await userEvent.click(screen.getByRole('button', { name: /^Gate/ }));
    expect(within(screen.getByRole('complementary', { name: 'Gate step' })).queryByRole('combobox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^A11y review/ }));
    const a11y = screen.getByRole('complementary', { name: 'A11y review step' });
    expect(a11y).toHaveTextContent('when **/*.tsx change');
    expect(a11y).toHaveTextContent('Who runs it changes in Skills.');
    expect(within(a11y).queryByRole('button', { name: 'Change runner' })).toBeNull();
  });
  it('“Show a run…” lists this project’s runs; #43 shows its loop-backs, its revert and its spend', async () => {
    sheet();
    const pick = screen.getByRole('combobox', { name: 'Show a run' });
    expect(within(pick).getAllByRole('option')).toHaveLength(data.runs.filter((r) => r.id.startsWith('acme/shop#')).length + 1);
    await userEvent.selectOptions(pick, 'acme/shop#43');
    const graph = screen.getByRole('list', { name: 'acme/shop pipeline' });
    expect(within(graph).getByRole('listitem', { name: /^Merge/ })).toHaveAttribute('data-status', 'passed');
    expect(within(graph).getByRole('listitem', { name: /^Watch main/ })).toHaveTextContent('reverted');
    expect(within(graph).getByRole('listitem', { name: /^Docs review/ })).toHaveTextContent('Skipped');
    expect(screen.getByText('#43 · Merged · $3.84 of $5 · 2 of 3 loops')).toBeInTheDocument();
  });
});
