// Copy to hosts/<id>.mjs (the file name is the id), fill in the three functions, and run `node factory.mjs test`:
// the shared contract in hosts/index.mjs runs against every file here. No core change is needed. See README.md.
export const id = '_template';

// -> { ok: true, login } when the CLI is logged in, else { ok: false, detail }. Never log in or create an account.
export function authStatus(ctx) { throw new Error('not implemented'); }

// { repo: "owner/name", visibility: "private"|"public", description } -> { created: true, url }.
// If the repo already exists, change nothing and return { created: false, url }.
export function createRepo(ctx, { repo, visibility, description }) { throw new Error('not implemented'); }

// { repo, path, branch="main" } -> { pushed: true }. Add the remote if missing and push HEAD to branch, never with --force.
export function pushInitial(ctx, { repo, path, branch }) { throw new Error('not implemented'); }
