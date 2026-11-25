// Sample pipelines for acme/shop, in the shape F's pipeline() sends. Made up for the playground: the default plus three named
// ones, each a variation the owner could approve (fewer optional reviews, lower caps, an added review); every one keeps the
// locked steps and the gate's loop-backs, and no named pipeline has a custom step. Three add steps of the user's own (a
// person's approval, a shell check, a subagent step), the shape that design proposes. Two have a sample run for "Show a run…".
import type { Pipeline, Run, RunEvent, StepRunner } from '@software-factory/design-system';

const LOCKED = ['intake', 'spec', 'build', 'review.code', 'review.security', 'verifier', 'gate', 'merge', 'watch'];
const BUILT_IN: Pipeline = {
  host: 'github', tracker: 'github-issues', locked: LOCKED, optional: ['review.ux', 'review.ui', 'review.seo', 'review.docs'],
  steps: ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch'], intake: ['pass', 'split', 'needs-info', 'reject'], loops: ['spec', 'build'],
  axes: [{ axis: 'code', when: 'always' }, { axis: 'security', when: 'always' }, { axis: 'ux', when: 'ui' }, { axis: 'ui', when: 'ui' }, { axis: 'seo', when: 'seo' }, { axis: 'docs', when: 'docs' }],
  off: [], custom: { 'spec.after': [], 'build.after': [] }, warnings: [],
};
const r = (model: string, effort = 'high'): StepRunner => ({ use: 'default', model, effort });
export const PLAN: Record<string, StepRunner> = {
  intake: r('sonnet', 'medium'), spec: r('opus'), build: r('sonnet'), 'review.code': r('opus'), 'review.security': r('opus'), 'review.ux': r('sonnet'),
  'review.ui': r('sonnet'), 'review.seo': r('haiku', 'medium'), 'review.docs': r('haiku', 'medium'), verifier: r('opus', 'medium'),
  'review.a11y': { use: 'skill', name: 'a11y-review', axis: 'a11y', when: ['**/*.tsx'] },
};
/** F's runner keys: what a step's panel may change (an extra axis changes in Skills). */
export const RUNNER_STEPS = ['intake', 'spec', 'build', 'review.code', 'review.security', 'review.ux', 'review.ui', 'review.seo', 'review.docs', 'verifier', 'postmerge'];
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'], EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** What the playground's runner picker offers, in place of the dashboard's catalog. */
export const RUNNERS: { label: string; runner: StepRunner }[] = [
  { label: 'Factory default', runner: { use: 'default' } }, { label: 'skill: fast-build', runner: { use: 'skill', name: 'fast-build' } },
  { label: 'Codex', runner: { use: 'provider', harness: 'codex' } }, { label: 'brief: careful-build.md', runner: { use: 'brief', path: '~/.claude/factory/briefs/careful-build.md' } },
];

let t = Date.parse('2026-11-24T14:00:00Z');
const ev = (run: string, stage: string, status: string, p: Partial<RunEvent> = {}): RunEvent => ({ ts: new Date((t += 140_000)).toISOString(), run, stage, status, ...p });
const sample = (id: string, title: string, outcome: Run['outcome'], costUsd: number, events: RunEvent[]): Run => ({ id, title, outcome, costUsd, events, started: events[0]!.ts, updated: events.at(-1)!.ts });
const step = (run: string, id: string, outcome: string, tokens?: number) => [ev(run, 'step', 'started', { step: id }), ev(run, 'step', outcome, { step: id, ...(tokens && { tokens }) })];
const passed = (run: string, ...axes: string[]) => axes.map((axis, i) => ev(run, 'review', 'passed', { axis, findings: [], tokens: 31000 + 900 * i }));

