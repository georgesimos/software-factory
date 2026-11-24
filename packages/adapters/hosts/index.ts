// Repo hosts: where a new project's repo is created and first pushed. One file per host; see README.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDir } from '../registry.ts';

// README.md is the contract; loadDir() checks the required functions at load time.
export type Ctx = { gh: (...args: string[]) => string; git: (...args: string[]) => string };
export interface Host {
  id: string;
  authStatus(ctx: Ctx): { ok: boolean; login?: string; detail?: string };
  createRepo(ctx: Ctx, opts: { repo: string; visibility: string; description?: string }): { created: boolean; url: string };
  pushInitial(ctx: Ctx, opts: { repo: string; path: string; branch?: string }): { pushed: boolean; remote?: string; branch?: string };
  /** Who is acting on this host: a verified login, or null when the host has none here (gh missing or logged out). */
  whoami?(ctx: Ctx, opts: { user: () => string }): { login: string; verified: boolean } | null;
  /** The branch a project's runs start from and merge into. base: the project's own setting, when it has one. */
  baseBranch?(ctx: Ctx, opts: { repo: string; path: string; base?: string }): string;
}

export const REQUIRED = ['authStatus', 'createRepo', 'pushInitial'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const load = (dir = process.env.FACTORY_HOSTS || HERE) => loadDir<Host>(dir, REQUIRED);
// The hosts an attached project can have (projects.json host), loaded once, as harnesses are: core reaches them synchronously.
// FACTORY_HOSTS only changes which hosts F new offers (load()), never these.
export const builtin = await loadDir<Host>(HERE, REQUIRED);

// The shared contract every host must pass. ctx = {gh, git}; repo is a name not yet created; clone is a local repo with one commit.
export function contract(p: Host, { ctx, repo, clone }: { ctx: Ctx; repo: string; clone: string }) {
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
