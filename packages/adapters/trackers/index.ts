// Issue trackers: where a project's issue batch is created and its queue is read. One file per tracker; see README.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDir } from '../registry.ts';
import * as githubIssues from './github-issues.ts';
import * as local from './local.ts';
import type { Ctx } from '../hosts/index.ts';

// README.md is the contract; loadDir() checks the required functions at load time.
export interface Item {
  key: string; title: string; body: string; kind?: string; children?: string[];
  acceptance?: string[]; dependsOn?: string[]; milestone?: string; files?: string[];
}
export interface Created { key: string; id: string; url?: string; created: boolean }
export interface OpenIssue { id: string; title: string; labels: string[]; key?: string | null; body?: string }
/** One item as intake reads it, never model-typed. association: the author's standing on the tracker (GitHub's author_association). */
export interface TrackerItem { id: string; title: string; url?: string; author: string; association: string; state: string; isChangeRequest: boolean; body?: string | null; labels?: string[] }
export interface Comment { author: string; association: string; created_at: string; body?: string | null }
export interface Tracker {
  id: string;
  /** path: the project's clone, for a tracker that keeps its items there (local). ready: false (F split for an untrusted
   *  parent) creates the issues without factory:ready, so nothing can pick them up; the default labels them. */
  createIssues(ctx: Ctx, opts: { repo: string; path?: string; items: Item[]; existing?: Record<string, { id: string; url?: string | undefined }>; onCreated?: (r: Created) => void; ready?: boolean }): Created[];
  listOpen(ctx: Ctx, opts: { repo: string; path?: string }): OpenIssue[];
  dependencies(item: OpenIssue): string[];
  /** One item; intake reads its comments only once it knows it is an open issue. */
  getItem?(ctx: Ctx, opts: { repo: string; path?: string; id: string }): TrackerItem;
  comments?(ctx: Ctx, opts: { repo: string; path?: string; id: string }): Comment[];
  /** The item author's association, alone (facts() re-reads it at merge time). */
  trust?(ctx: Ctx, opts: { repo: string; id: string }): string;
  /** F labels: creates the factory's labels where the tracker needs them first; -> their names. */
  ensureLabels?(ctx: Ctx, opts: { repo: string; path?: string }): string[];
  /** F label: adds or removes labels on one item. A label that isn't there is no error on remove; anything else throws. */
  label?(ctx: Ctx, opts: { repo: string; path?: string; id: string; add?: string[]; remove?: string[] }): { labelled: boolean; detail?: string };
  /** F comment: one comment on an item. A tracker with no comments returns posted: false and says why. */
  comment?(ctx: Ctx, opts: { repo: string; path?: string; id: string; body: string }): { posted: boolean; detail?: string };
}

export const REQUIRED = ['createIssues', 'listOpen', 'dependencies'];
// The trackers an attached project can have, imported by name so core reaches them synchronously (as hosts/index.ts builtin).
export const builtin: Record<'github-issues' | 'local', Tracker> = { 'github-issues': githubIssues, local };
export const load = (dir = process.env.FACTORY_TRACKERS || path.dirname(fileURLToPath(import.meta.url))) => loadDir<Tracker>(dir, REQUIRED);

// The shared contract every tracker must pass, against an empty project `repo`.
export function contract(p: Tracker, { ctx, repo, path: at }: { ctx: Ctx; repo: string; path?: string }) {
  const items: Item[] = [
    { key: 'a', title: 'First', body: 'b', acceptance: ['x works'], dependsOn: [], milestone: 'M1' },
    { key: 'b', title: 'Second', body: 'b', acceptance: ['y works'], dependsOn: ['a'], milestone: 'M1' },
    { key: 'epic', kind: 'epic', title: 'Epic', body: 'all of it', children: ['a', 'b'] },
  ];
  const seen: string[] = [];
  const where = at ? { path: at } : {};
  const r1 = p.createIssues(ctx, { repo, ...where, items, existing: {}, onCreated: (r) => seen.push(r.key) });
  assert.deepEqual(r1.map((r) => [r.key, r.created, typeof r.id]), [['a', true, 'string'], ['b', true, 'string'], ['epic', true, 'string']], `${p.id}: creates in the given order`);
  assert.deepEqual(seen, ['a', 'b', 'epic'], `${p.id}: onCreated after each issue, so an interrupted batch resumes`);
  assert.equal(new Set(r1.map((r) => r.id)).size, 3, `${p.id}: distinct ids`);
  const existing = Object.fromEntries(r1.map((r) => [r.key, { id: r.id, url: r.url }]));
  const r2 = p.createIssues(ctx, { repo, ...where, items, existing, onCreated: () => assert.fail(`${p.id}: re-run created an issue`) });
  assert.deepEqual(r2.map((r) => [r.id, r.created]), r1.map((r) => [r.id, false]), `${p.id}: idempotent by key`);
  const open = p.listOpen(ctx, { repo, ...where });
  const b = open.find((i) => i.id === r1[1]!.id);
  assert.ok(b && Array.isArray(b.labels) && typeof b.title === 'string', `${p.id}: listOpen returns {id, title, labels}`);
  assert.ok(b.labels.includes('factory:ready') && !open.find((i) => i.id === r1[2]!.id)!.labels.includes('factory:ready'), `${p.id}: issues are factory:ready, the epic is not`);
  assert.deepEqual(p.dependencies(b), [r1[0]!.id], `${p.id}: dependencies() gives the ids it depends on`);
  const [c] = p.createIssues(ctx, { repo, ...where, items: [{ key: 'c', title: 'Third', body: 'b', acceptance: ['z works'] }], ready: false });
  assert.ok(!p.listOpen(ctx, { repo, ...where }).find((i) => i.id === c!.id)!.labels.includes('factory:ready'), `${p.id}: ready: false creates it without factory:ready`);
}
