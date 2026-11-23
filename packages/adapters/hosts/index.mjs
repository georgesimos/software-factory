// Repo hosts: where a new project's repo is created and first pushed. One file per host; see README.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDir } from '../registry.mjs';

export const REQUIRED = ['authStatus', 'createRepo', 'pushInitial'];
export const load = (dir = process.env.FACTORY_HOSTS || path.dirname(fileURLToPath(import.meta.url))) => loadDir(dir, REQUIRED);

// The shared contract every host must pass. ctx = {gh, git}; repo is a name not yet created; clone is a local repo with one commit.
export function contract(p, { ctx, repo, clone }) {
  const a = p.authStatus(ctx);
  assert.equal(typeof a.ok, 'boolean', `${p.id}: authStatus().ok`);
  if (a.ok) assert.equal(typeof a.login, 'string', `${p.id}: authStatus().login`);
  const r1 = p.createRepo(ctx, { repo, visibility: 'private', description: 'contract test' });
  assert.deepEqual([r1.created, typeof r1.url], [true, 'string'], `${p.id}: first createRepo creates`);
  const r2 = p.createRepo(ctx, { repo, visibility: 'private', description: 'contract test' });
  assert.deepEqual([r2.created, r2.url], [false, r1.url], `${p.id}: createRepo is idempotent and reports created:false`);
  assert.equal(p.pushInitial(ctx, { repo, path: clone }).pushed, true, `${p.id}: pushInitial`);
  assert.equal(p.pushInitial(ctx, { repo, path: clone }).pushed, true, `${p.id}: pushInitial again is a no-op`);
}
