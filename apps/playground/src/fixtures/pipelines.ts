// Sample pipelines for acme/shop, in the shape F's pipeline() sends. Made up for the playground: the default plus three named
// ones, each a variation the owner could approve (fewer optional reviews, lower caps); every one keeps the locked steps.
import type { Pipeline, StepRunner } from '@software-factory/design-system';

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
export interface SamplePipeline { id: string; name: string; meta: string; pipeline: Pipeline; cap: number; costCap: number }
export const PIPELINES: SamplePipeline[] = [
  { id: 'hotfix', name: 'Hotfix', meta: 'label hotfix', cap: 1, costCap: 2,
    pipeline: { ...BUILT_IN, loops: ['build'], off: ['review.ux', 'review.ui', 'review.seo', 'review.docs'] } },
  { id: 'ui-first', name: 'UI-first', meta: 'files src/components/**', cap: 3, costCap: 5,
    pipeline: { ...BUILT_IN, axes: [...BUILT_IN.axes.slice(0, 2), { axis: 'ux', when: 'always' }, { axis: 'ui', when: 'always' }, ...BUILT_IN.axes.slice(4), { axis: 'a11y', when: ['**/*.tsx'] }], off: ['review.seo'] } },
  { id: 'spike', name: 'Research spike', meta: 'label spike', cap: 2, costCap: 3,
    pipeline: { ...BUILT_IN, off: ['review.seo', 'review.docs'], custom: { 'spec.after': [{ use: 'brief', path: 'briefs/spike-notes.md' }], 'build.after': [] } } },
  { id: 'default', name: 'Factory default', meta: 'every other issue', cap: 3, costCap: 5, pipeline: BUILT_IN },
];
