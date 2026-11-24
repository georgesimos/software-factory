// Repo hosts: where a new project's repo is created and first pushed. One file per host; see README.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDir } from '../registry.ts';
import * as github from './github.ts';
import * as gitHost from './git.ts';

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
  /** The base, the open change requests, and the branches of recently merged or closed ones (sync and intake read these). */
  listChangeRequests?(ctx: Ctx, opts: { repo: string; path?: string }): { base: string; open: ChangeRequest[]; doneBranches: string[] };
  /** One change request by id; sha: the reviewed commit, when the caller has one. approval: a merge approval on its head (null where the host's own gates decide). */
  changeRequest?(ctx: Ctx, opts: { repo: string; path?: string; id: string; base?: string; sha?: string }): { state: 'open' | 'merged' | 'closed' | 'unknown'; headSha?: string | null;
    approval: { by: string; via: string; sha: string } | null; branch?: string; fork?: boolean; mergedAt?: string | null; mergedBy?: string; mergeSha?: string };
  /** Merges exactly sha into the base; merged:false (or a throw) when the host refuses. */
  merge?(ctx: Ctx, opts: { repo: string; path?: string; id: string; sha: string; base?: string }): { merged: boolean; sha?: string; detail?: string };
  /** Opens a change request from a branch already pushed. */
  openChangeRequest?(ctx: Ctx, opts: { repo: string; path?: string; branch: string; base: string; title: string; body: string; labels?: string[] }): { id: string; url?: string };
  /** What the published page's scrub removes, and the host's token shapes for its leak check (server.ts). */
  publicUrl?: RegExp;
  secretPatterns?: RegExp[];
}
/** An open change request, as listChangeRequests gives it. closes: the issue ids it closes. */
export interface ChangeRequest { id: string; url?: string; title: string; branch: string; headSha: string; closes: string[]; author?: string; association?: string }

export const REQUIRED = ['authStatus', 'createRepo', 'pushInitial'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const load = (dir = process.env.FACTORY_HOSTS || HERE) => loadDir<Host>(dir, REQUIRED);
// The hosts an attached project can have (projects.json host), imported by name: core reaches them synchronously, and a bad
// file in this folder or FACTORY_HOSTS fails only F new (load(), which names the file), never every command.
export const builtin: Record<'github' | 'git', Host> = { github, git: gitHost };

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
