// CI providers: what says whether a commit's checks passed. One file per provider; see README.md.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDir } from '../registry.ts';
import type { Ctx as HostCtx } from '../hosts/index.ts';
import * as githubActions from './github-actions.ts';
import * as local from './local.ts';
import * as none from './none.ts';

export const STATES = ['pass', 'fail', 'pending', 'none', 'unknown'] as const;
export type CiState = typeof STATES[number];
export interface CiResult { state: CiState; url?: string; failed?: string[]; detail?: string }
/** ctx.local(sha): F's own checks (F checks) on sha, judged against the project's checks.commands rule. */
export type Ctx = HostCtx & { local: (sha?: string) => { state: 'pass' | 'fail' | 'none'; text: string } };
export interface Ci {
  id: string;
  /** changeRequest: the PR (or other change request) whose head is sha; absent for a commit on the base branch. */
  checks(ctx: Ctx, opts: { repo: string; path?: string; sha?: string; changeRequest?: string }): CiResult;
  /** The failed checks' log on sha, for F ci RUN to show (its last lines); '' when there is none. Read only. */
  logTail?(ctx: Ctx, opts: { repo: string; path?: string; sha: string }): string;
}

export const REQUIRED = ['checks'];
export const load = (dir = path.dirname(fileURLToPath(import.meta.url))) => loadDir<Ci>(dir, REQUIRED);
// The providers a project's ci can name, imported by name as the hosts are: a bad file in this folder fails only load(),
// never the gate. A new provider (Jenkins, say) is one file here plus one line in this map; see README.md.
export const builtin: Record<string, Ci> = { 'github-actions': githubActions, local, none };

// The shared contract every provider must pass. ctx: stubbed gh/git and a local(sha) answer; sha: a commit it can be asked about.
export function contract(p: Ci, { ctx, repo, path: at, sha }: { ctx: Ctx; repo: string; path?: string; sha: string }) {
  for (const opts of [{ repo, path: at, sha }, { repo, path: at, sha, changeRequest: '1' }]) {
    const r = p.checks(ctx, opts);
    assert.ok(STATES.includes(r.state), `${p.id}: state is one of ${STATES.join('|')}, got ${r.state}`);
    for (const k of ['url', 'detail'] as const) assert.ok(r[k] === undefined || typeof r[k] === 'string', `${p.id}: ${k} is a string`);
    assert.ok(r.failed === undefined || (Array.isArray(r.failed) && r.failed.every((x) => typeof x === 'string')), `${p.id}: failed is a list of strings`);
    assert.deepEqual(p.checks(ctx, opts), r, `${p.id}: asking twice gives the same answer`);
  }
  if (p.logTail) assert.equal(typeof p.logTail(ctx, { repo, path: at, sha }), 'string', `${p.id}: logTail returns text`);
}
