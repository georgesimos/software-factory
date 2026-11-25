// GitHub Actions (any GitHub check), through the logged-in gh: a PR's checks, or the workflow runs on a base-branch commit.
import type { Ctx } from './index.ts';
import { prNumber } from '../hosts/github.ts';

export const id = 'github-actions';

export function checks({ gh }: Ctx, { repo, sha, changeRequest }: { repo: string; sha?: string; changeRequest?: string }) {
  if (changeRequest) {
    let b: string[];
    try { b = JSON.parse(gh('pr', 'checks', prNumber(repo, changeRequest), '-R', repo, '--json', 'bucket')).map((c: { bucket: string }) => c.bucket); } catch (e) {
      if (/no checks reported/i.test(String((e as { stderr?: unknown }).stderr))) return { state: 'none' as const };
      throw e;
    }
    return { state: !b.length ? 'none' as const : b.some((x) => x === 'fail' || x === 'cancel') ? 'fail' as const : b.includes('pending') ? 'pending' as const : 'pass' as const };
  }
  if (!sha) return { state: 'unknown' as const, detail: 'no commit to read CI for' };
  const runs: { status: string; conclusion: string; url: string }[] = JSON.parse(gh('run', 'list', '-R', repo, '--commit', sha, '--json', 'status,conclusion,name,url'));
  const failed = runs.filter((x) => ['failure', 'cancelled', 'timed_out'].includes(x.conclusion)).map((x) => x.url);
  return { state: !runs.length ? 'none' as const : failed.length ? 'fail' as const : runs.some((x) => x.status !== 'completed') ? 'pending' as const : 'pass' as const, failed };
}
// The first failed workflow run on sha: gh's own failed-steps log.
export function logTail({ gh }: Ctx, { repo, sha }: { repo: string; sha: string }) {
  const runs: { databaseId: number; conclusion: string }[] = JSON.parse(gh('run', 'list', '-R', repo, '--commit', sha, '--json', 'databaseId,conclusion'));
  const bad = runs.find((x) => ['failure', 'cancelled', 'timed_out'].includes(x.conclusion));
  return bad ? gh('run', 'view', String(bad.databaseId), '-R', repo, '--log-failed') : '';
}
