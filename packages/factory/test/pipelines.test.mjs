// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { BUILTIN_AXES, LOCKED_STEPS, OPTIONAL_STEPS, REQUIRED_AXES, setSkill, skills, skillsData } from '../../core/src/skills.ts';
import { projects, projectsFile } from '../../core/src/workspace.ts';
import { setup } from './setup.mjs';

setup();
const attach = (repo, p) => fs.writeFileSync(projectsFile(), JSON.stringify({ ...projects(), [repo]: { path: '/x', ...p } }));

test('pipelines: the locked and optional steps come from REQUIRED_AXES, never a list of their own', () => {
  assert.deepEqual(LOCKED_STEPS, ['intake', 'spec', 'build', ...REQUIRED_AXES.map((a) => `review.${a}`), 'verifier', 'gate', 'merge', 'watch']);
  assert.deepEqual(OPTIONAL_STEPS, BUILTIN_AXES.filter((a) => !REQUIRED_AXES.includes(a)).map((a) => `review.${a}`));
  assert.ok(!OPTIONAL_STEPS.some((s) => LOCKED_STEPS.includes(s)));
});

test('pipelines: F skills carries the pipeline: host and tracker of an attached project, the review axes in order, nothing off yet', () => {
  attach('acme/app', {});
  attach('local/notes', { host: 'git' });
  setSkill('acme/app', 'axes.extra', [{ axis: 'a11y', when: ['**/*.tsx'], use: 'skill', name: 'a11y-review' }]);
  const p = skills('acme/app').pipeline;
  assert.deepEqual([p.host, p.tracker], ['github', 'github-issues']);
  assert.deepEqual(p.locked, LOCKED_STEPS);
  assert.deepEqual(p.optional, OPTIONAL_STEPS);
  assert.deepEqual(p.steps, ['intake', 'spec', 'build', 'review', 'verifier', 'gate', 'merge', 'watch']);
  assert.deepEqual(p.intake, ['pass', 'split', 'needs-info', 'reject']);
  assert.deepEqual(p.loops, ['spec', 'build']);
  assert.deepEqual(p.axes, [
    { axis: 'code', when: 'always' }, { axis: 'security', when: 'always' }, { axis: 'ux', when: 'ui' }, { axis: 'ui', when: 'ui' },
    { axis: 'seo', when: 'seo' }, { axis: 'docs', when: 'docs' }, { axis: 'a11y', when: ['**/*.tsx'] }]);
  assert.deepEqual([p.off, p.custom, p.warnings], [[], { 'spec.after': [], 'build.after': [] }, []]);
  // a git project has no tracker on main yet (the local tracker is 5b); default and unattached scopes have neither
  assert.deepEqual([skills('local/notes').pipeline.host, skills('local/notes').pipeline.tracker], ['git', null]);
  for (const s of ['', 'acme/unattached']) assert.deepEqual([skills(s).pipeline.host, skills(s).pipeline.tracker], [null, null], s);
  assert.deepEqual(skillsData(['acme/app']).plans['acme/app'].pipeline.host, 'github'); // what GET /api/state embeds
});
