// Copy to hosts/<id>.ts (the file name is the id), fill in the three functions, and run `node factory.mjs test`:
// the shared contract in hosts/index.ts runs against every file here. No core change is needed. See README.md.
// For a host kept outside this repo, copy it to <id>.mjs instead and delete the type annotations (and the import type line).
import type { Ctx } from './index.ts';

export const id = '_template';

// -> { ok: true, login } when the CLI is logged in, else { ok: false, detail }. Never log in or create an account.
export function authStatus(ctx: Ctx): { ok: boolean; login?: string; detail?: string } { throw new Error('not implemented'); }

// { repo: "owner/name", visibility: "private"|"public", description } -> { created: true, url }.
// If the repo already exists, change nothing and return { created: false, url }.
export function createRepo(ctx: Ctx, { repo, visibility, description }: { repo: string; visibility: string; description?: string }): { created: boolean; url: string } { throw new Error('not implemented'); }

// { repo, path, branch="main" } -> { pushed: true }. Add the remote if missing and push HEAD to branch, never with --force.
export function pushInitial(ctx: Ctx, { repo, path, branch }: { repo: string; path: string; branch?: string }): { pushed: boolean } { throw new Error('not implemented'); }
