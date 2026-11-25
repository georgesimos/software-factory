// F's own checks: the checks.commands rule, run by `F checks` in the run's worktree. It passes only on the same commit with
// the same command list and every exit 0 (core's gate.ts localResult, which decide() uses too); never with no commands.
import type { Ctx } from './index.ts';

export const id = 'local';

export function checks({ local }: Ctx, { sha }: { repo: string; sha?: string }) {
  const r = local(sha);
  return { state: r.state, detail: r.text };
}
// F checks' own output on sha, with its tail of each failed command.
export const logTail = ({ local }: Ctx, { sha }: { repo: string; sha: string }) => local(sha).text;
