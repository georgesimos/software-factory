// Copy to ci/<id>.ts (the file name is the id), fill in checks(), add one line for it to `builtin` in index.ts, and run
// `node factory.mjs test`: the shared contract in ci/index.ts runs against every file here. See README.md.
import type { CiResult, Ctx } from './index.ts';

export const id = '_template';

// { repo, path, sha, changeRequest? } -> { state, url?, failed?, detail? }. state: pass (every check green), fail (any red),
// pending (still running), none (no checks for this commit) or unknown (can't tell). Read only: never re-run or cancel a build.
// Throw on any error you can't explain: the factory reads a throw as "unknown" and escalates, never as a pass.
export function checks(ctx: Ctx, { repo, path, sha, changeRequest }: { repo: string; path?: string; sha?: string; changeRequest?: string }): CiResult { throw new Error('not implemented'); }
// Optional: the failed checks' log on sha as text ('' when none), for F ci RUN to show its tail.
// export function logTail(ctx: Ctx, { repo, path, sha }: { repo: string; path?: string; sha: string }): string { return ''; }
