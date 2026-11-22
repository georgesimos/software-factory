// Issue trackers: where a project's issue batch is created and its queue is read. One file per tracker; see README.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDir } from '../registry.mjs';

export const REQUIRED = ['createIssues', 'listOpen', 'dependencies'];
export const load = (dir = process.env.FACTORY_TRACKERS || path.dirname(fileURLToPath(import.meta.url))) => loadDir(dir, REQUIRED);

// The shared contract every tracker must pass, against an empty project `repo`.
export function contract(p, { ctx, repo }) {
  const items = [
    { key: 'a', title: 'First', body: 'b', acceptance: ['x works'], dependsOn: [], milestone: 'M1' },
    { key: 'b', title: 'Second', body: 'b', acceptance: ['y works'], dependsOn: ['a'], milestone: 'M1' },
    { key: 'epic', kind: 'epic', title: 'Epic', body: 'all of it', children: ['a', 'b'] },
  ];
  const seen = [];
  const r1 = p.createIssues(ctx, { repo, items, existing: {}, onCreated: (r) => seen.push(r.key) });
  assert.deepEqual(r1.map((r) => [r.key, r.created, typeof r.id]), [['a', true, 'string'], ['b', true, 'string'], ['epic', true, 'string']], `${p.id}: creates in the given order`);
  assert.deepEqual(seen, ['a', 'b', 'epic'], `${p.id}: onCreated after each issue, so an interrupted batch resumes`);
  assert.equal(new Set(r1.map((r) => r.id)).size, 3, `${p.id}: distinct ids`);
  const existing = Object.fromEntries(r1.map((r) => [r.key, { id: r.id, url: r.url }]));
  const r2 = p.createIssues(ctx, { repo, items, existing, onCreated: () => assert.fail(`${p.id}: re-run created an issue`) });
  assert.deepEqual(r2.map((r) => [r.id, r.created]), r1.map((r) => [r.id, false]), `${p.id}: idempotent by key`);
  const open = p.listOpen(ctx, { repo });
  const b = open.find((i) => i.id === r1[1].id);
  assert.ok(b && Array.isArray(b.labels) && typeof b.title === 'string', `${p.id}: listOpen returns {id, title, labels}`);
  assert.ok(b.labels.includes('factory:ready') && !open.find((i) => i.id === r1[2].id).labels.includes('factory:ready'), `${p.id}: issues are factory:ready, the epic is not`);
  assert.deepEqual(p.dependencies(b), [r1[0].id], `${p.id}: dependencies() gives the ids it depends on`);
}