// UI-first: UI review blocks once, the gate sends it back to build, the second pass merges. docs is never due (no docs changed).
const UI = 'acme/shop#61', UI_AXES = ['code', 'security', 'ux', 'ui', 'a11y'];
const uiRun = sample(UI, 'Size picker as a radio group', 'merged', 2.35, [
  ev(UI, 'intake', 'started'), ev(UI, 'intake', 'passed', { tokens: 6100 }), ev(UI, 'spec', 'passed', { tokens: 9800 }),
  ev(UI, 'build', 'started'), ev(UI, 'build', 'passed', { tokens: 64000 }), ...step(UI, 'storybook', 'passed'),
  ev(UI, 'review', 'started', { axes: UI_AXES }), ...passed(UI, 'code', 'security', 'ux', 'a11y'),
  ev(UI, 'review', 'failed', { axis: 'ui', tokens: 28400, findings: [{ severity: 'medium', file: 'components/SizePicker.tsx', issue: 'Selected size uses a raw colour, not the accent token.', route: 'build' }] }),
  ev(UI, 'review', 'passed', { role: 'verifier', tokens: 7200 }), ev(UI, 'gate', 'failed', { next: 'build' }),
  ev(UI, 'build', 'started'), ev(UI, 'build', 'passed', { tokens: 21000 }), ...step(UI, 'storybook', 'passed'),
  ev(UI, 'review', 'started', { axes: UI_AXES }), ...passed(UI, 'code', 'security', 'ux', 'ui', 'a11y'),
  ev(UI, 'gate', 'passed', { next: 'approve' }), ev(UI, 'approve', 'decided', { action: 'merge' }), ev(UI, 'approve', 'merged'),
]);
// Hotfix (one loop at most): security blocks twice, so the gate runs out of loops and hands the run to a person.
const HF = 'acme/shop#62';
const hotfixRun = sample(HF, 'Checkout 500 on an empty cart', 'escalated', 1.6, [
  ev(HF, 'intake', 'started'), ev(HF, 'intake', 'passed', { tokens: 4800 }), ev(HF, 'spec', 'passed', { tokens: 7100 }),
  ev(HF, 'build', 'started'), ev(HF, 'build', 'passed', { tokens: 38000 }),
  ev(HF, 'review', 'started', { axes: ['code', 'security'] }), ...passed(HF, 'code'),
  ev(HF, 'review', 'failed', { axis: 'security', tokens: 33500, findings: [{ severity: 'high', file: 'app/api/cart/route.ts', issue: 'The cart id is read from the query string without a session check.', route: 'build' }] }),
  ev(HF, 'review', 'passed', { role: 'verifier', tokens: 5100 }), ev(HF, 'gate', 'failed', { next: 'build' }),
  ev(HF, 'build', 'started'), ev(HF, 'build', 'passed', { tokens: 17000 }),
  ev(HF, 'review', 'started', { axes: ['code', 'security'] }), ...passed(HF, 'code'),
  ev(HF, 'review', 'failed', { axis: 'security', tokens: 30100, findings: [{ severity: 'high', file: 'app/api/cart/route.ts', issue: 'The session check is skipped for guest carts.', route: 'build' }] }),
  ev(HF, 'review', 'passed', { role: 'verifier', tokens: 4900 }), ev(HF, 'gate', 'failed', { next: 'approve' }),
  ev(HF, 'approve', 'decided', { action: 'escalate' }), ev(HF, 'approve', 'escalated'),
]);

export interface SamplePipeline { id: string; name: string; meta: string; pipeline: Pipeline; cap: number; costCap: number; runs: Run[] }
export const PIPELINES: SamplePipeline[] = [
  { id: 'hotfix', name: 'Hotfix', meta: 'label hotfix', cap: 1, costCap: 2, runs: [hotfixRun],
    pipeline: { ...BUILT_IN, off: ['review.ux', 'review.ui', 'review.seo', 'review.docs'],
      beforeMerge: { first: 'oncall', steps: [{ id: 'oncall', kind: 'human', label: 'On-call approves', next: { approved: 'merge', rejected: 'escalate' } }] } } },
  { id: 'ui-first', name: 'UI-first', meta: 'files src/components/**', cap: 3, costCap: 5, runs: [uiRun],
    pipeline: { ...BUILT_IN, axes: [...BUILT_IN.axes.slice(0, 2), { axis: 'ux', when: 'always' }, { axis: 'ui', when: 'always' }, ...BUILT_IN.axes.slice(4), { axis: 'a11y', when: ['**/*.tsx'] }], off: ['review.seo'],
      beforeReview: { first: 'storybook', steps: [{ id: 'storybook', kind: 'check', label: 'Storybook builds', run: 'pnpm build-storybook', next: { passed: 'review', failed: 'build' } }] } } },
  { id: 'spike', name: 'Research spike', meta: 'label spike', cap: 2, costCap: 3, runs: [], pipeline: { ...BUILT_IN, off: ['review.seo', 'review.docs'],
    beforeBuild: { first: 'plan', steps: [{ id: 'plan', kind: 'step', label: 'Write a plan', next: { passed: 'build', failed: 'escalate' } }] } } },
  { id: 'default', name: 'Factory default', meta: 'every other issue', cap: 3, costCap: 5, runs: [], pipeline: BUILT_IN },
];
